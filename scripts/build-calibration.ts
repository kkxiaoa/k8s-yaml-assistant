// 从人工 judge labels 和最新 faith trace 生成可执行 calibration snapshot。
// 用法: npm run build:calibration

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from '../src/knowledge/corpus';
import type { FaithTrace } from '../src/eval/faith-store';
import type { JudgeCalibrationCase } from '../src/eval/metrics/judge-metrics';
import { RUNS_DIR, runKind, type EvalRun } from '../src/eval/run-store';
import { formatSources } from '../src/retrieval/sources';

interface JudgeCalibrationLabel {
  id: string;
  category:
    | 'faithful'
    | 'correct_refusal'
    | 'unsupported_default'
    | 'example_gray'
    | 'hallucinated'
    | 'policy_distinction'
    | 'policy_conflict';
  human: {
    faithful: boolean;
    policy?: {
      distinguished?: boolean;
      conflictExplained?: boolean;
      misstatedAsOfficial?: boolean;
    };
    note: string;
  };
}

const LABELS_PATH = join(process.cwd(), 'data', 'eval', 'judge-calibration-labels.jsonl');
const CALIBRATION_PATH = join(process.cwd(), 'data', 'eval', 'judge-calibration.jsonl');

function readLabels(): JudgeCalibrationLabel[] {
  const labels = readFileSync(LABELS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeCalibrationLabel);
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.id)) throw new Error(`重复 judge label id: ${label.id}`);
    seen.add(label.id);
    if (typeof label.human.faithful !== 'boolean') {
      throw new Error(`judge label ${label.id} 缺 human.faithful`);
    }
    if (!label.human.note.trim()) {
      throw new Error(`judge label ${label.id} 缺 human.note`);
    }
  }
  return labels;
}

function readExistingCalibration(): Map<string, JudgeCalibrationCase> {
  if (!existsSync(CALIBRATION_PATH)) return new Map();
  const rows = readFileSync(CALIBRATION_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeCalibrationCase);
  return new Map(rows.map((row) => [row.id, row]));
}

function faithRunsNewestFirst(): EvalRun[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(
      (file) =>
        JSON.parse(readFileSync(join(RUNS_DIR, file), 'utf8')) as EvalRun,
    )
    .filter(
      (run) =>
        runKind(run) === 'faith' &&
        run.faithSelection?.scope !== 'smoke' &&
        !!run.artifactPaths?.tracePath,
    );
}

function readTraceFile(path: string): FaithTrace[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FaithTrace);
}

function latestTraceById(
  id: string,
): { trace: FaithTrace; run: EvalRun } | null {
  for (const run of faithRunsNewestFirst()) {
    const found = readTraceFile(run.artifactPaths!.tracePath!).find(
      (t) => t.id === id,
    );
    if (found) return { trace: found, run };
  }
  return null;
}

/** 由 topIds 重建喂给生成的 context 文本(与 faithfulness-eval.ts 同格式)。 */
function rebuildContext(topIds: string[]): string {
  const chunks = topIds
    .map((id) => CORPUS.find((cc) => cc.id === id))
    .filter((x): x is (typeof CORPUS)[number] => x !== undefined);
  return formatSources(chunks).context;
}

function main(): void {
  const runs = faithRunsNewestFirst();
  const labels = readLabels();
  const existingById = readExistingCalibration();
  if (runs.length === 0 && existingById.size === 0) {
    throw new Error('无 faith trace 或现有 judge calibration snapshot');
  }
  let refreshed = 0;
  let preserved = 0;
  const out = labels.map((l) => {
    const found = latestTraceById(l.id);
    if (!found) {
      const existing = existingById.get(l.id);
      if (!existing) throw new Error(`明细缺样本 ${l.id}`);
      preserved++;
      return {
        ...existing,
        id: l.id,
        category: l.category,
        human: l.human,
      };
    }
    const { trace: t, run } = found;
    refreshed++;
    return {
      id: l.id,
      category: l.category,
      question: t.question,
      context: rebuildContext(t.retrieval.topIds),
      answer: t.answer,
      human: l.human,
      sourceFaithRunId: run.id,
    };
  });
  writeFileSync(CALIBRATION_PATH, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.error(`已写 ${out.length} 条 → ${CALIBRATION_PATH}`);
  console.error(`刷新自 faith trace: ${refreshed} 条;沿用现有 snapshot: ${preserved} 条`);
  const f = out.filter((o) => o.human.faithful).length;
  console.error(`人工 label:忠实 ${f} / 不忠 ${out.length - f}`);
  const policyDims = out.reduce(
    (n, o) => n + Object.keys(o.human.policy ?? {}).length,
    0,
  );
  console.error(`policy 人工维度标注: ${policyDims} 个`);
}

main();

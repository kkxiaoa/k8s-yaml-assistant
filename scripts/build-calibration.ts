// 从人工 judge labels 和最新 faith trace 生成可执行 calibration snapshot。
// 用法: npm run build:calibration

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJudgeCalibrationCaseFromFaith } from '../src/eval/calibration-snapshot';
import {
  decodeFaithTrace,
  type FaithTrace,
} from '../src/eval/faith-store';
import type { JudgeCalibrationCase } from '../src/eval/metrics/judge-metrics';
import { listRuns } from '../src/eval/run-store';
import type { EvalRun } from '../src/eval/protocol';
import {
  evalArtifactPath,
  readTraceEnvelopes,
} from '../src/eval/artifacts';

type FaithEvalRun = Extract<EvalRun, { kind: 'faith' }>;

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

function faithRunsNewestFirst(): FaithEvalRun[] {
  return listRuns({ kind: 'faith' })
    .filter(
      (run): run is FaithEvalRun =>
        run.kind === 'faith' &&
        run.status === 'completed' &&
        run.scope !== 'smoke',
    )
    .reverse()
}

function readTraceFile(run: FaithEvalRun): FaithTrace[] {
  return readTraceEnvelopes(evalArtifactPath(run.artifactPaths.trace)).map(
    (envelope) => {
      if (envelope.runId !== run.id || envelope.kind !== 'faith') {
        throw new Error(`faith trace envelope mismatch: ${envelope.traceId}`);
      }
      const trace = decodeFaithTrace(envelope.payload);
      if (trace.id !== envelope.evalCaseId) {
        throw new Error(`faith trace payload mismatch: ${envelope.traceId}`);
      }
      return trace;
    },
  );
}

function latestTraceById(
  id: string,
): { trace: FaithTrace; run: FaithEvalRun } | null {
  for (const run of faithRunsNewestFirst()) {
    const found = readTraceFile(run).find((trace) => trace.id === id);
    if (found) return { trace: found, run };
  }
  return null;
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
    return buildJudgeCalibrationCaseFromFaith({
      label: l,
      trace: t,
      sourceFaithRunId: run.id,
    });
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

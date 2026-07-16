// 从人工 judge labels 和最新 faith trace 生成可执行 calibration snapshot。
// 用法: npm run build:calibration

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildJudgeCalibrationCaseFromFaith,
  type JudgeCalibrationLabel,
} from '../src/eval/calibration-snapshot';
import {
  decodeFaithTrace,
  type FaithTrace,
} from '../src/eval/faith-store';
import { listRuns } from '../src/eval/run-store';
import type { EvalRun } from '../src/eval/protocol';
import {
  evalArtifactPath,
  readTraceEnvelopes,
} from '../src/eval/artifacts';
import { faithTraceDatasetIdentity } from '../src/eval/runner-protocol';
import {
  decodeJudgeCalibrationCases,
  parseJudgeCalibrationLabelsJsonl,
} from '../src/eval/metrics/judge-metrics';

type FaithEvalRun = Extract<EvalRun, { kind: 'faith' }>;

const LABELS_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'judge-calibration-labels.jsonl',
);
const CALIBRATION_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'judge-calibration.jsonl',
);

function readLabels(): JudgeCalibrationLabel[] {
  return parseJudgeCalibrationLabelsJsonl(readFileSync(LABELS_PATH, 'utf8'));
}

function faithRunsNewestFirst(): FaithEvalRun[] {
  return listRuns({ kind: 'faith' })
    .filter(
      (run): run is FaithEvalRun =>
        run.kind === 'faith' &&
        run.status === 'completed' &&
        run.scope !== 'smoke',
    )
    .reverse();
}

interface FaithTraceSnapshot {
  trace: FaithTrace;
  traceId: string;
  run: FaithEvalRun;
}

function equalSorted(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function readTraceFile(run: FaithEvalRun): FaithTraceSnapshot[] {
  const snapshots = readTraceEnvelopes(
    evalArtifactPath(run.artifactPaths.trace),
  ).map(
    (envelope) => {
      if (envelope.runId !== run.id || envelope.kind !== 'faith') {
        throw new Error(`faith trace envelope mismatch: ${envelope.traceId}`);
      }
      const trace = decodeFaithTrace(envelope.payload);
      if (trace.id !== envelope.evalCaseId) {
        throw new Error(`faith trace payload mismatch: ${envelope.traceId}`);
      }
      return { trace, traceId: envelope.traceId, run };
    },
  );
  const traces = snapshots.map(({ trace }) => trace);
  if (!equalSorted(traces.map((trace) => trace.id), run.dataset.caseIds)) {
    throw new Error(`faith run ${run.id} trace cases do not match dataset`);
  }
  const snapshotIdentity = faithTraceDatasetIdentity(traces);
  if (snapshotIdentity.hash !== run.dataset.hash) {
    throw new Error(`faith run ${run.id} dataset hash mismatch`);
  }
  return snapshots;
}

function latestTraceById(
  runs: readonly FaithEvalRun[],
  requiredIds: readonly string[],
): Map<string, FaithTraceSnapshot> {
  const latest = new Map<string, FaithTraceSnapshot>();
  const pending = new Set(requiredIds);
  for (const run of runs) {
    for (const snapshot of readTraceFile(run)) {
      if (pending.has(snapshot.trace.id)) {
        latest.set(snapshot.trace.id, snapshot);
        pending.delete(snapshot.trace.id);
      }
    }
    if (pending.size === 0) break;
  }
  return latest;
}

function main(): void {
  const runs = faithRunsNewestFirst();
  const labels = readLabels();
  if (runs.length === 0) {
    throw new Error('无可用 faith trace snapshot');
  }
  const latestById = latestTraceById(
    runs,
    labels.map((label) => label.id),
  );
  const out = labels.map((label) => {
    const found = latestById.get(label.id);
    if (!found) {
      throw new Error(`明细缺 faith snapshot ${label.id}`);
    }
    const { trace: t, run, traceId } = found;
    return buildJudgeCalibrationCaseFromFaith({
      label,
      trace: t,
      sourceFaithRunId: run.id,
      sourceFaithTraceId: traceId,
    });
  });
  const calibration = decodeJudgeCalibrationCases(out);
  writeFileSync(
    CALIBRATION_PATH,
    `${calibration.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
  console.error(`已写 ${calibration.length} 条 → ${CALIBRATION_PATH}`);
  console.error(`全部刷新自 faith trace snapshot: ${calibration.length} 条`);
  const f = calibration.filter((item) => item.human.faithful).length;
  console.error(`人工 label:忠实 ${f} / 不忠 ${calibration.length - f}`);
  const policyDims = calibration.reduce(
    (n, o) => n + Object.keys(o.human.policy ?? {}).length,
    0,
  );
  console.error(`policy 人工维度标注: ${policyDims} 个`);
}

main();

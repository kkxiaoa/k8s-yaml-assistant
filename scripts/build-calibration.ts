// 从人工标签绑定的已完成非 smoke faith run 生成非 Holdout calibration snapshot。
// 用法: npm run build:calibration

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildJudgeCalibrationCaseFromFaith,
  type JudgeCalibrationLabel,
} from '../src/eval/calibration-snapshot';
import { assertTuningEligibleCase } from '../src/eval/cases/governance';
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

function completedFaithRuns(): FaithEvalRun[] {
  return listRuns({ kind: 'faith' })
    .filter(
      (run): run is FaithEvalRun =>
        run.kind === 'faith' &&
        run.status === 'completed' &&
        run.scope !== 'smoke',
    );
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
      if (!isDeepStrictEqual(trace.governance, envelope.governance)) {
        throw new Error(
          `faith trace governance mismatch: ${envelope.traceId}`,
        );
      }
      return { trace, traceId: envelope.traceId, run };
    },
  );
  const traces = snapshots.map(({ trace }) => trace);
  if (
    !equalSorted(
      traces.map((trace) => trace.id),
      run.dataset.cases.map((evalCase) => evalCase.id),
    )
  ) {
    throw new Error(`faith run ${run.id} trace cases do not match dataset`);
  }
  const snapshotIdentity = faithTraceDatasetIdentity(traces);
  if (
    snapshotIdentity.hash !== run.dataset.hash ||
    !isDeepStrictEqual(snapshotIdentity.cases, run.dataset.cases)
  ) {
    throw new Error(`faith run ${run.id} dataset hash mismatch`);
  }
  return snapshots;
}

function main(): void {
  const runs = completedFaithRuns();
  const labels = readLabels();
  if (runs.length === 0) {
    throw new Error('无可用 faith trace snapshot');
  }
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const snapshotsByRunId = new Map<
    string,
    Map<string, FaithTraceSnapshot>
  >();
  const out = labels.map((label) => {
    const run = runsById.get(label.sourceFaithRunId);
    if (!run) {
      throw new Error(
        `明细缺已完成非 smoke faith run ${label.sourceFaithRunId}`,
      );
    }
    let snapshots = snapshotsByRunId.get(run.id);
    if (!snapshots) {
      snapshots = new Map(
        readTraceFile(run).map((snapshot) => [
          snapshot.trace.id,
          snapshot,
        ]),
      );
      snapshotsByRunId.set(run.id, snapshots);
    }
    const found = snapshots.get(label.id);
    if (!found) {
      throw new Error(
        `明细缺 faith snapshot ${label.sourceFaithRunId}:${label.id}`,
      );
    }
    const { trace: t, traceId } = found;
    assertTuningEligibleCase(t, `calibration label ${label.id}`);
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
  console.error(`全部来自人工标签绑定的 faith snapshot: ${calibration.length} 条`);
  const f = calibration.filter((item) => item.human.faithful).length;
  console.error(`人工 label:忠实 ${f} / 不忠 ${calibration.length - f}`);
  const policyDims = calibration.reduce(
    (n, o) => n + Object.keys(o.human.policy ?? {}).length,
    0,
  );
  console.error(`policy 人工维度标注: ${policyDims} 个`);
}

main();

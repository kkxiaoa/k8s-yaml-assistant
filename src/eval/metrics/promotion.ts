import { existsSync, readFileSync } from 'node:fs';
import {
  baselinePath,
  evalArtifactPath,
  readTraceEnvelopes,
  writeJsonAtomic,
} from '../artifacts';
import {
  decodeEvalBaseline,
  type EvalBaseline,
  type EvalDatasetIdentity,
  type EvalRun,
  type TraceEnvelope,
} from '../protocol';
import { judgeDatasetIdentity } from '../runner-protocol';
import {
  assertMetricRecord,
  metricDefinitionsForKind,
} from './definitions';
import { parseJudgeCalibrationCasesJsonl } from './judge-metrics';

export interface PromoteEvalRunOptions {
  evalRoot?: string;
  promotedAt?: string;
}

function sameDatasetIdentity(
  left: EvalDatasetIdentity,
  right: EvalDatasetIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.hash === right.hash &&
    left.caseCount === right.caseCount &&
    left.caseIds.length === right.caseIds.length &&
    left.caseIds.every((caseId, index) => caseId === right.caseIds[index])
  );
}

function assertPromotableScope(run: EvalRun): void {
  const runId: string = run.id;
  const scope: string = run.scope;
  if (run.kind !== 'judge') {
    if (scope !== 'full') {
      throw new Error(
        `run ${runId} has scope ${scope}; ${run.kind} baseline requires full`,
      );
    }
    return;
  }

  if (scope !== 'calibration') {
    throw new Error(
      `run ${runId} has scope ${scope}; judge baseline requires calibration`,
    );
  }
}

function assertCompleteJudgeDataset(
  run: EvalRun,
  evalRoot: string | undefined,
): void {
  if (run.kind !== 'judge') return;

  const relativePath = 'judge-calibration.jsonl';
  const path = evalArtifactPath(relativePath, evalRoot);
  if (!existsSync(path)) {
    throw new Error(
      `run ${run.id} cannot verify complete calibration: ${relativePath} not found`,
    );
  }

  let completeDataset: EvalDatasetIdentity;
  try {
    completeDataset = judgeDatasetIdentity(
      parseJudgeCalibrationCasesJsonl(readFileSync(path, 'utf8')),
    );
  } catch (error) {
    throw new Error(
      `run ${run.id} cannot verify complete calibration: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!sameDatasetIdentity(run.dataset, completeDataset)) {
    throw new Error(
      `run ${run.id} calibration identity does not match the complete calibration dataset`,
    );
  }
}

function assertPromotableMetrics(run: EvalRun): number {
  try {
    assertMetricRecord({
      evalKind: run.kind,
      metricDefinitionVersion: run.metricDefinitionVersion,
      metrics: run.metrics,
    });
  } catch (error) {
    throw new Error(
      `run ${run.id} metrics cannot be promoted: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const nullRequiredMetrics = metricDefinitionsForKind(run.kind)
    .filter(
      (definition) =>
        definition.stability === 'required' &&
        run.metrics[definition.key]?.value === null,
    )
    .map((definition) => definition.key)
    .sort();
  if (nullRequiredMetrics.length > 0) {
    throw new Error(
      `run ${run.id} required metrics cannot be null: ${nullRequiredMetrics.join(', ')}`,
    );
  }

  const harnessMetricKey = `${run.kind}.harness_error_count`;
  const harnessErrorCount = run.metrics[harnessMetricKey]?.value;
  if (typeof harnessErrorCount !== 'number') {
    throw new Error(
      `run ${run.id} required metric ${harnessMetricKey} must be a number`,
    );
  }
  return harnessErrorCount;
}

function assertTraceCoverage(
  run: EvalRun,
  traces: readonly TraceEnvelope[],
): number {
  if (traces.length !== run.dataset.caseCount) {
    throw new Error(
      `run ${run.id} trace count ${traces.length} does not match dataset case count ${run.dataset.caseCount}`,
    );
  }

  const expectedCaseIds = new Set(run.dataset.caseIds);
  const seenCaseIds = new Set<string>();
  let errorTraceCount = 0;

  for (const trace of traces) {
    if (trace.runId !== run.id || trace.kind !== run.kind) {
      throw new Error(
        `run ${run.id} trace ${trace.traceId} has mismatched run or kind`,
      );
    }
    if (!expectedCaseIds.has(trace.evalCaseId)) {
      throw new Error(
        `run ${run.id} trace ${trace.traceId} has unexpected case ${trace.evalCaseId}`,
      );
    }
    if (seenCaseIds.has(trace.evalCaseId)) {
      throw new Error(
        `run ${run.id} has duplicate trace case ${trace.evalCaseId}`,
      );
    }
    seenCaseIds.add(trace.evalCaseId);

    if (trace.outcome === 'error') {
      if (trace.error === undefined) {
        throw new Error(
          `run ${run.id} trace ${trace.traceId} case error is unexplained`,
        );
      }
      errorTraceCount++;
    }
  }

  const missingCaseIds = run.dataset.caseIds.filter(
    (caseId) => !seenCaseIds.has(caseId),
  );
  if (missingCaseIds.length > 0) {
    throw new Error(
      `run ${run.id} trace coverage is missing ${missingCaseIds.join(', ')}`,
    );
  }
  return errorTraceCount;
}

export function promoteEvalRun(
  run: EvalRun,
  options: PromoteEvalRunOptions = {},
): EvalBaseline {
  if (run.status !== 'completed') {
    throw new Error(
      `only a completed run can be promoted: ${run.id} has status ${run.status}`,
    );
  }
  if (run.dataset.caseCount === 0) {
    throw new Error(`run ${run.id} has an empty dataset`);
  }

  assertPromotableScope(run);
  const harnessErrorCount = assertPromotableMetrics(run);
  assertCompleteJudgeDataset(run, options.evalRoot);

  const tracePath = evalArtifactPath(run.artifactPaths.trace, options.evalRoot);
  if (!existsSync(tracePath)) {
    throw new Error(
      `run ${run.id} trace artifact not found: ${run.artifactPaths.trace}`,
    );
  }
  const errorTraceCount = assertTraceCoverage(
    run,
    readTraceEnvelopes(tracePath),
  );

  if (harnessErrorCount !== errorTraceCount) {
    throw new Error(
      `run ${run.id} harness error metric ${harnessErrorCount} does not match error trace count ${errorTraceCount}`,
    );
  }
  if (harnessErrorCount !== 0) {
    throw new Error(
      `run ${run.id} cannot be promoted: harness error count must be 0, got ${harnessErrorCount}`,
    );
  }

  const baseline = decodeEvalBaseline({
    schemaVersion: run.schemaVersion,
    sourceRunId: run.id,
    promotedAt: options.promotedAt ?? new Date().toISOString(),
    kind: run.kind,
    scope: run.scope,
    dataset: run.dataset,
    metricDefinitionVersion: run.metricDefinitionVersion,
    config: run.config,
    metrics: run.metrics,
  });
  writeJsonAtomic(baselinePath(run.kind, options.evalRoot), baseline);
  return baseline;
}

import { existsSync, readdirSync } from 'node:fs';
import { readJsonFile } from '../shared/json';
import {
  baselinePath,
  evalArtifactPath,
  readTraceEnvelopes,
  runPath,
  writeJsonAtomic,
} from './artifacts';
import {
  decodeEvalBaseline,
  decodeEvalRun,
  type EvalBaseline,
  type EvalKind,
  type EvalRun,
  type MetricObservation,
} from './protocol';

export interface EvalRepositoryOptions {
  evalRoot?: string;
}

export interface ListRunsOptions extends EvalRepositoryOptions {
  kind?: EvalKind;
}

export function readRun(
  runId: string,
  options: EvalRepositoryOptions = {},
): EvalRun {
  const path = runPath(runId, options.evalRoot);
  let run: EvalRun;
  try {
    run = decodeEvalRun(readJsonFile(path, 'eval run'));
  } catch (error) {
    throw new Error(
      `invalid eval run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (run.id !== runId) {
    throw new Error(
      `run id mismatch: requested ${runId}, artifact contains ${run.id}`,
    );
  }
  return run;
}

export function listRuns(options: ListRunsOptions = {}): EvalRun[] {
  const runsDirectory = evalArtifactPath('runs', options.evalRoot);
  if (!existsSync(runsDirectory)) return [];

  return readdirSync(runsDirectory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readRun(file.slice(0, -'.json'.length), options))
    .filter((run) => options.kind === undefined || run.kind === options.kind)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export function latestRun(options: ListRunsOptions = {}): EvalRun | null {
  return listRuns(options).at(-1) ?? null;
}

export function readBaseline(
  kind: EvalKind,
  options: EvalRepositoryOptions = {},
): EvalBaseline | null {
  const path = baselinePath(kind, options.evalRoot);
  if (!existsSync(path)) return null;
  try {
    const baseline = decodeEvalBaseline(readJsonFile(path, 'eval baseline'));
    if (baseline.kind !== kind) {
      throw new Error(
        `baseline kind mismatch: requested ${kind}, artifact contains ${baseline.kind}`,
      );
    }
    return baseline;
  } catch (error) {
    throw new Error(
      `invalid eval baseline ${kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PromoteRunOptions extends EvalRepositoryOptions {
  promotedAt?: string;
}

function promotableScope(run: EvalRun): 'full' | 'calibration' {
  return run.kind === 'judge' ? 'calibration' : 'full';
}

export function promoteRun(
  runId: string,
  options: PromoteRunOptions = {},
): EvalBaseline {
  const run = readRun(runId, options);
  if (run.status !== 'completed') {
    throw new Error(
      `only a completed run can be promoted: ${run.id} has status ${run.status}`,
    );
  }

  const requiredScope = promotableScope(run);
  if (run.scope !== requiredScope) {
    throw new Error(
      `run ${run.id} has scope ${run.scope}; ${run.kind} baseline requires ${requiredScope}`,
    );
  }
  if (run.metricDefinitionVersion === 'legacy-v1') {
    throw new Error(
      `run ${run.id} uses legacy-v1 and cannot be promoted`,
    );
  }
  if (run.dataset.caseCount === 0) {
    throw new Error(`run ${run.id} has an empty dataset`);
  }
  if (Object.keys(run.metrics).length === 0) {
    throw new Error(`run ${run.id} has no metric observations`);
  }

  const tracePath = evalArtifactPath(run.artifactPaths.trace, options.evalRoot);
  if (!existsSync(tracePath)) {
    throw new Error(
      `run ${run.id} trace artifact not found: ${run.artifactPaths.trace}`,
    );
  }
  const envelopes = readTraceEnvelopes(tracePath);
  const seenCaseIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.runId !== run.id || envelope.kind !== run.kind) {
      throw new Error(
        `run ${run.id} trace ${envelope.traceId} has mismatched run or kind`,
      );
    }
    if (!run.dataset.caseIds.includes(envelope.evalCaseId)) {
      throw new Error(
        `run ${run.id} trace ${envelope.traceId} has unexpected case ${envelope.evalCaseId}`,
      );
    }
    if (seenCaseIds.has(envelope.evalCaseId)) {
      throw new Error(
        `run ${run.id} has duplicate trace case ${envelope.evalCaseId}`,
      );
    }
    seenCaseIds.add(envelope.evalCaseId);
  }
  const missingCaseIds = run.dataset.caseIds.filter(
    (evalCaseId) => !seenCaseIds.has(evalCaseId),
  );
  if (missingCaseIds.length > 0) {
    throw new Error(
      `run ${run.id} trace coverage is missing ${missingCaseIds.join(', ')}`,
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

export interface CompareRow {
  key: string;
  current: number;
  baseline: number;
  delta: number;
}

export function compareMetrics(
  current: Record<string, MetricObservation>,
  baseline: Record<string, MetricObservation>,
): CompareRow[] {
  return Object.keys(current)
    .filter(
      (key) =>
        key in baseline &&
        current[key]?.value !== null &&
        baseline[key]?.value !== null,
    )
    .sort()
    .map((key) => {
      const currentValue = current[key]!.value!;
      const baselineValue = baseline[key]!.value!;
      return {
        key,
        current: currentValue,
        baseline: baselineValue,
        delta: currentValue - baselineValue,
      };
    });
}

import { existsSync, readdirSync } from 'node:fs';
import { readJsonFile } from '../shared/json';
import {
  baselinePath,
  evalArtifactPath,
  runPath,
} from './artifacts';
import {
  decodeEvalBaseline,
  decodeEvalRun,
  type EvalBaseline,
  type EvalKind,
  type EvalRun,
} from './protocol';
import { promoteEvalRun } from './metrics/promotion';

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

export function promoteRun(
  runId: string,
  options: PromoteRunOptions = {},
): EvalBaseline {
  return promoteEvalRun(readRun(runId, options), options);
}

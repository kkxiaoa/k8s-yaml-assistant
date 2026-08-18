import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { readJsonFile } from '../shared/json';
import {
  baselinePath,
  evalArtifactPath,
  runPath,
} from './artifacts';
import {
  decodeEvalBaseline,
  decodeEvalRun,
  EvalKindSchema,
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
  metricDefinitionVersion?: string;
}

// Selection consumes only these producer fields; matching artifacts cross the full strict boundary below.
const EvalRunReferenceSchema = z.object({
  kind: EvalKindSchema,
  metricDefinitionVersion: z.string().min(1),
});

type EvalRunReference = z.infer<typeof EvalRunReferenceSchema>;

function invalidRun(runId: string, error: unknown): Error {
  return new Error(
    `invalid eval run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function decodeRunValue(runId: string, value: unknown): EvalRun {
  let run: EvalRun;
  try {
    run = decodeEvalRun(value);
  } catch (error) {
    throw invalidRun(runId, error);
  }
  if (run.id !== runId) {
    throw new Error(
      `run id mismatch: requested ${runId}, artifact contains ${run.id}`,
    );
  }
  return run;
}

function decodeRunReference(
  runId: string,
  value: unknown,
): EvalRunReference {
  let reference: EvalRunReference;
  try {
    reference = EvalRunReferenceSchema.parse(value);
  } catch (error) {
    throw invalidRun(runId, error);
  }
  return reference;
}

function readRunValue(
  runId: string,
  options: EvalRepositoryOptions,
): unknown {
  try {
    return readJsonFile(runPath(runId, options.evalRoot), 'eval run');
  } catch (error) {
    throw invalidRun(runId, error);
  }
}

export function readRun(
  runId: string,
  options: EvalRepositoryOptions = {},
): EvalRun {
  return decodeRunValue(runId, readRunValue(runId, options));
}

export function listRuns(options: ListRunsOptions = {}): EvalRun[] {
  const runsDirectory = evalArtifactPath('runs', options.evalRoot);
  if (!existsSync(runsDirectory)) return [];

  const hasReferenceFilter =
    options.kind !== undefined ||
    options.metricDefinitionVersion !== undefined;

  return readdirSync(runsDirectory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const runId = file.slice(0, -'.json'.length);
      const value = readRunValue(runId, options);
      const reference = hasReferenceFilter
        ? decodeRunReference(runId, value)
        : null;
      return { runId, value, reference };
    })
    .filter(
      ({ reference }) =>
        reference === null ||
        ((options.kind === undefined || reference.kind === options.kind) &&
          (options.metricDefinitionVersion === undefined ||
            reference.metricDefinitionVersion ===
              options.metricDefinitionVersion)),
    )
    .map(({ runId, value }) => decodeRunValue(runId, value))
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

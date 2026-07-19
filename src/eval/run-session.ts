import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  appendTraceEnvelope,
  evalArtifactPath,
  readTraceEnvelopes,
  runPath,
  traceRelativePath,
  writeJsonAtomic,
} from './artifacts';
import {
  EVAL_SCHEMA_VERSION,
  decodeEvalRun,
  decodeTraceEnvelope,
  type EvalKind,
  type EvalCaseErrorStage,
  type EvalErrorStage,
  type EvalRunFatalStage,
  type EvalRun,
  type JsonValue,
  type MetricObservation,
  type TraceEnvelope,
} from './protocol';
import { assertMetricRecord } from './metrics/definitions';

const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const SENSITIVE_ASSIGNMENT =
  /\b(api[-_ ]?key|authorization|password|secret|token)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;

type ManagedRunField =
  | 'schemaVersion'
  | 'status'
  | 'createdAt'
  | 'completedAt'
  | 'artifactPaths'
  | 'metrics'
  | 'failure';

type DefinitionFromRun<TRun extends EvalRun> = TRun extends EvalRun
  ? Omit<TRun, ManagedRunField>
  : never;

export type EvalRunDefinition = DefinitionFromRun<EvalRun>;

export type TraceEnvelopeDefinition<
  TKind extends EvalKind = EvalKind,
  TPayload = JsonValue,
> = Omit<
  TraceEnvelope<TKind, TPayload>,
  'schemaVersion' | 'traceId' | 'createdAt'
>;

export type ErrorTraceEnvelopeDefinition<
  TKind extends EvalKind = EvalKind,
  TPayload = JsonValue,
> = Omit<TraceEnvelopeDefinition<TKind, TPayload>, 'outcome' | 'error'> & {
  stage: EvalCaseErrorStage;
  error: unknown;
};

export interface EvalRunSession {
  readonly id: string;
  readonly kind: EvalKind;
  appendCase<TKind extends EvalKind, TPayload>(
    envelope: TraceEnvelope<TKind, TPayload>,
  ): void;
  complete(metrics: Record<string, MetricObservation>): void;
  fail(stage: EvalErrorStage, error: unknown): void;
}

export interface StartEvalRunOptions {
  evalRoot?: string;
}

function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  const normalized = raw.replace(/\s+/g, ' ').trim() || 'Unknown error';
  const redacted = normalized
    .replace(
      SENSITIVE_ASSIGNMENT,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    )
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]');

  return redacted.length <= MAX_ERROR_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}

export function evalErrorDetails<TStage extends EvalErrorStage>(
  stage: TStage,
  error: unknown,
): { stage: TStage; message: string } {
  return { stage, message: errorMessage(error) };
}

export function createTraceEnvelope<TKind extends EvalKind, TPayload>(
  definition: TraceEnvelopeDefinition<TKind, TPayload>,
): TraceEnvelope<TKind, TPayload>;
export function createTraceEnvelope(definition: object): TraceEnvelope {
  return decodeTraceEnvelope({
    ...definition,
    schemaVersion: EVAL_SCHEMA_VERSION,
    traceId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

export function createErrorTraceEnvelope<TKind extends EvalKind, TPayload>(
  definition: ErrorTraceEnvelopeDefinition<TKind, TPayload>,
): TraceEnvelope<TKind, TPayload> {
  const { stage, error, ...traceDefinition } = definition;
  return createTraceEnvelope({
    ...traceDefinition,
    outcome: 'error',
    error: evalErrorDetails(stage, error),
  });
}

export class EvalCaseExecutionError<TPayload = unknown> extends Error {
  readonly stage: EvalCaseErrorStage;
  readonly originalError: unknown;
  readonly payload: TPayload | undefined;

  constructor(stage: EvalCaseErrorStage, error: unknown, payload?: TPayload) {
    super(
      error instanceof Error ? error.message : `eval case failed at ${stage}`,
      {
        cause: error,
      },
    );
    this.name = 'EvalCaseExecutionError';
    this.stage = stage;
    this.originalError = error;
    this.payload = payload;
  }
}

export class EvalRunExecutionError extends Error {
  readonly stage: EvalRunFatalStage;
  readonly originalError: unknown;

  constructor(stage: EvalRunFatalStage, error: unknown) {
    super(
      error instanceof Error ? error.message : `eval run failed at ${stage}`,
      {
        cause: error,
      },
    );
    this.name = 'EvalRunExecutionError';
    this.stage = stage;
    this.originalError = error;
  }
}

export interface EvalHarnessError {
  evalCaseId: string;
  stage: EvalCaseErrorStage;
}

export interface EvalCaseBatchResult<TResult> {
  results: TResult[];
  harnessErrors: EvalHarnessError[];
}

export async function executeEvalRunStage<T>(
  stage: EvalRunFatalStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EvalRunExecutionError) throw error;
    throw new EvalRunExecutionError(stage, error);
  }
}

export async function executeEvalCaseStage<T, TPayload = unknown>(
  stage: EvalCaseErrorStage,
  operation: () => T | Promise<T>,
  payload?: TPayload,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof EvalCaseExecutionError ||
      error instanceof EvalRunExecutionError
    ) {
      throw error;
    }
    throw new EvalCaseExecutionError(stage, error, payload);
  }
}

export async function executeEvalCases<
  TCase extends { id: string },
  TResult,
>(params: {
  cases: readonly TCase[];
  evaluate: (evalCase: TCase) => Promise<TResult>;
  appendSuccess: (evalCase: TCase, result: TResult) => void;
  appendError: (evalCase: TCase, failure: EvalCaseExecutionError) => void;
}): Promise<EvalCaseBatchResult<TResult>> {
  const results: TResult[] = [];
  const harnessErrors: EvalHarnessError[] = [];

  for (const evalCase of params.cases) {
    let result: TResult;
    try {
      result = await params.evaluate(evalCase);
    } catch (error) {
      if (error instanceof EvalRunExecutionError) throw error;
      if (!(error instanceof EvalCaseExecutionError)) {
        throw new EvalRunExecutionError('case_execution', error);
      }
      try {
        params.appendError(evalCase, error);
      } catch (artifactError) {
        throw new EvalRunExecutionError('artifact_write', artifactError);
      }
      harnessErrors.push({ evalCaseId: evalCase.id, stage: error.stage });
      continue;
    }

    try {
      params.appendSuccess(evalCase, result);
    } catch (error) {
      throw new EvalRunExecutionError('artifact_write', error);
    }
    results.push(result);
  }

  return { results, harnessErrors };
}

export function failEvalRunSession(
  session: EvalRunSession,
  error: unknown,
): void {
  if (error instanceof EvalRunExecutionError) {
    session.fail(error.stage, error.originalError);
    return;
  }
  if (error instanceof EvalCaseExecutionError) {
    session.fail(error.stage, error.originalError);
    return;
  }
  session.fail('case_execution', error);
}

function traceCoverageError(detail: string): Error {
  return new Error(`trace coverage mismatch: ${detail}`);
}

export function startEvalRun(
  definition: EvalRunDefinition,
  options: StartEvalRunOptions = {},
): EvalRunSession {
  const traceArtifactPath = traceRelativePath(definition.id, definition.kind);
  const runFilePath = runPath(definition.id, options.evalRoot);
  const traceFilePath = evalArtifactPath(traceArtifactPath, options.evalRoot);
  if (existsSync(runFilePath)) {
    throw new Error(`eval run already exists: ${definition.id}`);
  }
  if (existsSync(traceFilePath)) {
    throw new Error(`eval trace already exists: ${traceArtifactPath}`);
  }

  let currentRun = decodeEvalRun({
    ...definition,
    schemaVersion: EVAL_SCHEMA_VERSION,
    status: 'running',
    createdAt: new Date().toISOString(),
    artifactPaths: { trace: traceArtifactPath },
    metrics: {},
  });
  writeJsonAtomic(runFilePath, currentRun);

  const expectedCases = new Map(
    currentRun.dataset.cases.map((evalCase) => [
      evalCase.id,
      evalCase.governance,
    ]),
  );
  const appendedCaseIds = new Set<string>();
  const appendedTraceIds = new Set<string>();

  function ensureRunning(action: string): void {
    if (currentRun.status !== 'running') {
      throw new Error(
        `cannot ${action} after run ${currentRun.id} is ${currentRun.status}`,
      );
    }
  }

  function appendCase(envelopeValue: TraceEnvelope<EvalKind, unknown>): void {
    ensureRunning('append case');
    const envelope = decodeTraceEnvelope(envelopeValue);
    if (envelope.runId !== currentRun.id) {
      throw new Error(
        `trace runId ${envelope.runId} does not match session ${currentRun.id}`,
      );
    }
    if (envelope.kind !== currentRun.kind) {
      throw new Error(
        `trace kind ${envelope.kind} does not match session ${currentRun.kind}`,
      );
    }
    const expectedGovernance = expectedCases.get(envelope.evalCaseId);
    if (expectedGovernance === undefined) {
      throw new Error(
        `evalCaseId ${envelope.evalCaseId} is not in dataset ${currentRun.dataset.id}`,
      );
    }
    if (!isDeepStrictEqual(envelope.governance, expectedGovernance)) {
      throw new Error(
        `trace governance for ${envelope.evalCaseId} does not match dataset`,
      );
    }
    if (appendedCaseIds.has(envelope.evalCaseId)) {
      throw new Error(
        `evalCaseId ${envelope.evalCaseId} already has a final trace`,
      );
    }
    if (appendedTraceIds.has(envelope.traceId)) {
      throw new Error(`traceId ${envelope.traceId} already exists`);
    }

    appendTraceEnvelope(traceFilePath, envelope);
    appendedCaseIds.add(envelope.evalCaseId);
    appendedTraceIds.add(envelope.traceId);
  }

  function assertCompleteTraceCoverage(): void {
    const envelopes = existsSync(traceFilePath)
      ? readTraceEnvelopes(traceFilePath)
      : [];
    const actualCaseIds = new Set<string>();

    for (const envelope of envelopes) {
      if (envelope.runId !== currentRun.id) {
        throw traceCoverageError(
          `traceId ${envelope.traceId} has runId ${envelope.runId}`,
        );
      }
      if (envelope.kind !== currentRun.kind) {
        throw traceCoverageError(
          `traceId ${envelope.traceId} has kind ${envelope.kind}`,
        );
      }
      const expectedGovernance = expectedCases.get(envelope.evalCaseId);
      if (expectedGovernance === undefined) {
        throw traceCoverageError(`unexpected ${envelope.evalCaseId}`);
      }
      if (!isDeepStrictEqual(envelope.governance, expectedGovernance)) {
        throw traceCoverageError(
          `governance mismatch for ${envelope.evalCaseId}`,
        );
      }
      if (actualCaseIds.has(envelope.evalCaseId)) {
        throw traceCoverageError(`duplicate ${envelope.evalCaseId}`);
      }
      actualCaseIds.add(envelope.evalCaseId);
    }

    const missing = currentRun.dataset.cases.flatMap((evalCase) =>
      actualCaseIds.has(evalCase.id) ? [] : [evalCase.id],
    );
    if (missing.length > 0) {
      throw traceCoverageError(`missing ${missing.join(', ')}`);
    }
  }

  function complete(metrics: Record<string, MetricObservation>): void {
    ensureRunning('complete');
    assertCompleteTraceCoverage();
    try {
      assertMetricRecord({
        evalKind: currentRun.kind,
        metricDefinitionVersion: currentRun.metricDefinitionVersion,
        metrics,
      });
    } catch (error) {
      throw new EvalRunExecutionError('metric_aggregation', error);
    }
    const completedRun = decodeEvalRun({
      ...currentRun,
      status: 'completed',
      completedAt: new Date().toISOString(),
      metrics,
    });
    writeJsonAtomic(runFilePath, completedRun);
    currentRun = completedRun;
  }

  function fail(stage: EvalErrorStage, error: unknown): void {
    ensureRunning('fail');
    const failedRun = decodeEvalRun({
      ...currentRun,
      status: 'failed',
      completedAt: new Date().toISOString(),
      failure: evalErrorDetails(stage, error),
    });
    writeJsonAtomic(runFilePath, failedRun);
    currentRun = failedRun;
  }

  return {
    id: currentRun.id,
    kind: currentRun.kind,
    appendCase,
    complete,
    fail,
  };
}

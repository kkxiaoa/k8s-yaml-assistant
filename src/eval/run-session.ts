import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  type EvalRun,
  type JsonValue,
  type MetricObservation,
  type TraceEnvelope,
} from './protocol';

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
  stage: string;
  error: unknown;
};

export interface EvalRunSession {
  readonly id: string;
  readonly kind: EvalKind;
  appendCase<TKind extends EvalKind, TPayload>(
    envelope: TraceEnvelope<TKind, TPayload>,
  ): void;
  complete(metrics: Record<string, MetricObservation>): void;
  fail(stage: string, error: unknown): void;
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

export function evalErrorDetails(
  stage: string,
  error: unknown,
): { stage: string; message: string } {
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

  const expectedCaseIds = new Set(currentRun.dataset.caseIds);
  const appendedCaseIds = new Set<string>();
  const appendedTraceIds = new Set<string>();

  function ensureRunning(action: string): void {
    if (currentRun.status !== 'running') {
      throw new Error(
        `cannot ${action} after run ${currentRun.id} is ${currentRun.status}`,
      );
    }
  }

  function appendCase(
    envelopeValue: TraceEnvelope<EvalKind, unknown>,
  ): void {
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
    if (!expectedCaseIds.has(envelope.evalCaseId)) {
      throw new Error(
        `evalCaseId ${envelope.evalCaseId} is not in dataset ${currentRun.dataset.id}`,
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
      if (!expectedCaseIds.has(envelope.evalCaseId)) {
        throw traceCoverageError(`unexpected ${envelope.evalCaseId}`);
      }
      if (actualCaseIds.has(envelope.evalCaseId)) {
        throw traceCoverageError(`duplicate ${envelope.evalCaseId}`);
      }
      actualCaseIds.add(envelope.evalCaseId);
    }

    const missing = currentRun.dataset.caseIds.filter(
      (evalCaseId) => !actualCaseIds.has(evalCaseId),
    );
    if (missing.length > 0) {
      throw traceCoverageError(`missing ${missing.join(', ')}`);
    }
  }

  function complete(metrics: Record<string, MetricObservation>): void {
    ensureRunning('complete');
    assertCompleteTraceCoverage();
    const completedRun = decodeEvalRun({
      ...currentRun,
      status: 'completed',
      completedAt: new Date().toISOString(),
      metrics,
    });
    writeJsonAtomic(runFilePath, completedRun);
    currentRun = completedRun;
  }

  function fail(stage: string, error: unknown): void {
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

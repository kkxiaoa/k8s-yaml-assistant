import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  evalArtifactPath,
  readTraceEnvelopes,
} from './artifacts';
import { FaithOutcomeSchema } from './faith-store';
import type { EvalSuite } from './cases/governance';
import type { EvalRun, TraceEnvelope } from './protocol';
import { readRun } from './run-store';

const NonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value), {
    message: 'must contain a non-whitespace character',
  });
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const TaskTypeSchema = z.enum([
  'explain_field',
  'explain_error',
  'ask_free',
  'generate',
  'fix',
  'refusal',
]);

export const BadCaseFailureLayerSchema = z.enum([
  'retrieval',
  'rerank',
  'chunking',
  'knowledge',
  'context',
  'prompt',
  'generation',
  'validation',
  'judge',
  'ui',
  'unknown',
]);

export const BadCaseFailureTypeSchema = z.enum([
  'retrieval_miss',
  'rerank_miss',
  'rerank_error',
  'chunk_gap',
  'knowledge_missing',
  'context_missing',
  'prompt_error',
  'hallucination',
  'schema_gap',
  'parse_error',
  'validation_error',
  'consistency_error',
  'refusal_error',
  'judge_error',
  'ui_misleading',
  'unknown',
]);

type BadCaseFailureLayer = z.infer<typeof BadCaseFailureLayerSchema>;
type BadCaseFailureType = z.infer<typeof BadCaseFailureTypeSchema>;

const FAILURE_TYPES_BY_LAYER: Record<
  BadCaseFailureLayer,
  readonly BadCaseFailureType[]
> = {
  retrieval: ['retrieval_miss'],
  rerank: ['rerank_miss', 'rerank_error'],
  chunking: ['chunk_gap'],
  knowledge: ['knowledge_missing'],
  context: ['context_missing'],
  prompt: ['prompt_error'],
  generation: ['hallucination', 'refusal_error'],
  validation: [
    'schema_gap',
    'parse_error',
    'validation_error',
    'consistency_error',
  ],
  judge: ['judge_error'],
  ui: ['ui_misleading'],
  unknown: ['unknown'],
};

const ModelsSchema = z.strictObject({
  embedding: NonEmptyStringSchema.optional(),
  rerank: NonEmptyStringSchema.optional(),
  answer: NonEmptyStringSchema.optional(),
  judge: NonEmptyStringSchema.optional(),
});

const BadCaseEvalScopeSchema = z.enum([
  'tuning',
  'holdout',
  'full',
  'policy',
  'smoke',
]);

export const BadCaseTrackingSchema = z
  .strictObject({
    evalCaseId: NonEmptyStringSchema,
    source: z.enum(['retrieval_eval', 'faith_eval']),
    firstSeenAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    firstSeenRunId: NonEmptyStringSchema.optional(),
    lastSeenRunId: NonEmptyStringSchema.optional(),
    observedRunIds: z.array(NonEmptyStringSchema),
    occurrenceCount: z.int().positive(),
    scope: BadCaseEvalScopeSchema.optional(),
    models: ModelsSchema.optional(),
  })
  .superRefine((tracking, context) => {
    if (tracking.firstSeenAt > tracking.lastSeenAt) {
      context.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'lastSeenAt cannot precede firstSeenAt',
      });
    }
    if (new Set(tracking.observedRunIds).size !== tracking.observedRunIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['observedRunIds'],
        message: 'observedRunIds must be unique',
      });
    }
    if (tracking.occurrenceCount < Math.max(1, tracking.observedRunIds.length)) {
      context.addIssue({
        code: 'custom',
        path: ['occurrenceCount'],
        message: 'occurrenceCount cannot be smaller than observed run count',
      });
    }
    if (
      tracking.firstSeenRunId !== undefined &&
      !tracking.observedRunIds.includes(tracking.firstSeenRunId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['firstSeenRunId'],
        message: 'firstSeenRunId must appear in observedRunIds',
      });
    }
    if (
      tracking.lastSeenRunId !== undefined &&
      !tracking.observedRunIds.includes(tracking.lastSeenRunId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastSeenRunId'],
        message: 'lastSeenRunId must appear in observedRunIds',
      });
    }
  });

export type BadCaseTracking = z.infer<typeof BadCaseTrackingSchema>;

export const BadCaseEvidenceReferenceSchema = z.strictObject({
  runId: NonEmptyStringSchema,
  traceId: NonEmptyStringSchema,
});

export type BadCaseEvidenceReference = z.infer<
  typeof BadCaseEvidenceReferenceSchema
>;

const InputSchema = z.strictObject({
  question: z.string().optional(),
  requirement: z.string().optional(),
  yaml: z.string().optional(),
  context: z
    .strictObject({
      kind: z.string().optional(),
      apiVersion: z.string().optional(),
      cursorPath: z.string().optional(),
      selectedText: z.string().optional(),
      validationErrors: z
        .array(
          z.strictObject({
            path: z.string(),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const ConsistencyCheckSchema = z.enum([
  'selector_label_match',
  'service_target_port_match',
  'ingress_service_match',
]);

const ExpectedSchema = z.strictObject({
  sourceIds: z.array(z.string()).optional(),
  expectedKinds: z.array(z.string()).optional(),
  mustHavePaths: z.array(z.string()).optional(),
  consistencyChecks: z.array(ConsistencyCheckSchema).optional(),
});

const ActualSchema = z.strictObject({
  answer: z.string().optional(),
  yaml: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  evaluation: z
    .strictObject({
      runId: NonEmptyStringSchema,
      scope: BadCaseEvalScopeSchema,
      outcome: FaithOutcomeSchema,
      unsupportedClaims: z.array(z.string()),
      judgeReason: z.string().optional(),
    })
    .optional(),
});

const FailureSchema = z
  .strictObject({
    layer: BadCaseFailureLayerSchema,
    type: BadCaseFailureTypeSchema,
    note: z.string().optional(),
  })
  .superRefine((failure, context) => {
    if (!FAILURE_TYPES_BY_LAYER[failure.layer].includes(failure.type)) {
      context.addIssue({
        code: 'custom',
        message: `invalid failure combination: ${failure.layer}/${failure.type}`,
      });
    }
  });

export const BadCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{12}$/),
    createdAt: IsoDateTimeSchema,
    taskType: TaskTypeSchema,
    input: InputSchema,
    expected: ExpectedSchema.optional(),
    actual: ActualSchema,
    failure: FailureSchema,
    severity: z.enum(['low', 'medium', 'high']),
    status: z.enum(['new', 'triaged', 'converted_to_eval', 'fixed', 'wont_fix']),
    tracking: BadCaseTrackingSchema,
    relatedBadCaseIds: z
      .array(z.string().regex(/^[a-f0-9]{12}$/))
      .optional(),
    latestEvidence: BadCaseEvidenceReferenceSchema.optional(),
  })
  .superRefine((badCase, context) => {
    const expectedId = canonicalBadCaseId({
      evalCaseId: badCase.tracking.evalCaseId,
      layer: badCase.failure.layer,
      type: badCase.failure.type,
    });
    if (badCase.id !== expectedId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: `id mismatch, expected canonical id ${expectedId}`,
      });
    }

    const related = badCase.relatedBadCaseIds ?? [];
    if (new Set(related).size !== related.length) {
      context.addIssue({
        code: 'custom',
        path: ['relatedBadCaseIds'],
        message: 'relatedBadCaseIds must be unique',
      });
    }
    if (related.includes(badCase.id)) {
      context.addIssue({
        code: 'custom',
        path: ['relatedBadCaseIds'],
        message: 'bad case cannot relate to itself',
      });
    }

    const evaluationRunId = badCase.actual.evaluation?.runId;
    if (
      evaluationRunId !== undefined &&
      !badCase.tracking.observedRunIds.includes(evaluationRunId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['actual', 'evaluation', 'runId'],
        message: 'evaluation runId must appear in observedRunIds',
      });
    }

    const evidence = badCase.latestEvidence;
    if (evidence === undefined) return;
    if (!badCase.tracking.observedRunIds.includes(evidence.runId)) {
      context.addIssue({
        code: 'custom',
        path: ['latestEvidence', 'runId'],
        message: 'latest evidence runId must appear in observedRunIds',
      });
    }
    if (
      badCase.tracking.lastSeenRunId !== undefined &&
      badCase.tracking.lastSeenRunId !== evidence.runId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['latestEvidence', 'runId'],
        message: 'latest evidence runId must equal lastSeenRunId',
      });
    }
    if (evaluationRunId !== undefined && evaluationRunId !== evidence.runId) {
      context.addIssue({
        code: 'custom',
        path: ['latestEvidence', 'runId'],
        message: 'latest evidence runId must equal evaluation runId',
      });
    }
  });

export type BadCase = z.infer<typeof BadCaseSchema>;

export const BAD_CASES_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'bad-cases.jsonl',
);

export interface BadCaseRepositoryOptions {
  path?: string;
}

export interface BadCaseEvidenceOptions {
  evalRoot?: string;
}

export interface BadCaseUpsertOptions
  extends BadCaseRepositoryOptions,
    BadCaseEvidenceOptions {}

export function canonicalBadCaseId(params: {
  evalCaseId: string;
  layer: BadCaseFailureLayer;
  type: BadCaseFailureType;
}): string {
  const { evalCaseId, layer, type } = params;
  if (!evalCaseId) throw new Error('canonicalBadCaseId requires evalCaseId');
  return createHash('sha1')
    .update(`${evalCaseId}\n${layer}\n${type}`)
    .digest('hex')
    .slice(0, 12);
}

export function decodeBadCase(value: unknown): BadCase {
  return BadCaseSchema.parse(value);
}

function hasHumanState(badCase: BadCase): boolean {
  return badCase.status !== 'new';
}

function earlierIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function laterIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function mergeTracking(
  primary: BadCaseTracking,
  secondary: BadCaseTracking,
): BadCaseTracking {
  const primaryRunIds = new Set(primary.observedRunIds);
  const newRunIds = secondary.observedRunIds.filter(
    (runId) => !primaryRunIds.has(runId),
  );
  const observedRunIds = Array.from(
    new Set([...primary.observedRunIds, ...secondary.observedRunIds]),
  );
  const occurrenceCount = Math.max(
    primary.occurrenceCount + newRunIds.length,
    observedRunIds.length,
  );
  const firstSeenRunId =
    primary.firstSeenAt <= secondary.firstSeenAt
      ? primary.firstSeenRunId
      : secondary.firstSeenRunId;
  const lastSeenRunId =
    secondary.lastSeenAt >= primary.lastSeenAt
      ? (secondary.lastSeenRunId ?? primary.lastSeenRunId)
      : (primary.lastSeenRunId ?? secondary.lastSeenRunId);
  return BadCaseTrackingSchema.parse({
    ...primary,
    firstSeenAt: earlierIso(primary.firstSeenAt, secondary.firstSeenAt),
    lastSeenAt: laterIso(primary.lastSeenAt, secondary.lastSeenAt),
    firstSeenRunId,
    lastSeenRunId,
    observedRunIds,
    occurrenceCount,
    scope: primary.scope ?? secondary.scope,
    models: {
      ...secondary.models,
      ...primary.models,
    },
  });
}

export function mergeCanonicalObservations(
  leftValue: BadCase,
  rightValue: BadCase,
): BadCase {
  const left = decodeBadCase(leftValue);
  const right = decodeBadCase(rightValue);
  if (left.id !== right.id) {
    throw new Error(`cannot merge different bad cases: ${left.id} !== ${right.id}`);
  }
  const primary = hasHumanState(left) || !hasHumanState(right) ? left : right;
  const secondary = primary === left ? right : left;
  const latest =
    left.tracking.lastSeenAt > right.tracking.lastSeenAt ? left : right;
  const { latestEvidence: _oldEvidence, ...primaryWithoutEvidence } = primary;
  const relatedBadCaseIds =
    primary.relatedBadCaseIds || secondary.relatedBadCaseIds
      ? Array.from(
          new Set([
            ...(primary.relatedBadCaseIds ?? []),
            ...(secondary.relatedBadCaseIds ?? []),
          ]),
        )
      : undefined;

  return decodeBadCase({
    ...primaryWithoutEvidence,
    createdAt: earlierIso(primary.createdAt, secondary.createdAt),
    actual: latest.actual,
    tracking: mergeTracking(primary.tracking, secondary.tracking),
    relatedBadCaseIds,
    ...(latest.latestEvidence
      ? { latestEvidence: latest.latestEvidence }
      : {}),
  });
}

export function assertCanonicalBadCase(
  badCase: unknown,
): asserts badCase is BadCase {
  decodeBadCase(badCase);
}

export function normalizeCanonicalBadCases(
  cases: readonly unknown[],
): BadCase[] {
  const byId = new Map<string, BadCase>();
  for (const value of cases) {
    const badCase = decodeBadCase(value);
    const existing = byId.get(badCase.id);
    byId.set(
      badCase.id,
      existing ? mergeCanonicalObservations(existing, badCase) : badCase,
    );
  }
  return [...byId.values()];
}

function badCasesPath(options: BadCaseRepositoryOptions): string {
  return options.path ?? BAD_CASES_PATH;
}

export function readBadCases(
  options: BadCaseRepositoryOptions = {},
): BadCase[] {
  const path = badCasesPath(options);
  if (!existsSync(path)) return [];

  const cases = readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(
          `invalid bad case JSON at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        return [decodeBadCase(value)];
      } catch (error) {
        throw new Error(
          `invalid bad case at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  return normalizeCanonicalBadCases(cases);
}

export function writeBadCases(
  cases: readonly unknown[],
  options: BadCaseRepositoryOptions = {},
): void {
  const merged = normalizeCanonicalBadCases(cases);
  const path = badCasesPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    merged.length > 0
      ? `${merged.map((badCase) => JSON.stringify(badCase)).join('\n')}\n`
      : '',
  );
}

export function verifyBadCaseLatestEvidence(
  value: unknown,
  options: BadCaseEvidenceOptions = {},
): { run: EvalRun; envelope: TraceEnvelope } {
  const badCase = decodeBadCase(value);
  const evidence = badCase.latestEvidence;
  if (!evidence) {
    throw new Error(`bad case ${badCase.id} missing latestEvidence`);
  }

  const run = readRun(evidence.runId, { evalRoot: options.evalRoot });
  const expectedKind =
    badCase.tracking.source === 'retrieval_eval' ? 'retrieval' : 'faith';
  if (run.kind !== expectedKind) {
    throw new Error(
      `bad case ${badCase.id} evidence run ${run.id} has kind ${run.kind}, expected ${expectedKind}`,
    );
  }

  const tracePath = evalArtifactPath(run.artifactPaths.trace, options.evalRoot);
  if (!existsSync(tracePath)) {
    throw new Error(
      `bad case ${badCase.id} evidence trace artifact not found: ${run.artifactPaths.trace}`,
    );
  }
  const envelope = readTraceEnvelopes(tracePath).find(
    (candidate) => candidate.traceId === evidence.traceId,
  );
  if (!envelope) {
    throw new Error(
      `bad case ${badCase.id} trace ${evidence.traceId} not found in run ${run.id}`,
    );
  }
  if (envelope.runId !== run.id || envelope.kind !== run.kind) {
    throw new Error(
      `bad case ${badCase.id} evidence envelope does not belong to run ${run.id}`,
    );
  }
  if (envelope.evalCaseId !== badCase.tracking.evalCaseId) {
    throw new Error(
      `bad case ${badCase.id} evidence trace ${evidence.traceId} has evalCaseId ${envelope.evalCaseId}, expected ${badCase.tracking.evalCaseId}`,
    );
  }
  const datasetCase = run.dataset.cases.find(
    (evalCase) => evalCase.id === envelope.evalCaseId,
  );
  if (datasetCase === undefined) {
    throw new Error(
      `bad case ${badCase.id} evidence case ${envelope.evalCaseId} is missing from run dataset`,
    );
  }
  if (!isDeepStrictEqual(datasetCase.governance, envelope.governance)) {
    throw new Error(
      `bad case ${badCase.id} evidence governance does not match run dataset`,
    );
  }
  return { run, envelope };
}

export function upsertBadCases(
  incoming: readonly unknown[],
  options: BadCaseUpsertOptions = {},
): number {
  const decodedIncoming = normalizeCanonicalBadCases(incoming);
  const eligibleIncoming = decodedIncoming.filter((badCase) => {
    const { envelope } = verifyBadCaseLatestEvidence(badCase, {
      evalRoot: options.evalRoot,
    });
    return envelope.governance.role !== 'holdout';
  });
  if (eligibleIncoming.length === 0) return 0;

  const repositoryOptions = { path: options.path };
  const existing = readBadCases(repositoryOptions);
  const seen = new Set(existing.map((badCase) => badCase.id));
  writeBadCases([...existing, ...eligibleIncoming], repositoryOptions);
  return eligibleIncoming.filter((badCase) => !seen.has(badCase.id)).length;
}

export function retrievalMiss(params: {
  evalCaseId: string;
  runId: string;
  traceId: string;
  question: string;
  resource: string;
  expectedChunkIds: string[];
  actualTopIds: string[];
  rankedIds: string[];
  k: number;
  scope: EvalSuite;
}): BadCase {
  const {
    evalCaseId,
    runId,
    traceId,
    question,
    resource,
    expectedChunkIds,
    actualTopIds,
    rankedIds,
    k,
    scope,
  } = params;
  if (!evalCaseId) throw new Error('retrievalMiss requires evalCaseId');
  if (!runId) throw new Error('retrievalMiss requires runId');
  if (!traceId) throw new Error('retrievalMiss requires traceId');
  const topHitCount = expectedChunkIds.filter((id) =>
    actualTopIds.includes(id),
  ).length;
  const ranks = expectedChunkIds.map((id) => {
    const index = rankedIds.indexOf(id);
    return { id, rank: index >= 0 ? index + 1 : 0 };
  });
  const missingFromCandidates = ranks.filter((rank) => rank.rank === 0);
  const outsideTopK = ranks.filter((rank) => rank.rank > k);
  const layer: BadCaseFailureLayer =
    missingFromCandidates.length > 0 ? 'retrieval' : 'rerank';
  const failureType: BadCaseFailureType =
    layer === 'retrieval' ? 'retrieval_miss' : 'rerank_miss';
  const missingNote =
    missingFromCandidates.length > 0
      ? `未进候选: ${missingFromCandidates.map((rank) => rank.id).join(', ')}`
      : '';
  const rerankNote =
    outsideTopK.length > 0
      ? `候选中但排在 top-${k} 外: ${outsideTopK
          .map((rank) => `${rank.id}(rank=${rank.rank})`)
          .join(', ')}`
      : '';
  const note = [
    `top-${k} 命中 ${topHitCount}/${expectedChunkIds.length}`,
    missingNote,
    rerankNote,
  ]
    .filter(Boolean)
    .join('; ');
  const createdAt = new Date().toISOString();

  return decodeBadCase({
    id: canonicalBadCaseId({ evalCaseId, layer, type: failureType }),
    createdAt,
    taskType: 'explain_field',
    input: { question, context: { kind: resource } },
    expected: { sourceIds: expectedChunkIds },
    actual: { sourceIds: actualTopIds },
    failure: { layer, type: failureType, note },
    severity: layer === 'retrieval' ? 'high' : 'medium',
    status: 'new',
    tracking: {
      evalCaseId,
      source: 'retrieval_eval',
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      observedRunIds: [runId],
      occurrenceCount: 1,
      scope,
    },
    latestEvidence: { runId, traceId },
  });
}

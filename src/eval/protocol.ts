import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalHash, canonicalJson, type JsonValue } from '../shared/json';
import {
  EvalCaseGovernanceSchema,
  type EvalCaseGovernance,
} from './cases/governance';

export type { JsonValue } from '../shared/json';

export const EVAL_SCHEMA_VERSION = 3 as const;

const NonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value), {
    message: 'must contain a non-whitespace character',
  });
const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a SHA-256 hex digest');
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const PositiveIntegerSchema = z.int().positive();
const NonNegativeIntegerSchema = z.int().nonnegative();
const FiniteNumberSchema = z.number();
const RatioComponentSchema = FiniteNumberSchema.nonnegative();

export const EvalKindSchema = z.enum([
  'retrieval',
  'faith',
  'judge',
  'generation',
  'fix',
]);

export const EvalScopeSchema = z.enum([
  'tuning',
  'holdout',
  'full',
  'policy',
  'smoke',
  'targeted',
  'calibration',
]);

export const EvalRunStatusSchema = z.enum(['running', 'completed', 'failed']);

export type EvalKind = z.infer<typeof EvalKindSchema>;
export type EvalScope = z.infer<typeof EvalScopeSchema>;
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

export const EVAL_CASE_ERROR_STAGES = [
  'embedding',
  'retrieval',
  'rerank',
  'context_selection',
  'answer_model',
  'yaml_parse',
  'schema_validation',
  'judge_request',
  'judge_parse',
  'judge_quorum',
  'trace_payload',
] as const;

export const EVAL_RUN_FATAL_STAGES = [
  'dataset_preflight',
  'index',
  'runner_initialization',
  'metric_aggregation',
  'artifact_write',
  'case_execution',
] as const;

export const EvalCaseErrorStageSchema = z.enum(EVAL_CASE_ERROR_STAGES);
export const EvalRunFatalStageSchema = z.enum(EVAL_RUN_FATAL_STAGES);
export const EvalErrorStageSchema = z.enum([
  ...EVAL_CASE_ERROR_STAGES,
  ...EVAL_RUN_FATAL_STAGES,
]);

export type EvalCaseErrorStage = z.infer<typeof EvalCaseErrorStageSchema>;
export type EvalRunFatalStage = z.infer<typeof EvalRunFatalStageSchema>;
export type EvalErrorStage = z.infer<typeof EvalErrorStageSchema>;

export const MetricObservationSchema = z
  .strictObject({
    value: z.union([FiniteNumberSchema, z.null()]),
    numerator: RatioComponentSchema.optional(),
    denominator: RatioComponentSchema.optional(),
  })
  .superRefine((observation, context) => {
    const hasNumerator = Object.hasOwn(observation, 'numerator');
    const hasDenominator = Object.hasOwn(observation, 'denominator');

    if (hasNumerator !== hasDenominator) {
      context.addIssue({
        code: 'custom',
        message: 'numerator and denominator must appear together',
      });
      return;
    }
    if (!hasNumerator) return;

    if (
      observation.numerator === undefined ||
      observation.denominator === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'numerator and denominator cannot be undefined',
      });
      return;
    }

    if (
      observation.denominator === 0 &&
      (observation.numerator !== 0 || observation.value !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'zero denominator requires numerator 0 and value null',
      });
      return;
    }

    if (
      observation.denominator > 0 &&
      observation.value !== observation.numerator / observation.denominator
    ) {
      context.addIssue({
        code: 'custom',
        message: 'ratio value must equal numerator divided by denominator',
      });
    }
  });

export type MetricObservation = z.infer<typeof MetricObservationSchema>;

export function metricObservation(
  value: number | null,
  numerator?: number,
  denominator?: number,
): MetricObservation {
  const candidate: Record<string, unknown> = { value };
  if (arguments.length >= 2) candidate.numerator = numerator;
  if (arguments.length >= 3) candidate.denominator = denominator;
  return MetricObservationSchema.parse(candidate);
}

export function ratioObservation(
  numerator: number,
  denominator: number,
): MetricObservation {
  return metricObservation(
    denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
  );
}

export const EvalDatasetCaseIdentitySchema = z.strictObject({
  id: NonEmptyStringSchema,
  governance: EvalCaseGovernanceSchema,
});

export type EvalDatasetCaseIdentity = z.infer<
  typeof EvalDatasetCaseIdentitySchema
>;

export const EvalDatasetIdentitySchema = z
  .strictObject({
    id: NonEmptyStringSchema,
    hash: Sha256Schema,
    cases: z.array(EvalDatasetCaseIdentitySchema),
    caseCount: NonNegativeIntegerSchema,
  })
  .superRefine((dataset, context) => {
    const caseIds = dataset.cases.map((evalCase) => evalCase.id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'dataset case IDs must be unique',
      });
    }
    if (dataset.caseCount !== dataset.cases.length) {
      context.addIssue({
        code: 'custom',
        path: ['caseCount'],
        message: 'caseCount must equal cases length',
      });
    }
  });

export type EvalDatasetIdentity = z.infer<typeof EvalDatasetIdentitySchema>;

export const QueryExpansionConfigSchema = z.strictObject({
  enabled: z.boolean(),
  registryHash: Sha256Schema.nullable(),
  reviewedAliasCount: NonNegativeIntegerSchema,
});

const RetrievalConfigShape = {
  corpusManifestHash: Sha256Schema,
  indexHash: Sha256Schema,
  embeddingModel: NonEmptyStringSchema,
  rerankModel: NonEmptyStringSchema,
  queryExpansion: QueryExpansionConfigSchema,
  k: PositiveIntegerSchema,
};

export const RetrievalEvalConfigSchema = z.strictObject(RetrievalConfigShape);

export const FaithEvalConfigSchema = z.strictObject({
  ...RetrievalConfigShape,
  answerModel: NonEmptyStringSchema,
  judgeModel: NonEmptyStringSchema,
  answerPromptHash: Sha256Schema,
  judgePromptHash: Sha256Schema,
  judgeParserSchemaIdentity: NonEmptyStringSchema,
  judgeAttemptLimit: PositiveIntegerSchema,
});

export const JudgeEvalConfigSchema = z.strictObject({
  judgeModel: NonEmptyStringSchema,
  voteCount: PositiveIntegerSchema,
  promptHash: Sha256Schema,
  parserSchemaIdentity: NonEmptyStringSchema,
});

const GenerationConfigShape = {
  answerModel: NonEmptyStringSchema,
  systemPromptHash: Sha256Schema,
  toolSchemaIdentity: NonEmptyStringSchema,
  validationSchemaIdentity: NonEmptyStringSchema,
};

export const GenerationEvalConfigSchema = z.strictObject(GenerationConfigShape);
export const FixEvalConfigSchema = z.strictObject(GenerationConfigShape);

export type RetrievalEvalConfig = z.infer<typeof RetrievalEvalConfigSchema>;
export type FaithEvalConfig = z.infer<typeof FaithEvalConfigSchema>;
export type JudgeEvalConfig = z.infer<typeof JudgeEvalConfigSchema>;
export type GenerationEvalConfig = z.infer<typeof GenerationEvalConfigSchema>;
export type FixEvalConfig = z.infer<typeof FixEvalConfigSchema>;

const FailureSchema = z.strictObject({
  stage: EvalErrorStageSchema,
  message: NonEmptyStringSchema,
});

const ArtifactPathsSchema = z.strictObject({
  trace: NonEmptyStringSchema,
});

const MetricsSchema = z.record(NonEmptyStringSchema, MetricObservationSchema);

const EvalRunBaseShape = {
  schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
  id: NonEmptyStringSchema,
  status: EvalRunStatusSchema,
  scope: EvalScopeSchema,
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  dataset: EvalDatasetIdentitySchema,
  artifactPaths: ArtifactPathsSchema,
  metricDefinitionVersion: NonEmptyStringSchema,
  metrics: MetricsSchema,
  failure: FailureSchema.optional(),
};

const RetrievalRunSchema = z.strictObject({
  ...EvalRunBaseShape,
  kind: z.literal('retrieval'),
  config: RetrievalEvalConfigSchema,
});

const FaithRunSchema = z.strictObject({
  ...EvalRunBaseShape,
  kind: z.literal('faith'),
  config: FaithEvalConfigSchema,
});

const JudgeRunSchema = z.strictObject({
  ...EvalRunBaseShape,
  kind: z.literal('judge'),
  scope: z.union([z.literal('calibration'), z.literal('targeted')]),
  config: JudgeEvalConfigSchema,
});

const GenerationRunSchema = z.strictObject({
  ...EvalRunBaseShape,
  kind: z.literal('generation'),
  config: GenerationEvalConfigSchema,
});

const FixRunSchema = z.strictObject({
  ...EvalRunBaseShape,
  kind: z.literal('fix'),
  config: FixEvalConfigSchema,
});

export const EvalRunSchema = z
  .discriminatedUnion('kind', [
    RetrievalRunSchema,
    FaithRunSchema,
    JudgeRunSchema,
    GenerationRunSchema,
    FixRunSchema,
  ])
  .superRefine((run, context) => {
    const hasCompletedAt = Object.hasOwn(run, 'completedAt');
    const hasFailure = Object.hasOwn(run, 'failure');

    if (run.status === 'running') {
      if (hasCompletedAt) {
        context.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'running run cannot have completedAt',
        });
      }
      if (hasFailure) {
        context.addIssue({
          code: 'custom',
          path: ['failure'],
          message: 'running run cannot have failure',
        });
      }
      return;
    }

    if (!hasCompletedAt || run.completedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: `${run.status} run requires completedAt`,
      });
    }

    if (run.status === 'completed' && hasFailure) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'completed run cannot have failure',
      });
    }
    if (run.status === 'failed' && (!hasFailure || run.failure === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'failed run requires failure',
      });
    }
  });

export type EvalRun = z.infer<typeof EvalRunSchema>;

const EvalBaselineBaseShape = {
  schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
  sourceRunId: NonEmptyStringSchema,
  promotedAt: IsoDateTimeSchema,
  scope: EvalScopeSchema,
  dataset: EvalDatasetIdentitySchema,
  metricDefinitionVersion: NonEmptyStringSchema,
  metrics: MetricsSchema,
};

const RetrievalBaselineSchema = z.strictObject({
  ...EvalBaselineBaseShape,
  kind: z.literal('retrieval'),
  config: RetrievalEvalConfigSchema,
});

const FaithBaselineSchema = z.strictObject({
  ...EvalBaselineBaseShape,
  kind: z.literal('faith'),
  config: FaithEvalConfigSchema,
});

const JudgeBaselineSchema = z.strictObject({
  ...EvalBaselineBaseShape,
  kind: z.literal('judge'),
  scope: z.literal('calibration'),
  config: JudgeEvalConfigSchema,
});

const GenerationBaselineSchema = z.strictObject({
  ...EvalBaselineBaseShape,
  kind: z.literal('generation'),
  config: GenerationEvalConfigSchema,
});

const FixBaselineSchema = z.strictObject({
  ...EvalBaselineBaseShape,
  kind: z.literal('fix'),
  config: FixEvalConfigSchema,
});

export const EvalBaselineSchema = z.discriminatedUnion('kind', [
  RetrievalBaselineSchema,
  FaithBaselineSchema,
  JudgeBaselineSchema,
  GenerationBaselineSchema,
  FixBaselineSchema,
]);

export type EvalBaseline = z.infer<typeof EvalBaselineSchema>;

const JsonValueSchema = z.custom<JsonValue>(
  (value) => {
    try {
      canonicalJson(value, 'payload');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'payload must be JSON-serializable' },
);

const TraceErrorSchema = z.strictObject({
  stage: EvalCaseErrorStageSchema,
  message: NonEmptyStringSchema,
});

export const TraceEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    traceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    evalCaseId: NonEmptyStringSchema,
    governance: EvalCaseGovernanceSchema,
    kind: EvalKindSchema,
    createdAt: IsoDateTimeSchema,
    outcome: z.enum(['success', 'failed', 'error', 'skipped']),
    payload: JsonValueSchema,
    error: TraceErrorSchema.optional(),
  })
  .superRefine((envelope, context) => {
    const hasError = Object.hasOwn(envelope, 'error');
    if (
      envelope.outcome === 'error' &&
      (!hasError || envelope.error === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'error outcome requires error details',
      });
    }
    if (envelope.outcome !== 'error' && hasError) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'only error outcome can include error details',
      });
    }
  });

type DecodedTraceEnvelope = z.infer<typeof TraceEnvelopeSchema>;

export type TraceEnvelope<
  TKind extends EvalKind = EvalKind,
  TPayload = JsonValue,
> = Omit<DecodedTraceEnvelope, 'kind' | 'payload'> & {
  kind: TKind;
  payload: TPayload;
};

export type { EvalCaseGovernance };

export function decodeEvalRun(value: unknown): EvalRun {
  return EvalRunSchema.parse(value);
}

export function decodeEvalBaseline(value: unknown): EvalBaseline {
  return EvalBaselineSchema.parse(value);
}

export function decodeTraceEnvelope(value: unknown): TraceEnvelope {
  return TraceEnvelopeSchema.parse(value);
}

export function computeCanonicalHash(value: unknown): string {
  return canonicalHash(value);
}

export function computeDatasetHash(
  canonicalCaseSnapshots: readonly unknown[],
): string {
  const serializedCases = canonicalCaseSnapshots
    .map((snapshot, index) => canonicalJson(snapshot, `case[${index}]`))
    .sort();

  // Only case declaration order is set-like; nested array order remains semantic.
  const canonicalDataset = `[${serializedCases.join(',')}]`;
  return createHash('sha256').update(canonicalDataset).digest('hex');
}

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EVAL_SCHEMA_VERSION = 1 as const;

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

export const EvalDatasetIdentitySchema = z
  .strictObject({
    id: NonEmptyStringSchema,
    hash: Sha256Schema,
    caseIds: z.array(NonEmptyStringSchema),
    caseCount: NonNegativeIntegerSchema,
  })
  .superRefine((dataset, context) => {
    if (new Set(dataset.caseIds).size !== dataset.caseIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['caseIds'],
        message: 'caseIds must be unique',
      });
    }
    if (dataset.caseCount !== dataset.caseIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['caseCount'],
        message: 'caseCount must equal caseIds length',
      });
    }
  });

export type EvalDatasetIdentity = z.infer<typeof EvalDatasetIdentitySchema>;

const QueryExpansionConfigSchema = z.strictObject({
  enabled: z.boolean(),
  registryHash: Sha256Schema.nullable(),
  reviewedAliasCount: NonNegativeIntegerSchema,
});

const RetrievalConfigShape = {
  corpusHash: Sha256Schema,
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
  stage: NonEmptyStringSchema,
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
  scope: z.literal('calibration'),
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonicalizeJson(
  value: unknown,
  activeObjects: WeakSet<object>,
  path: string,
): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must be a finite JSON number`);
      }
      return value;
    case 'object':
      break;
    default:
      throw new TypeError(`${path} is not JSON-serializable`);
  }

  if (activeObjects.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  activeObjects.add(value);

  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
          throw new TypeError(`${path} cannot contain symbol keys`);
        }
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw new TypeError(`${path}.${key} is not a JSON array index`);
        }
      }

      const canonical: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] cannot be an array hole`);
        }
        canonical.push(
          canonicalizeJson(value[index], activeObjects, `${path}[${index}]`),
        );
      }
      return canonical;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }

    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} cannot contain symbol keys`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(
          `${path}.${key} must be an enumerable data property`,
        );
      }
      keys.push(key);
    }

    const canonical = Object.create(null) as { [key: string]: JsonValue };
    for (const key of keys.sort()) {
      canonical[key] = canonicalizeJson(
        (value as Record<string, unknown>)[key],
        activeObjects,
        `${path}.${key}`,
      );
    }
    return canonical;
  } finally {
    activeObjects.delete(value);
  }
}

const JsonValueSchema = z.custom<JsonValue>(
  (value) => {
    try {
      canonicalizeJson(value, new WeakSet(), 'payload');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'payload must be JSON-serializable' },
);

const TraceErrorSchema = z.strictObject({
  stage: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
});

export const TraceEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    traceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    evalCaseId: NonEmptyStringSchema,
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
  const canonical = canonicalizeJson(value, new WeakSet(), 'value');
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function computeDatasetHash(
  canonicalCaseSnapshots: readonly unknown[],
): string {
  const serializedCases = canonicalCaseSnapshots
    .map((snapshot, index) =>
      JSON.stringify(
        canonicalizeJson(snapshot, new WeakSet(), `case[${index}]`),
      ),
    )
    .sort();

  // Only case declaration order is set-like; nested array order remains semantic.
  const canonicalDataset = `[${serializedCases.join(',')}]`;
  return createHash('sha256').update(canonicalDataset).digest('hex');
}

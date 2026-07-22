import { z } from 'zod';
import type { RetrievalTrace, TraceHit } from '../retrieval/trace';
import {
  SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
  SERVING_REDACTION_LABELS,
  SERVING_REDACTION_VERSION,
  containsSensitiveServingText,
  type RedactedServingQuestion,
} from './redaction';

export const SERVING_OBSERVATION_SCHEMA_VERSION =
  'serving-observation/v1' as const;

const MAX_CHUNK_ID_LENGTH = 512;
const MAX_HINT_LENGTH = 512;
const MAX_VERSION_LENGTH = 128;
const MAX_HITS_PER_STAGE = 128;
const MAX_TARGETS_PER_HIT = 32;
const MAX_ALIAS_MATCHES = 32;

const CHUNK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:%\[\]*/-]*$/u;
const RESOURCE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const API_VERSION_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/)?[a-z0-9][a-z0-9.]*$/u;
const FIELD_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\[\]*/-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function boundedToken(maxLength: number, pattern: RegExp) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, 'must be trimmed')
    .refine(
      (value) => !/[\s\u0000-\u001f\u007f]/u.test(value),
      'must not contain whitespace or control characters',
    )
    .regex(pattern, 'has an unsupported token format')
    .refine(
      (value) =>
        value.length > maxLength || !containsSensitiveServingText(value),
      'contains a credential pattern',
    );
}

const ChunkIdSchema = boundedToken(MAX_CHUNK_ID_LENGTH, CHUNK_ID_PATTERN);
const ResourceSchema = boundedToken(128, RESOURCE_PATTERN);
const ApiVersionSchema = boundedToken(128, API_VERSION_PATTERN);
const FieldPathSchema = boundedToken(MAX_HINT_LENGTH, FIELD_PATH_PATTERN);
const VersionSchema = boundedToken(MAX_VERSION_LENGTH, VERSION_PATTERN);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const FiniteScoreSchema = z
  .number()
  .refine((value) => Number.isFinite(value), 'must be finite');
const LatencySchema = FiniteScoreSchema.refine(
  (value) => value >= 0,
  'must be non-negative',
);

const RedactionLabelSchema = z.enum(SERVING_REDACTION_LABELS);
const RedactionLabelsSchema = z
  .array(RedactionLabelSchema)
  .max(SERVING_REDACTION_LABELS.length)
  .superRefine((labels, context) => {
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: 'custom',
        message: 'redaction labels must be unique',
      });
    }
  });

const RedactedQuestionSchema = z.strictObject({
  disposition: z.literal('redacted'),
  text: z
    .string()
    .min(1)
    .refine((value) => value.isWellFormed(), 'must be well-formed Unicode')
    .refine(
      (value) =>
        Buffer.byteLength(value, 'utf8') <=
        SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
      'exceeds serving question hard cap',
    )
    .refine(
      (value) => !containsSensitiveServingText(value),
      'contains an unredacted credential pattern',
    ),
  redactionVersion: z.literal(SERVING_REDACTION_VERSION),
  redactionLabels: RedactionLabelsSchema,
});

const DroppedSensitiveQuestionSchema = z.strictObject({
  disposition: z.literal('dropped_sensitive'),
  redactionVersion: z.literal(SERVING_REDACTION_VERSION),
  redactionLabels: RedactionLabelsSchema,
});

const DroppedInvalidQuestionSchema = z.strictObject({
  disposition: z.literal('dropped_invalid'),
  redactionVersion: z.literal(SERVING_REDACTION_VERSION),
  redactionLabels: RedactionLabelsSchema,
});

export const ServingQuestionObservationSchema = z.discriminatedUnion(
  'disposition',
  [
    RedactedQuestionSchema,
    DroppedSensitiveQuestionSchema,
    DroppedInvalidQuestionSchema,
  ],
);

const ServingTargetSchema = z.strictObject({
  apiVersion: ApiVersionSchema.optional(),
  kind: ResourceSchema,
  path: FieldPathSchema.optional(),
});

export const ServingHitReferenceSchema = z.strictObject({
  id: ChunkIdSchema,
  sourceType: z.enum(['schema', 'policy', 'docs', 'example']),
  authority: z.enum([
    'kubernetes_official',
    'cluster_api',
    'extension_provider',
    'organization',
    'curated',
  ]),
  version: VersionSchema.optional(),
  targets: z.array(ServingTargetSchema).max(MAX_TARGETS_PER_HIT),
  score: FiniteScoreSchema.optional(),
});

const QueryExpansionMatchSchema = z.strictObject({
  chunkId: ChunkIdSchema,
  resource: ResourceSchema,
  path: FieldPathSchema,
  strength: z.enum(['weak', 'strong']),
});

const QueryExpansionSchema = z
  .strictObject({
    enabled: z.boolean(),
    status: z.enum([
      'applied',
      'no_match',
      'disabled',
      'skipped_exact',
      'failed',
    ]),
    routedResource: ResourceSchema.optional(),
    selectedResource: ResourceSchema.optional(),
    resourceSelectionReason: z
      .enum([
        'same_resource',
        'no_route_strong_alias',
        'cross_resource_strong_alias',
        'weak_alias_no_resource_override',
        'no_alias_match',
      ])
      .optional(),
    registryHash: Sha256Schema.optional(),
    reviewedAliasCount: z.int().nonnegative().max(100_000).optional(),
    errorCode: z.enum(['aliases_missing', 'aliases_invalid']).optional(),
    matches: z.array(QueryExpansionMatchSchema).max(MAX_ALIAS_MATCHES),
  })
  .superRefine((expansion, context) => {
    if (expansion.status === 'failed' && expansion.errorCode === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'failed expansion requires an error code',
      });
    }
    if (expansion.status !== 'failed' && expansion.errorCode !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'only failed expansion may have an error code',
      });
    }
    if (expansion.status === 'applied' && expansion.matches.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['matches'],
        message: 'applied expansion requires a match',
      });
    }
    if (expansion.status !== 'applied' && expansion.matches.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['matches'],
        message: 'only applied expansion may have matches',
      });
    }
    if (expansion.status === 'disabled' && expansion.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'disabled expansion cannot be enabled',
      });
    }
    if (expansion.status !== 'disabled' && !expansion.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'enabled expansion status requires enabled=true',
      });
    }
  });

export const ServingIndexMissReasonSchema = z.enum([
  'missing_files',
  'incomplete_files',
  'read_error',
  'format_mismatch',
  'invalid_manifest',
  'corpus_count_mismatch',
  'corpus_content_mismatch',
  'corpus_manifest_mismatch',
  'embedding_model_mismatch',
  'index_hash_mismatch',
  'chunk_count_mismatch',
  'invalid_chunk',
  'duplicate_chunk_id',
  'embedding_dimension_mismatch',
  'invalid_embedding',
]);

const IndexCacheSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('hit') }),
  z.strictObject({
    status: z.literal('rebuilt'),
    reason: ServingIndexMissReasonSchema,
  }),
  z.strictObject({ status: z.literal('not_used') }),
]);

const RouteSchema = z.strictObject({
  mode: z.enum(['free', 'explain_field', 'explain_error']),
  path: z.enum(['exact', 'search']),
  resourceHint: ResourceSchema.optional(),
  apiVersionHint: ApiVersionSchema.optional(),
  fieldPathHint: FieldPathSchema.optional(),
});

export const ServingRetrievalObservationSchema = z.strictObject({
  schemaVersion: z.literal(SERVING_OBSERVATION_SCHEMA_VERSION),
  observationId: z.uuid(),
  requestId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  kind: z.literal('retrieval'),
  route: RouteSchema,
  query: ServingQuestionObservationSchema,
  queryExpansion: QueryExpansionSchema.optional(),
  ranking: z.strictObject({
    coarse: z.array(ServingHitReferenceSchema).max(MAX_HITS_PER_STAGE),
    rerank: z.array(ServingHitReferenceSchema).max(MAX_HITS_PER_STAGE),
    final: z.array(ServingHitReferenceSchema).max(MAX_HITS_PER_STAGE),
  }),
  latencyMs: z.strictObject({
    embed: LatencySchema.optional(),
    dense: LatencySchema.optional(),
    rerank: LatencySchema.optional(),
    total: LatencySchema,
  }),
  cache: z
    .strictObject({
      embeddingHit: z.boolean().optional(),
      index: IndexCacheSchema,
    })
    .optional(),
});

export type ServingRetrievalObservation = z.infer<
  typeof ServingRetrievalObservationSchema
>;

export function decodeServingRetrievalObservation(
  value: unknown,
): ServingRetrievalObservation {
  return ServingRetrievalObservationSchema.parse(value);
}

function optionalValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T | undefined {
  if (value === undefined) return undefined;
  const decoded = schema.safeParse(value);
  return decoded.success ? decoded.data : undefined;
}

function projectTarget(target: TraceHit['targets'][number]) {
  const projected: {
    apiVersion?: string;
    kind: string;
    path?: string;
  } = { kind: target.kind };
  if (target.apiVersion !== undefined) projected.apiVersion = target.apiVersion;
  if (target.path !== undefined) projected.path = target.path;
  return projected;
}

function projectHit(hit: TraceHit) {
  const projected: {
    id: string;
    sourceType: TraceHit['sourceType'];
    authority: TraceHit['provenance']['authority'];
    version?: string;
    targets: ReturnType<typeof projectTarget>[];
    score?: number;
  } = {
    id: hit.id,
    sourceType: hit.sourceType,
    authority: hit.provenance.authority,
    targets: hit.targets.map(projectTarget),
  };
  if (hit.provenance.version !== undefined) {
    projected.version = hit.provenance.version;
  }
  if (hit.score !== undefined) projected.score = hit.score;
  return projected;
}

function projectQueryExpansion(
  expansion: NonNullable<RetrievalTrace['queryExpansion']>,
) {
  const projected: Record<string, unknown> = {
    enabled: expansion.enabled,
    status: expansion.status,
    matches: expansion.matchedAliases.map((match) => ({
      chunkId: match.chunkId,
      resource: match.resource,
      path: match.path,
      strength: match.strength,
    })),
  };
  const routedResource = optionalValue(ResourceSchema, expansion.routedResource);
  const selectedResource = optionalValue(
    ResourceSchema,
    expansion.selectedResource,
  );
  if (routedResource !== undefined) projected.routedResource = routedResource;
  if (selectedResource !== undefined) {
    projected.selectedResource = selectedResource;
  }
  if (expansion.resourceSelectionReason !== undefined) {
    projected.resourceSelectionReason = expansion.resourceSelectionReason;
  }
  if (expansion.registryHash !== undefined) {
    projected.registryHash = expansion.registryHash;
  }
  if (expansion.reviewedAliasCount !== undefined) {
    projected.reviewedAliasCount = expansion.reviewedAliasCount;
  }
  if (expansion.errorCode !== undefined) {
    projected.errorCode = expansion.errorCode;
  }
  return projected;
}

export function projectServingRetrievalObservation(input: {
  requestId: string;
  observationId: string;
  trace: RetrievalTrace;
  redactedQuestion: RedactedServingQuestion;
}): ServingRetrievalObservation {
  const route: Record<string, unknown> = {
    mode: input.trace.mode,
    path: input.trace.path,
  };
  const resourceHint = optionalValue(ResourceSchema, input.trace.resourceHint);
  const apiVersionHint = optionalValue(
    ApiVersionSchema,
    input.trace.apiVersionHint,
  );
  const fieldPathHint = optionalValue(
    FieldPathSchema,
    input.trace.fieldPathHint,
  );
  if (resourceHint !== undefined) route.resourceHint = resourceHint;
  if (apiVersionHint !== undefined) route.apiVersionHint = apiVersionHint;
  if (fieldPathHint !== undefined) route.fieldPathHint = fieldPathHint;

  const latencyMs: Record<string, number> = {
    total: input.trace.latencyMs.total,
  };
  if (input.trace.latencyMs.embed !== undefined) {
    latencyMs.embed = input.trace.latencyMs.embed;
  }
  if (input.trace.latencyMs.dense !== undefined) {
    latencyMs.dense = input.trace.latencyMs.dense;
  }
  if (input.trace.latencyMs.rerank !== undefined) {
    latencyMs.rerank = input.trace.latencyMs.rerank;
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: SERVING_OBSERVATION_SCHEMA_VERSION,
    observationId: input.observationId,
    requestId: input.requestId,
    createdAt: input.trace.createdAt,
    kind: 'retrieval',
    route,
    query: input.redactedQuestion,
    ranking: {
      coarse: input.trace.coarseHits.map(projectHit),
      rerank: input.trace.rerankHits.map(projectHit),
      final: input.trace.finalHits.map(projectHit),
    },
    latencyMs,
  };
  if (input.trace.queryExpansion !== undefined) {
    candidate.queryExpansion = projectQueryExpansion(input.trace.queryExpansion);
  }
  if (input.trace.cache !== undefined) {
    const cache: Record<string, unknown> = {
      index: input.trace.cache.index,
    };
    if (input.trace.cache.embeddingHit !== undefined) {
      cache.embeddingHit = input.trace.cache.embeddingHit;
    }
    candidate.cache = cache;
  }

  return decodeServingRetrievalObservation(candidate);
}

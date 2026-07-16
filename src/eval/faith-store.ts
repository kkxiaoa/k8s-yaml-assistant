import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  ProvenanceSchema,
  SourceTypeSchema,
} from '../knowledge/chunk';
import {
  GroundedAnswerExpectedBehaviorSchema,
  GroundedAnswerInputSchema,
  SourceCoverageSchema,
  SourceExpectationSchema,
  evaluateSourceExpectation,
} from './cases/grounded-answer-cases';
import {
  JudgeAttemptSchema,
  JudgeVoteSchema,
} from './judge-votes';
import {
  EvalCaseErrorStageSchema,
  QueryExpansionConfigSchema,
} from './protocol';

export const FaithOutcomeSchema = z.enum([
  'faithful_hit',
  'faithful_miss',
  'hallucination',
  'dual_cause',
  'refused_correctly',
  'refused_wrong',
  'judge_failed',
  'error',
]);

export const FaithErrorPhaseSchema = EvalCaseErrorStageSchema.extract([
  'embedding',
  'retrieval',
  'rerank',
  'context_selection',
  'answer_model',
  'judge_request',
  'judge_parse',
  'judge_quorum',
  'trace_payload',
]);

const NonBlankStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeNumberSchema = z.number().nonnegative();
const FaithKnowledgeTargetSchema = z.strictObject({
  apiVersion: NonBlankStringSchema.optional(),
  kind: NonBlankStringSchema,
  path: NonBlankStringSchema.optional(),
});
const FaithKnowledgeChunkSchema = z.strictObject({
  id: NonBlankStringSchema,
  title: NonBlankStringSchema,
  text: z.string().min(1),
  sourceType: SourceTypeSchema,
  provenance: ProvenanceSchema,
  targets: z.array(FaithKnowledgeTargetSchema),
});

const QueryExpansionTraceSchema = z.strictObject({
  enabled: z.boolean(),
  status: z.enum([
    'applied',
    'no_match',
    'disabled',
    'skipped_exact',
    'failed',
  ]),
  originalQueryText: z.string(),
  expandedQueryText: z.string(),
  matchedAliases: z.array(
    z.strictObject({
      chunkId: NonBlankStringSchema,
      resource: NonBlankStringSchema,
      path: NonBlankStringSchema,
      zhAlias: NonBlankStringSchema,
      strength: z.enum(['weak', 'strong']),
    }),
  ),
  expansionTerms: z.array(NonBlankStringSchema),
  routedResource: NonBlankStringSchema.optional(),
  selectedResource: NonBlankStringSchema.optional(),
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
  reviewedAliasCount: z.int().nonnegative().optional(),
  errorCode: z.enum(['aliases_missing', 'aliases_invalid']).optional(),
});

const TraceHitSchema = z.strictObject({
  id: NonBlankStringSchema,
  title: NonBlankStringSchema,
  sourceType: SourceTypeSchema,
  provenance: ProvenanceSchema,
  targets: z.array(FaithKnowledgeTargetSchema),
  score: z.number().optional(),
});

const IndexMissReasonSchema = z.enum([
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

const IndexCacheTraceSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('hit') }),
  z.strictObject({
    status: z.literal('rebuilt'),
    reason: IndexMissReasonSchema,
  }),
  z.strictObject({ status: z.literal('not_used') }),
]);

export const FaithSearchTraceSchema = z.strictObject({
  queryText: z.string(),
  queryExpansion: QueryExpansionTraceSchema,
  coarseHits: z.array(TraceHitSchema),
  rerankHits: z.array(TraceHitSchema),
  latencyMs: z.strictObject({
    embed: NonNegativeNumberSchema.optional(),
    dense: NonNegativeNumberSchema.optional(),
    sparse: NonNegativeNumberSchema.optional(),
    rerank: NonNegativeNumberSchema.optional(),
    llm: NonNegativeNumberSchema.optional(),
    total: NonNegativeNumberSchema,
  }),
  cache: z.strictObject({
    embeddingHit: z.boolean().optional(),
    index: IndexCacheTraceSchema,
  }),
});

export const FaithContextSourceSchema = z.strictObject({
  n: z.int().positive(),
  id: NonBlankStringSchema,
  title: NonBlankStringSchema,
  sourceType: SourceTypeSchema,
  provenance: ProvenanceSchema,
  targets: z.array(FaithKnowledgeTargetSchema),
});

export const FaithContextSnapshotSchema = z
  .strictObject({
    text: z.string(),
    chunks: z.array(FaithKnowledgeChunkSchema),
    sources: z.array(FaithContextSourceSchema),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.chunks.length !== snapshot.sources.length) {
      context.addIssue({
        code: 'custom',
        message: 'context chunks and sources must have the same length',
        path: ['sources'],
      });
      return;
    }
    for (const [index, source] of snapshot.sources.entries()) {
      const chunk = snapshot.chunks[index]!;
      if (source.n !== index + 1 || source.id !== chunk.id) {
        context.addIssue({
          code: 'custom',
          message: 'context source order/id must match chunks',
          path: ['sources', index],
        });
      }
    }
  });

export const FaithTraceSchema = z.strictObject({
  id: z.string().min(1),
  input: GroundedAnswerInputSchema,
  question: z.string().trim().min(1),
  expectedBehavior: GroundedAnswerExpectedBehaviorSchema,
  sourceExpectation: SourceExpectationSchema.optional(),
  sourceCoverage: SourceCoverageSchema.optional(),
  context: FaithContextSnapshotSchema.optional(),
  target: z
    .strictObject({
      kind: z.string().trim().min(1),
      apiVersion: z.string().trim().min(1).optional(),
    })
    .optional(),
  retrieval: z.strictObject({
    routed: z.string().optional(),
    expectedChunkIds: z.array(z.string()),
    topIds: z.array(z.string()),
    foundCount: z.int().nonnegative(),
    fullRecall: z.boolean(),
    queryExpansionConfig: QueryExpansionConfigSchema,
    searchTrace: FaithSearchTraceSchema.optional(),
  }),
  answer: z.string(),
  judgeAttempts: z.array(JudgeAttemptSchema),
  verdict: JudgeVoteSchema.nullable(),
  outcome: FaithOutcomeSchema,
  errorPhase: FaithErrorPhaseSchema.optional(),
}).superRefine((trace, context) => {
  const isStandalone = trace.input.kind === 'standalone_question';
  const isRefusal = trace.expectedBehavior === 'refuse_insufficient_context';
  if (isStandalone !== isRefusal) {
    context.addIssue({
      code: 'custom',
      message: 'faith trace input and expected behavior do not match',
      path: ['expectedBehavior'],
    });
  }
  if (trace.input.kind === 'standalone_question') {
    if (trace.question !== trace.input.question) {
      context.addIssue({
        code: 'custom',
        message: 'standalone faith trace question does not match its input',
        path: ['question'],
      });
    }
    if (trace.target !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'standalone faith trace cannot include a retrieval target',
        path: ['target'],
      });
    }
    if (trace.retrieval.expectedChunkIds.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'standalone faith trace cannot include expected chunk ids',
        path: ['retrieval', 'expectedChunkIds'],
      });
    }
    if (
      trace.sourceExpectation !== undefined ||
      trace.sourceCoverage !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'standalone faith trace cannot include source expectation',
        path: ['sourceExpectation'],
      });
    }
  } else {
    if (trace.target === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'referenced faith trace requires a retrieval target',
        path: ['target'],
      });
    }
    if (trace.retrieval.expectedChunkIds.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'referenced faith trace requires expected chunk ids',
        path: ['retrieval', 'expectedChunkIds'],
      });
    }
  }

  if (trace.expectedBehavior === 'explain_schema_policy_conflict') {
    const sourceTypes = new Set(trace.sourceExpectation?.types ?? []);
    if (
      trace.sourceExpectation === undefined ||
      !sourceTypes.has('schema') ||
      !sourceTypes.has('policy')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'conflict faith trace requires schema/policy expectation',
        path: ['sourceExpectation'],
      });
    }
  }

  const isError = trace.outcome === 'error';
  if (isError && trace.errorPhase === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'error faith trace requires errorPhase',
      path: ['errorPhase'],
    });
  }
  if (!isError && trace.errorPhase !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'only error faith trace can include errorPhase',
      path: ['errorPhase'],
    });
  }
  if (!isError && trace.context === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'non-error faith trace requires context snapshot',
      path: ['context'],
    });
  }
  if (!isError && trace.retrieval.searchTrace === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'non-error faith trace requires search trace snapshot',
      path: ['retrieval', 'searchTrace'],
    });
  }
  if (!isError && trace.judgeAttempts.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'non-error faith trace requires judge attempts',
      path: ['judgeAttempts'],
    });
  }

  const validAttempts = trace.judgeAttempts.flatMap((attempt, index) =>
    attempt.status === 'valid' ? [{ index, vote: attempt.vote }] : [],
  );
  if (validAttempts.length > 1) {
    context.addIssue({
      code: 'custom',
      message: 'faith trace can contain at most one valid judge attempt',
      path: ['judgeAttempts'],
    });
  }
  const validAttempt = validAttempts[0];
  if (
    validAttempt !== undefined &&
    validAttempt.index !== trace.judgeAttempts.length - 1
  ) {
    context.addIssue({
      code: 'custom',
      message: 'faith judge attempts must stop after the first valid vote',
      path: ['judgeAttempts', validAttempt.index],
    });
  }
  const expectedVerdict = validAttempt?.vote ?? null;
  if (!isDeepStrictEqual(trace.verdict, expectedVerdict)) {
    context.addIssue({
      code: 'custom',
      message: 'faith verdict must match the valid judge attempt',
      path: ['verdict'],
    });
  }
  if (trace.outcome === 'judge_failed' && trace.verdict !== null) {
    context.addIssue({
      code: 'custom',
      message: 'judge_failed faith trace cannot have a verdict',
      path: ['verdict'],
    });
  }
  if (
    trace.outcome !== 'judge_failed' &&
    trace.outcome !== 'error' &&
    trace.verdict === null
  ) {
    context.addIssue({
      code: 'custom',
      message: 'judged faith outcome requires a valid verdict',
      path: ['verdict'],
    });
  }

  if (trace.context !== undefined) {
    const chunkIds = trace.context.chunks.map((chunk) => chunk.id);
    if (
      chunkIds.length !== trace.retrieval.topIds.length ||
      chunkIds.some((id, index) => id !== trace.retrieval.topIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'context chunk ids must equal retrieval topIds',
        path: ['context', 'chunks'],
      });
    }
    const rerankIds = trace.retrieval.searchTrace?.rerankHits.map(
      (hit) => hit.id,
    );
    if (
      rerankIds !== undefined &&
      (chunkIds.length > rerankIds.length ||
        chunkIds.some((id, index) => id !== rerankIds[index]))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'context chunk ids must be a prefix of rerank hit ids',
        path: ['retrieval', 'searchTrace', 'rerankHits'],
      });
    }
  }

  const foundCount = trace.retrieval.expectedChunkIds.filter((id) =>
    trace.retrieval.topIds.includes(id),
  ).length;
  if (trace.retrieval.foundCount !== foundCount) {
    context.addIssue({
      code: 'custom',
      message: 'retrieval foundCount does not match expected/top ids',
      path: ['retrieval', 'foundCount'],
    });
  }
  const fullRecall =
    trace.retrieval.expectedChunkIds.length > 0 &&
    foundCount === trace.retrieval.expectedChunkIds.length;
  if (trace.retrieval.fullRecall !== fullRecall) {
    context.addIssue({
      code: 'custom',
      message: 'retrieval fullRecall does not match expected/top ids',
      path: ['retrieval', 'fullRecall'],
    });
  }

  if (trace.sourceExpectation === undefined) {
    if (trace.sourceCoverage !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'source coverage requires a source expectation',
        path: ['sourceCoverage'],
      });
    }
  } else {
    if (
      trace.sourceCoverage === undefined &&
      (!isError || trace.context !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'source expectation requires source coverage',
        path: ['sourceCoverage'],
      });
    } else if (trace.context !== undefined) {
      const expectedCoverage = evaluateSourceExpectation(
        trace.sourceExpectation,
        trace.context.chunks.map((chunk) => chunk.sourceType),
      )!;
      if (!isDeepStrictEqual(trace.sourceCoverage, expectedCoverage)) {
        context.addIssue({
          code: 'custom',
          message: 'source coverage does not match context snapshot',
          path: ['sourceCoverage'],
        });
      }
    }
  }

  const searchExpansion = trace.retrieval.searchTrace?.queryExpansion;
  if (
    searchExpansion !== undefined &&
    (searchExpansion.enabled !== trace.retrieval.queryExpansionConfig.enabled ||
      (searchExpansion.registryHash !== undefined &&
        searchExpansion.registryHash !==
          trace.retrieval.queryExpansionConfig.registryHash) ||
      (searchExpansion.reviewedAliasCount !== undefined &&
        searchExpansion.reviewedAliasCount !==
          trace.retrieval.queryExpansionConfig.reviewedAliasCount))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'query expansion config does not match search trace',
      path: ['retrieval', 'queryExpansionConfig'],
    });
  }
});

export type FaithOutcome = z.infer<typeof FaithOutcomeSchema>;
export type FaithErrorPhase = z.infer<typeof FaithErrorPhaseSchema>;
export type FaithContextSource = z.infer<typeof FaithContextSourceSchema>;
export type FaithContextSnapshot = z.infer<
  typeof FaithContextSnapshotSchema
>;
export type FaithSearchTrace = z.infer<typeof FaithSearchTraceSchema>;
export type FaithTrace = z.infer<typeof FaithTraceSchema>;

export function decodeFaithTrace(value: unknown): FaithTrace {
  return FaithTraceSchema.parse(value);
}

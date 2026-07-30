import { z } from 'zod';
import { EvalCaseErrorStageSchema } from './protocol';

const NonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value), {
    message: 'must contain a non-whitespace character',
  });

export const POLICY_DIMENSIONS = [
  'distinguished',
  'conflictExplained',
  'misstatedAsOfficial',
] as const;

export const PolicyDimensionSchema = z.enum(POLICY_DIMENSIONS);
export type PolicyDimension = z.infer<typeof PolicyDimensionSchema>;

export const JudgeResponseBehaviorSchema = z.enum([
  'answer',
  'refusal',
  'non_answer',
]);
export type JudgeResponseBehavior = z.infer<
  typeof JudgeResponseBehaviorSchema
>;

export const JudgePolicyVoteSchema = z.strictObject({
  distinguished: z.boolean().optional(),
  conflictExplained: z.boolean().optional(),
  misstatedAsOfficial: z.boolean().optional(),
});

export const JudgeVoteSchema = z.strictObject({
  faithful: z.boolean(),
  responseBehavior: JudgeResponseBehaviorSchema.optional(),
  unsupported: z.array(z.string()),
  reason: NonBlankStringSchema,
  policy: JudgePolicyVoteSchema.optional(),
});

export type JudgeVote = z.infer<typeof JudgeVoteSchema>;

export const LiveJudgeVoteSchema = z.strictObject({
  faithful: z.boolean(),
  responseBehavior: JudgeResponseBehaviorSchema,
  unsupported: z.array(z.string()),
  reason: NonBlankStringSchema,
  policy: JudgePolicyVoteSchema.optional(),
});

export type LiveJudgeVote = z.infer<typeof LiveJudgeVoteSchema>;

export const JudgeInvalidCodeSchema = z.enum([
  'empty_response',
  'invalid_json',
  'invalid_vote',
]);
type JudgeInvalidCode = z.infer<typeof JudgeInvalidCodeSchema>;

const JUDGE_RESPONSE_STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'unknown',
] as const;

const JudgeResponseMetadataSchema = z.strictObject({
  stopReason: z.enum(JUDGE_RESPONSE_STOP_REASONS),
  textBlockCount: z.int().nonnegative(),
  nonTextBlockCount: z.int().nonnegative(),
});
type JudgeResponseMetadataInput = {
  stopReason: unknown;
  textBlockCount: number;
  nonTextBlockCount: number;
};

export const JudgeAttemptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('valid'),
    vote: JudgeVoteSchema,
  }),
  z.strictObject({
    status: z.literal('invalid'),
    code: JudgeInvalidCodeSchema,
    reason: NonBlankStringSchema,
    // Persisted calibration sources may omit metadata; the live parser
    // supplies it for every parser-invalid response.
    response: JudgeResponseMetadataSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    stage: EvalCaseErrorStageSchema.extract(['judge_request']),
    message: NonBlankStringSchema,
  }),
]);

export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

export const LiveJudgeAttemptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('valid'),
    vote: LiveJudgeVoteSchema,
  }),
  z.strictObject({
    status: z.literal('invalid'),
    code: JudgeInvalidCodeSchema,
    reason: NonBlankStringSchema,
    response: JudgeResponseMetadataSchema,
  }),
  z.strictObject({
    status: z.literal('error'),
    stage: EvalCaseErrorStageSchema.extract(['judge_request']),
    message: NonBlankStringSchema,
  }),
]);

export type LiveJudgeAttempt = z.infer<typeof LiveJudgeAttemptSchema>;

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'vote' : `vote.${path.map(String).join('.')}`;
}

function invalidVoteReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
    .join('; ');
}

function normalizeResponseMetadata(input: JudgeResponseMetadataInput) {
  const stopReason = JUDGE_RESPONSE_STOP_REASONS.includes(
    input.stopReason as (typeof JUDGE_RESPONSE_STOP_REASONS)[number],
  )
    ? input.stopReason
    : 'unknown';
  return JudgeResponseMetadataSchema.parse({
    ...input,
    stopReason,
  });
}

function invalidAttempt(
  code: JudgeInvalidCode,
  reason: string,
  responseMetadata: JudgeResponseMetadataInput,
): LiveJudgeAttempt {
  return {
    status: 'invalid',
    code,
    reason,
    response: normalizeResponseMetadata(responseMetadata),
  };
}

export function parseJudgeAttempt(
  text: string,
  responseMetadata: JudgeResponseMetadataInput,
): LiveJudgeAttempt {
  const candidate = text.trim();
  if (candidate.length === 0) {
    return invalidAttempt(
      'empty_response',
      'judge response is empty',
      responseMetadata,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    return invalidAttempt(
      'invalid_json',
      'judge response must be one JSON value with no surrounding text',
      responseMetadata,
    );
  }

  const parsed = LiveJudgeVoteSchema.safeParse(value);
  if (!parsed.success) {
    return invalidAttempt(
      'invalid_vote',
      invalidVoteReason(parsed.error),
      responseMetadata,
    );
  }
  return { status: 'valid', vote: parsed.data };
}

export const DEFAULT_JUDGE_QUORUM = 3;

export const JudgeIndeterminateReasonSchema = z.enum([
  'insufficient_valid_votes',
  'tie',
]);

export const BooleanQuorumDiagnosticsSchema = z.strictObject({
  quorum: z.int().positive(),
  trueVotes: z.int().nonnegative(),
  falseVotes: z.int().nonnegative(),
  validVotes: z.int().nonnegative(),
  reachedQuorum: z.boolean(),
  indeterminateReason: JudgeIndeterminateReasonSchema.nullable(),
  unstable: z.boolean(),
});

export const BooleanQuorumSchema = BooleanQuorumDiagnosticsSchema.extend({
  value: z.boolean().nullable(),
})
  .superRefine((result, context) => {
    if (result.trueVotes + result.falseVotes !== result.validVotes) {
      context.addIssue({
        code: 'custom',
        message: 'true and false votes must equal valid votes',
      });
    }
    const reachedQuorum = result.validVotes >= result.quorum;
    if (result.reachedQuorum !== reachedQuorum) {
      context.addIssue({
        code: 'custom',
        path: ['reachedQuorum'],
        message: 'reachedQuorum does not match valid votes',
      });
    }
    const unstable = result.trueVotes > 0 && result.falseVotes > 0;
    if (result.unstable !== unstable) {
      context.addIssue({
        code: 'custom',
        path: ['unstable'],
        message: 'unstable does not match the vote split',
      });
    }

    const tied = reachedQuorum && result.trueVotes === result.falseVotes;
    const expectedValue =
      !reachedQuorum || tied
        ? null
        : result.trueVotes > result.falseVotes;
    const expectedReason = !reachedQuorum
      ? 'insufficient_valid_votes'
      : tied
        ? 'tie'
        : null;
    if (
      result.value !== expectedValue ||
      result.indeterminateReason !== expectedReason
    ) {
      context.addIssue({
        code: 'custom',
        message: 'quorum conclusion does not match vote counts',
      });
    }
  });

export type BooleanQuorum = z.infer<typeof BooleanQuorumSchema>;

export function computeBooleanQuorum(
  values: readonly boolean[],
  quorum = DEFAULT_JUDGE_QUORUM,
): BooleanQuorum {
  if (!Number.isInteger(quorum) || quorum <= 0) {
    throw new TypeError('judge quorum must be a positive integer');
  }
  const trueVotes = values.filter((value) => value).length;
  const validVotes = values.length;
  const falseVotes = validVotes - trueVotes;
  const reachedQuorum = validVotes >= quorum;
  const tied = reachedQuorum && trueVotes === falseVotes;
  const value =
    !reachedQuorum || tied ? null : trueVotes > falseVotes;

  return BooleanQuorumSchema.parse({
    quorum,
    value,
    trueVotes,
    falseVotes,
    validVotes,
    reachedQuorum,
    indeterminateReason: !reachedQuorum
      ? 'insufficient_valid_votes'
      : tied
        ? 'tie'
        : null,
    unstable: trueVotes > 0 && falseVotes > 0,
  });
}

export const ResponseBehaviorQuorumDiagnosticsSchema = z.strictObject({
  quorum: z.int().positive(),
  answerVotes: z.int().nonnegative(),
  refusalVotes: z.int().nonnegative(),
  nonAnswerVotes: z.int().nonnegative(),
  validVotes: z.int().nonnegative(),
  reachedQuorum: z.boolean(),
  indeterminateReason: JudgeIndeterminateReasonSchema.nullable(),
  unstable: z.boolean(),
});

const ResponseBehaviorQuorumSchema =
  ResponseBehaviorQuorumDiagnosticsSchema.extend({
    responseBehavior: JudgeResponseBehaviorSchema.nullable(),
  })
  .superRefine((result, context) => {
    const counts = {
      answer: result.answerVotes,
      refusal: result.refusalVotes,
      non_answer: result.nonAnswerVotes,
    } as const;
    const validVotes = Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    );
    if (result.validVotes !== validVotes) {
      context.addIssue({
        code: 'custom',
        path: ['validVotes'],
        message: 'response behavior vote counts must equal valid votes',
      });
    }
    const reachedQuorum = validVotes >= result.quorum;
    if (result.reachedQuorum !== reachedQuorum) {
      context.addIssue({
        code: 'custom',
        path: ['reachedQuorum'],
        message: 'reachedQuorum does not match valid votes',
      });
    }
    const unstable =
      Object.values(counts).filter((count) => count > 0).length > 1;
    if (result.unstable !== unstable) {
      context.addIssue({
        code: 'custom',
        path: ['unstable'],
        message: 'unstable does not match the response behavior vote split',
      });
    }

    const highest = Math.max(...Object.values(counts));
    const winners = Object.entries(counts).filter(
      ([, count]) => count === highest,
    );
    const tied = reachedQuorum && winners.length !== 1;
    const expectedBehavior =
      !reachedQuorum || tied
        ? null
        : JudgeResponseBehaviorSchema.parse(winners[0]![0]);
    const expectedReason = !reachedQuorum
      ? 'insufficient_valid_votes'
      : tied
        ? 'tie'
        : null;
    if (
      result.responseBehavior !== expectedBehavior ||
      result.indeterminateReason !== expectedReason
    ) {
      context.addIssue({
        code: 'custom',
        message: 'response behavior conclusion does not match vote counts',
      });
    }
  });

type ResponseBehaviorQuorum = z.infer<
  typeof ResponseBehaviorQuorumSchema
>;

export function computeResponseBehaviorQuorum(
  values: readonly JudgeResponseBehavior[],
  quorum = DEFAULT_JUDGE_QUORUM,
): ResponseBehaviorQuorum {
  if (!Number.isInteger(quorum) || quorum <= 0) {
    throw new TypeError('judge quorum must be a positive integer');
  }
  const answerVotes = values.filter((value) => value === 'answer').length;
  const refusalVotes = values.filter((value) => value === 'refusal').length;
  const nonAnswerVotes = values.filter(
    (value) => value === 'non_answer',
  ).length;
  const validVotes = values.length;
  const reachedQuorum = validVotes >= quorum;
  const counts = [
    ['answer', answerVotes],
    ['refusal', refusalVotes],
    ['non_answer', nonAnswerVotes],
  ] as const;
  const highest = Math.max(...counts.map(([, count]) => count));
  const winners = counts.filter(([, count]) => count === highest);
  const tied = reachedQuorum && winners.length !== 1;

  return ResponseBehaviorQuorumSchema.parse({
    quorum,
    responseBehavior:
      !reachedQuorum || tied ? null : winners[0]![0],
    answerVotes,
    refusalVotes,
    nonAnswerVotes,
    validVotes,
    reachedQuorum,
    indeterminateReason: !reachedQuorum
      ? 'insufficient_valid_votes'
      : tied
        ? 'tie'
        : null,
    unstable: counts.filter(([, count]) => count > 0).length > 1,
  });
}

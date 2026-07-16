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

export const JudgePolicyVoteSchema = z.strictObject({
  distinguished: z.boolean().optional(),
  conflictExplained: z.boolean().optional(),
  misstatedAsOfficial: z.boolean().optional(),
});

export const JudgeVoteSchema = z.strictObject({
  faithful: z.boolean(),
  unsupported: z.array(z.string()),
  reason: NonBlankStringSchema,
  policy: JudgePolicyVoteSchema.optional(),
});

export type JudgeVote = z.infer<typeof JudgeVoteSchema>;

export const JudgeInvalidCodeSchema = z.enum([
  'empty_response',
  'invalid_json',
  'invalid_vote',
]);

export const JudgeAttemptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('valid'),
    vote: JudgeVoteSchema,
  }),
  z.strictObject({
    status: z.literal('invalid'),
    code: JudgeInvalidCodeSchema,
    reason: NonBlankStringSchema,
  }),
  z.strictObject({
    status: z.literal('error'),
    stage: EvalCaseErrorStageSchema.extract(['judge_request']),
    message: NonBlankStringSchema,
  }),
]);

export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? 'vote' : `vote.${path.map(String).join('.')}`;
}

function invalidVoteReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
    .join('; ');
}

export function parseJudgeAttempt(text: string): JudgeAttempt {
  const candidate = text.trim();
  if (candidate.length === 0) {
    return {
      status: 'invalid',
      code: 'empty_response',
      reason: 'judge response is empty',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    return {
      status: 'invalid',
      code: 'invalid_json',
      reason: 'judge response must be one JSON value with no surrounding text',
    };
  }

  const parsed = JudgeVoteSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: 'invalid',
      code: 'invalid_vote',
      reason: invalidVoteReason(parsed.error),
    };
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

import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { FaithContextSourceSchema } from '../faith-store';
import { EvalCaseGovernanceSchema } from '../cases/governance';
import {
  BooleanQuorumDiagnosticsSchema,
  DEFAULT_JUDGE_QUORUM,
  JudgeAttemptSchema,
  POLICY_DIMENSIONS,
  computeBooleanQuorum,
  type JudgeAttempt,
  type PolicyDimension,
} from '../judge-votes';
import {
  metricObservation,
  ratioObservation,
  type MetricObservation,
} from '../protocol';

export { POLICY_DIMENSIONS } from '../judge-votes';
export type { JudgeVote, PolicyDimension } from '../judge-votes';

const NonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value), {
    message: 'must contain a non-whitespace character',
  });

export const JudgeCalibrationCategorySchema = z.enum([
  'faithful',
  'correct_refusal',
  'unsupported_default',
  'example_gray',
  'hallucinated',
  'policy_distinction',
  'policy_conflict',
]);

const HumanPolicySchema = z.strictObject({
  distinguished: z.boolean().optional(),
  conflictExplained: z.boolean().optional(),
  misstatedAsOfficial: z.boolean().optional(),
});

export const JudgeHumanLabelSchema = z.strictObject({
  faithful: z.boolean(),
  policy: HumanPolicySchema.optional(),
  note: NonBlankStringSchema,
});

export const JudgeCalibrationLabelSchema = z.strictObject({
  id: NonBlankStringSchema,
  sourceFaithRunId: NonBlankStringSchema,
  category: JudgeCalibrationCategorySchema,
  human: JudgeHumanLabelSchema,
});

export const JudgeCalibrationCaseSchema = z.strictObject({
  id: NonBlankStringSchema,
  governance: EvalCaseGovernanceSchema,
  category: JudgeCalibrationCategorySchema,
  sourceFaithRunId: NonBlankStringSchema,
  sourceFaithTraceId: NonBlankStringSchema,
  question: NonBlankStringSchema,
  context: NonBlankStringSchema,
  sources: z.array(FaithContextSourceSchema).min(1),
  answer: NonBlankStringSchema,
  human: JudgeHumanLabelSchema,
});

export type JudgeCalibrationLabel = z.infer<
  typeof JudgeCalibrationLabelSchema
>;
export type JudgeCalibrationCase = z.infer<
  typeof JudgeCalibrationCaseSchema
>;

function uniqueRowsSchema<T extends z.ZodType<{
  id: string;
}>>(rowSchema: T, artifact: string) {
  return z
    .array(rowSchema)
    .min(1)
    .superRefine((rows, context) => {
      const ids = new Set<string>();
      for (const [index, row] of rows.entries()) {
        if (ids.has(row.id)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: `duplicate ${artifact} id: ${row.id}`,
          });
        }
        ids.add(row.id);
      }
    });
}

const JudgeCalibrationLabelsSchema = uniqueRowsSchema(
  JudgeCalibrationLabelSchema,
  'calibration label',
);

const JudgeCalibrationCasesSchema = uniqueRowsSchema(
  JudgeCalibrationCaseSchema,
  'calibration case',
).superRefine((rows, context) => {
  const traceIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (traceIds.has(row.sourceFaithTraceId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'sourceFaithTraceId'],
        message: `duplicate source faith trace id: ${row.sourceFaithTraceId}`,
      });
    }
    traceIds.add(row.sourceFaithTraceId);
  }
});

export function decodeJudgeCalibrationLabels(
  value: unknown,
): JudgeCalibrationLabel[] {
  return JudgeCalibrationLabelsSchema.parse(value);
}

export function decodeJudgeCalibrationCases(
  value: unknown,
): JudgeCalibrationCase[] {
  return JudgeCalibrationCasesSchema.parse(value);
}

function parseJsonLines(raw: string, artifact: string): unknown[] {
  return raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (error) {
      throw new Error(
        `invalid ${artifact} JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

export function parseJudgeCalibrationLabelsJsonl(
  raw: string,
): JudgeCalibrationLabel[] {
  return decodeJudgeCalibrationLabels(
    parseJsonLines(raw, 'judge calibration label'),
  );
}

export function parseJudgeCalibrationCasesJsonl(
  raw: string,
): JudgeCalibrationCase[] {
  return decodeJudgeCalibrationCases(
    parseJsonLines(raw, 'judge calibration'),
  );
}

const AttemptSummarySchema = z
  .strictObject({
    planned: z.int().positive(),
    executed: z.int().nonnegative(),
    valid: z.int().nonnegative(),
    invalid: z.int().nonnegative(),
    error: z.int().nonnegative(),
    items: z.array(JudgeAttemptSchema),
  })
  .superRefine((summary, context) => {
    const valid = summary.items.filter(
      (attempt) => attempt.status === 'valid',
    ).length;
    const invalid = summary.items.filter(
      (attempt) => attempt.status === 'invalid',
    ).length;
    const error = summary.items.filter(
      (attempt) => attempt.status === 'error',
    ).length;
    if (
      summary.executed !== summary.items.length ||
      summary.executed !== summary.valid + summary.invalid + summary.error ||
      summary.valid !== valid ||
      summary.invalid !== invalid ||
      summary.error !== error
    ) {
      context.addIssue({
        code: 'custom',
        message: 'judge attempt counts do not match attempt items',
      });
    }
    if (summary.executed > summary.planned) {
      context.addIssue({
        code: 'custom',
        path: ['executed'],
        message: 'executed judge attempts cannot exceed planned attempts',
      });
    }
  });

const FaithfulQuorumResultSchema = BooleanQuorumDiagnosticsSchema.extend({
  faithful: z.boolean().nullable(),
  agree: z.boolean().nullable(),
});

const PolicyQuorumResultSchema = BooleanQuorumDiagnosticsSchema.extend({
  human: z.boolean(),
  judge: z.boolean().nullable(),
  agree: z.boolean().nullable(),
});

export type JudgePolicyDimensionResult = z.infer<
  typeof PolicyQuorumResultSchema
>;

export const JudgeCalibrationTraceSchema = z
  .strictObject({
    id: NonBlankStringSchema,
    governance: EvalCaseGovernanceSchema,
    category: JudgeCalibrationCategorySchema,
    question: NonBlankStringSchema,
    sourceFaithRunId: NonBlankStringSchema,
    sourceFaithTraceId: NonBlankStringSchema,
    human: JudgeHumanLabelSchema,
    attempts: AttemptSummarySchema,
    majority: FaithfulQuorumResultSchema,
    policy: z.strictObject({
      distinguished: PolicyQuorumResultSchema.optional(),
      conflictExplained: PolicyQuorumResultSchema.optional(),
      misstatedAsOfficial: PolicyQuorumResultSchema.optional(),
    }),
  })
  .superRefine((trace, context) => {
    const {
      faithful,
      agree: faithfulAgree,
      ...faithfulDiagnostics
    } = trace.majority;
    const expectedFaithfulQuorum = computeBooleanQuorum(
      trace.attempts.items.flatMap((attempt) =>
        attempt.status === 'valid' ? [attempt.vote.faithful] : [],
      ),
      trace.majority.quorum,
    );
    if (
      !isDeepStrictEqual(
        { value: faithful, ...faithfulDiagnostics },
        expectedFaithfulQuorum,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['majority'],
        message: 'faithful quorum diagnostics are inconsistent',
      });
    }
    const expectedFaithfulAgree =
      faithful === null ? null : faithful === trace.human.faithful;
    if (faithfulAgree !== expectedFaithfulAgree) {
      context.addIssue({
        code: 'custom',
        path: ['majority', 'agree'],
        message: 'faithful agreement does not match human label',
      });
    }
    if (trace.majority.validVotes !== trace.attempts.valid) {
      context.addIssue({
        code: 'custom',
        path: ['majority', 'validVotes'],
        message: 'faithful valid vote count must match valid attempts',
      });
    }
    if (trace.majority.quorum > trace.attempts.planned) {
      context.addIssue({
        code: 'custom',
        path: ['majority', 'quorum'],
        message: 'faithful quorum cannot exceed planned attempts',
      });
    }
    for (const dimension of POLICY_DIMENSIONS) {
      const result = trace.policy[dimension];
      const expectedHuman = trace.human.policy?.[dimension];
      if (typeof expectedHuman !== 'boolean') {
        if (result !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['policy', dimension],
            message: 'policy result requires an explicit human label',
          });
        }
        continue;
      }
      if (!result) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension],
          message: 'explicit human policy label requires a policy result',
        });
        continue;
      }
      const {
        human: resultHuman,
        judge,
        agree,
        ...diagnostics
      } = result;
      const expectedPolicyQuorum = computeBooleanQuorum(
        trace.attempts.items.flatMap((attempt) => {
          if (attempt.status !== 'valid') return [];
          const value = attempt.vote.policy?.[dimension];
          return typeof value === 'boolean' ? [value] : [];
        }),
        result.quorum,
      );
      if (
        !isDeepStrictEqual(
          { value: judge, ...diagnostics },
          expectedPolicyQuorum,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension],
          message: 'policy quorum diagnostics are inconsistent',
        });
      }
      const expectedAgree =
        judge === null ? null : judge === resultHuman;
      if (agree !== expectedAgree) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension, 'agree'],
          message: 'policy agreement does not match human label',
        });
      }
      if (resultHuman !== expectedHuman) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension, 'human'],
          message: 'policy result human value does not match human label',
        });
      }
      if (result.quorum !== trace.majority.quorum) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension, 'quorum'],
          message: 'policy quorum must match faithful quorum',
        });
      }
      if (result.validVotes > trace.attempts.valid) {
        context.addIssue({
          code: 'custom',
          path: ['policy', dimension, 'validVotes'],
          message: 'policy valid vote count cannot exceed valid attempts',
        });
      }
    }
  });

export type JudgeCalibrationTrace = z.infer<
  typeof JudgeCalibrationTraceSchema
>;

function attemptSummary(
  attempts: readonly JudgeAttempt[],
  planned: number,
): z.infer<typeof AttemptSummarySchema> {
  return AttemptSummarySchema.parse({
    planned,
    executed: attempts.length,
    valid: attempts.filter((attempt) => attempt.status === 'valid').length,
    invalid: attempts.filter((attempt) => attempt.status === 'invalid').length,
    error: attempts.filter((attempt) => attempt.status === 'error').length,
    items: attempts,
  });
}

function faithfulResult(
  attempts: readonly JudgeAttempt[],
  expected: boolean,
  quorum: number,
): JudgeCalibrationTrace['majority'] {
  const result = computeBooleanQuorum(
    attempts.flatMap((attempt) =>
      attempt.status === 'valid' ? [attempt.vote.faithful] : [],
    ),
    quorum,
  );
  const { value: faithful, ...diagnostics } = result;
  return {
    faithful,
    ...diagnostics,
    agree: faithful === null ? null : faithful === expected,
  };
}

function policyResult(
  attempts: readonly JudgeAttempt[],
  dimension: PolicyDimension,
  expected: boolean,
  quorum: number,
): JudgePolicyDimensionResult {
  const result = computeBooleanQuorum(
    attempts.flatMap((attempt) => {
      if (attempt.status !== 'valid') return [];
      const value = attempt.vote.policy?.[dimension];
      return typeof value === 'boolean' ? [value] : [];
    }),
    quorum,
  );
  const { value: judge, ...diagnostics } = result;
  return {
    human: expected,
    judge,
    ...diagnostics,
    agree: judge === null ? null : judge === expected,
  };
}

export function buildJudgeCalibrationTrace(params: {
  calibrationCase: JudgeCalibrationCase;
  attempts: readonly JudgeAttempt[];
  plannedVotes: number;
  quorum?: number;
}): JudgeCalibrationTrace {
  const calibrationCase = JudgeCalibrationCaseSchema.parse(
    params.calibrationCase,
  );
  const attempts = params.attempts.map((attempt) =>
    JudgeAttemptSchema.parse(attempt),
  );
  const quorum = params.quorum ?? DEFAULT_JUDGE_QUORUM;
  if (quorum > params.plannedVotes) {
    throw new TypeError('judge quorum cannot exceed planned votes');
  }
  const policy: JudgeCalibrationTrace['policy'] = {};

  for (const dimension of POLICY_DIMENSIONS) {
    const expected = calibrationCase.human.policy?.[dimension];
    if (typeof expected !== 'boolean') continue;
    policy[dimension] = policyResult(
      attempts,
      dimension,
      expected,
      quorum,
    );
  }

  return JudgeCalibrationTraceSchema.parse({
    id: calibrationCase.id,
    governance: calibrationCase.governance,
    category: calibrationCase.category,
    question: calibrationCase.question,
    sourceFaithRunId: calibrationCase.sourceFaithRunId,
    sourceFaithTraceId: calibrationCase.sourceFaithTraceId,
    human: calibrationCase.human,
    attempts: attemptSummary(attempts, params.plannedVotes),
    majority: faithfulResult(
      attempts,
      calibrationCase.human.faithful,
      quorum,
    ),
    policy,
  });
}

export function decodeJudgeCalibrationTrace(
  value: unknown,
): JudgeCalibrationTrace {
  return JudgeCalibrationTraceSchema.parse(value);
}

export interface JudgeCalibrationMetrics {
  agree: number;
  judged: number;
  judgeFailed: number;
  unstableCount: number;
  agreementRate: number | null;
  attempts: {
    planned: number;
    executed: number;
    valid: number;
    invalid: number;
    error: number;
  };
  policy: Record<
    PolicyDimension,
    {
      total: number;
      agree: number;
      indeterminate: number;
      unstable: number;
      judged: number;
      agreementRate: number | null;
    }
  >;
}

export function computeJudgeCalibrationMetrics(
  traces: readonly JudgeCalibrationTrace[],
): JudgeCalibrationMetrics {
  const policy = Object.fromEntries(
    POLICY_DIMENSIONS.map((dimension) => [
      dimension,
      {
        total: 0,
        agree: 0,
        indeterminate: 0,
        unstable: 0,
        judged: 0,
        agreementRate: null,
      },
    ]),
  ) as JudgeCalibrationMetrics['policy'];
  const attempts = {
    planned: 0,
    executed: 0,
    valid: 0,
    invalid: 0,
    error: 0,
  };
  let agree = 0;
  let judged = 0;
  let judgeFailed = 0;
  let unstableCount = 0;

  for (const rawTrace of traces) {
    const trace = decodeJudgeCalibrationTrace(rawTrace);
    attempts.planned += trace.attempts.planned;
    attempts.executed += trace.attempts.executed;
    attempts.valid += trace.attempts.valid;
    attempts.invalid += trace.attempts.invalid;
    attempts.error += trace.attempts.error;

    if (trace.majority.unstable) unstableCount++;
    if (trace.majority.faithful === null) {
      judgeFailed++;
    } else {
      judged++;
      if (trace.majority.agree) agree++;
    }

    for (const dimension of POLICY_DIMENSIONS) {
      const result = trace.policy[dimension];
      if (!result) continue;
      const stat = policy[dimension];
      stat.total++;
      if (result.unstable) stat.unstable++;
      if (result.judge === null) {
        stat.indeterminate++;
        continue;
      }
      stat.judged++;
      if (result.agree) stat.agree++;
    }
  }

  for (const dimension of POLICY_DIMENSIONS) {
    const stat = policy[dimension];
    stat.agreementRate = ratioObservation(stat.agree, stat.judged).value;
  }

  return {
    agree,
    judged,
    judgeFailed,
    unstableCount,
    agreementRate: ratioObservation(agree, judged).value,
    attempts,
    policy,
  };
}

export function judgeMetricsRecord(
  metrics: JudgeCalibrationMetrics,
): Record<string, MetricObservation> {
  const record: Record<string, MetricObservation> = {
    'judge.agreement_rate': ratioObservation(
      metrics.agree,
      metrics.judged,
    ),
    'judge.agree': metricObservation(metrics.agree),
    'judge.judged': metricObservation(metrics.judged),
    'judge.indeterminate': metricObservation(metrics.judgeFailed),
    'judge.unstable': metricObservation(metrics.unstableCount),
    'judge.attempt.planned': metricObservation(metrics.attempts.planned),
    'judge.attempt.executed': metricObservation(metrics.attempts.executed),
    'judge.attempt.valid': metricObservation(metrics.attempts.valid),
    'judge.attempt.invalid': metricObservation(metrics.attempts.invalid),
    'judge.attempt.error': metricObservation(metrics.attempts.error),
  };
  for (const dimension of POLICY_DIMENSIONS) {
    const stat = metrics.policy[dimension];
    record[`judge.policy.${dimension}.agreement_rate`] = ratioObservation(
      stat.agree,
      stat.judged,
    );
    record[`judge.policy.${dimension}.agree`] = metricObservation(stat.agree);
    record[`judge.policy.${dimension}.judged`] = metricObservation(stat.judged);
    record[`judge.policy.${dimension}.indeterminate`] = metricObservation(
      stat.indeterminate,
    );
    record[`judge.policy.${dimension}.unstable`] = metricObservation(
      stat.unstable,
    );
  }
  return record;
}

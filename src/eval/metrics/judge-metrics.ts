import { createHash } from 'node:crypto';

export type PolicyDimension =
  | 'distinguished'
  | 'conflictExplained'
  | 'misstatedAsOfficial';

export interface JudgeCalibrationCase {
  id: string;
  category: string;
  sourceFaithRunId?: string;
  question: string;
  context: string;
  answer: string;
  human: {
    faithful: boolean;
    policy?: Partial<Record<PolicyDimension, boolean>>;
    note: string;
  };
}

export interface JudgeVote {
  faithful: boolean;
  unsupported: string[];
  reason: string;
  policy?: Partial<Record<PolicyDimension, boolean>>;
}

export interface JudgePolicyDimensionResult {
  human: boolean;
  judge: boolean | null;
  trueVotes: number;
  totalVotes: number;
  missing: boolean;
  unstable: boolean;
  agree: boolean;
}

export interface JudgeCalibrationTrace {
  id: string;
  category: string;
  question: string;
  human: JudgeCalibrationCase['human'];
  votes: JudgeVote[];
  majority: {
    faithful: boolean | null;
    trueVotes: number;
    totalVotes: number;
    unstable: boolean;
    agree: boolean | null;
  };
  policy: Partial<Record<PolicyDimension, JudgePolicyDimensionResult>>;
}

export interface JudgeCalibrationMetrics {
  agree: number;
  judged: number;
  judgeFailed: number;
  unstableCount: number;
  agreementRate: number;
  policy: Record<
    PolicyDimension,
    {
      total: number;
      agree: number;
      missing: number;
      unstable: number;
      judged: number;
      agreementRate: number | null;
    }
  >;
}

export const POLICY_DIMENSIONS: PolicyDimension[] = [
  'distinguished',
  'conflictExplained',
  'misstatedAsOfficial',
];

function majority(values: boolean[]): {
  value: boolean | null;
  trueVotes: number;
  totalVotes: number;
  unstable: boolean;
} {
  const trueVotes = values.filter(Boolean).length;
  const totalVotes = values.length;
  return {
    value: totalVotes === 0 ? null : trueVotes * 2 > totalVotes,
    trueVotes,
    totalVotes,
    unstable: trueVotes > 0 && trueVotes < totalVotes,
  };
}

export function buildJudgeCalibrationTrace(params: {
  calibrationCase: JudgeCalibrationCase;
  votes: JudgeVote[];
}): JudgeCalibrationTrace {
  const { calibrationCase, votes } = params;
  const faithMajority = majority(votes.map((vote) => vote.faithful));
  const faithful = faithMajority.value;
  const policy: JudgeCalibrationTrace['policy'] = {};

  for (const dim of POLICY_DIMENSIONS) {
    const expected = calibrationCase.human.policy?.[dim];
    if (typeof expected !== 'boolean') continue;

    const dimMajority = majority(
      votes
        .map((vote) => vote.policy?.[dim])
        .filter((value): value is boolean => typeof value === 'boolean'),
    );
    const judge = dimMajority.value;
    policy[dim] = {
      human: expected,
      judge,
      trueVotes: dimMajority.trueVotes,
      totalVotes: dimMajority.totalVotes,
      missing: judge === null,
      unstable: dimMajority.unstable,
      agree: judge === expected,
    };
  }

  return {
    id: calibrationCase.id,
    category: calibrationCase.category,
    question: calibrationCase.question,
    human: calibrationCase.human,
    votes,
    majority: {
      faithful,
      trueVotes: faithMajority.trueVotes,
      totalVotes: faithMajority.totalVotes,
      unstable: faithMajority.unstable,
      agree:
        faithful === null ? null : faithful === calibrationCase.human.faithful,
    },
    policy,
  };
}

export function computeJudgeCalibrationMetrics(
  traces: JudgeCalibrationTrace[],
): JudgeCalibrationMetrics {
  const policy = Object.fromEntries(
    POLICY_DIMENSIONS.map((dim) => [
      dim,
      {
        total: 0,
        agree: 0,
        missing: 0,
        unstable: 0,
        judged: 0,
        agreementRate: null,
      },
    ]),
  ) as JudgeCalibrationMetrics['policy'];
  let agree = 0;
  let judged = 0;
  let judgeFailed = 0;
  let unstableCount = 0;

  for (const trace of traces) {
    if (trace.majority.faithful === null) {
      judgeFailed++;
    } else {
      judged++;
      if (trace.majority.agree) agree++;
      if (trace.majority.unstable) unstableCount++;
    }

    for (const dim of POLICY_DIMENSIONS) {
      const result = trace.policy[dim];
      if (!result) continue;
      const stat = policy[dim];
      stat.total++;
      if (result.missing) {
        stat.missing++;
        continue;
      }
      stat.judged++;
      if (result.unstable) stat.unstable++;
      if (result.agree) stat.agree++;
    }
  }

  for (const dim of POLICY_DIMENSIONS) {
    const stat = policy[dim];
    stat.agreementRate = stat.judged ? stat.agree / stat.judged : null;
  }

  return {
    agree,
    judged,
    judgeFailed,
    unstableCount,
    agreementRate: judged ? agree / judged : 0,
    policy,
  };
}

export function computeJudgeCalibrationHash(
  cases: JudgeCalibrationCase[],
): string {
  const h = createHash('sha256');
  for (const item of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(item.id);
    h.update('\n');
    h.update(item.question);
    h.update('\n');
    h.update(item.context);
    h.update('\n');
    h.update(item.answer);
    h.update('\n');
    h.update(JSON.stringify(item.human));
    h.update('\n');
  }
  return h.digest('hex');
}

export function judgeMetricsRecord(
  metrics: JudgeCalibrationMetrics,
): Record<string, number> {
  const record: Record<string, number> = {
    'judge.agreement_rate': metrics.agreementRate,
    'judge.agree': metrics.agree,
    'judge.judged': metrics.judged,
    'judge.failed': metrics.judgeFailed,
    'judge.unstable': metrics.unstableCount,
  };
  for (const dim of POLICY_DIMENSIONS) {
    const stat = metrics.policy[dim];
    if (stat.agreementRate !== null) {
      record[`judge.policy.${dim}.agreement_rate`] = stat.agreementRate;
    }
    record[`judge.policy.${dim}.agree`] = stat.agree;
    record[`judge.policy.${dim}.judged`] = stat.judged;
    record[`judge.policy.${dim}.missing`] = stat.missing;
    record[`judge.policy.${dim}.unstable`] = stat.unstable;
  }
  return record;
}

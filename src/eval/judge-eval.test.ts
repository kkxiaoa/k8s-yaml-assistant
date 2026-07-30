import assert from 'node:assert/strict';
import { judgeReasonForMajority } from './judge-eval';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationMetrics,
  decodeJudgeCalibrationCases,
  decodeJudgeCalibrationLabels,
  decodeJudgeCalibrationTrace,
  judgeMetricsRecord,
  parseJudgeCalibrationLabelsJsonl,
  type JudgeCalibrationCase,
} from './metrics/judge-metrics';
import type { JudgeAttempt, JudgeVote } from './judge-votes';
import { metricObservation } from './protocol';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const SOURCE = {
  n: 1,
  id: 'schema::v1::Pod::spec.field',
  title: 'Pod field',
  sourceType: 'schema' as const,
  provenance: { authority: 'cluster_api' as const, version: 'v1' },
  targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.field' }],
};
const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function calibrationCase(
  id: string,
  faithful: boolean,
  policy?: JudgeCalibrationCase['human']['policy'],
  responseBehavior?: JudgeCalibrationCase['human']['responseBehavior'],
): JudgeCalibrationCase {
  return {
    id,
    governance: GOVERNANCE,
    category: 'faithful',
    sourceFaithRunId: 'faith-run-1',
    sourceFaithTraceId: `faith-trace-${id}`,
    question: `${id}?`,
    context: 'context',
    sources: [SOURCE],
    answer: 'answer',
    human: {
      faithful,
      ...(responseBehavior ? { responseBehavior } : {}),
      ...(policy ? { policy } : {}),
      note: 'human note',
    },
  };
}

function vote(
  faithful: boolean,
  policy?: JudgeVote['policy'],
  responseBehavior: NonNullable<JudgeVote['responseBehavior']> = 'answer',
): JudgeVote {
  return {
    faithful,
    responseBehavior,
    unsupported: faithful ? [] : ['unsupported'],
    reason: faithful ? 'faithful' : 'unsupported',
    ...(policy ? { policy } : {}),
  };
}

function valid(
  faithful: boolean,
  policy?: JudgeVote['policy'],
  responseBehavior: NonNullable<JudgeVote['responseBehavior']> = 'answer',
): JudgeAttempt {
  return {
    status: 'valid',
    vote: vote(faithful, policy, responseBehavior),
  };
}

function invalid(reason = 'invalid vote'): JudgeAttempt {
  return { status: 'invalid', code: 'invalid_vote', reason };
}

function requestError(message = 'request failed'): JudgeAttempt {
  return { status: 'error', stage: 'judge_request', message };
}

console.log('judge-eval:');

check('calibration preflight rejects malformed labels and missing snapshots', () => {
  assert.equal(
    decodeJudgeCalibrationLabels([
      {
        id: 'case-a',
        sourceFaithRunId: 'faith-run-1',
        category: 'faithful',
        human: { faithful: true, note: 'reviewed' },
      },
    ]).length,
    1,
  );
  assert.equal(
    decodeJudgeCalibrationLabels([
      {
        id: 'case-a',
        sourceFaithRunId: 'faith-run-1',
        category: 'correct_refusal',
        human: {
          faithful: true,
          responseBehavior: 'refusal',
          note: 'reviewed',
        },
      },
    ])[0]?.human.responseBehavior,
    'refusal',
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationLabels([
        {
          id: 'case-a',
          sourceFaithRunId: 'faith-run-1',
          category: 'faithful',
          human: { faithful: 'true', note: 'reviewed' },
        },
      ]),
    /faithful/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationLabels([
        {
          id: 'case-a',
          sourceFaithRunId: 'faith-run-1',
          category: 'faithful',
          human: { faithful: true },
        },
      ]),
    /note/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationCases([
        { ...calibrationCase('case-a', true), answer: '' },
      ]),
    /answer/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationCases([
        { ...calibrationCase('case-a', true), sourceFaithTraceId: '' },
      ]),
    /sourceFaithTraceId/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationCases([
        { ...calibrationCase('case-a', true), sources: [] },
      ]),
    /sources/i,
  );
  const { governance: _governance, ...withoutGovernance } = calibrationCase(
    'case-a',
    true,
  );
  assert.throws(
    () => decodeJudgeCalibrationCases([withoutGovernance]),
    /governance/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationCases([
        calibrationCase('case-a', true),
        calibrationCase('case-a', false),
      ]),
    /duplicate calibration case id/i,
  );
  assert.throws(
    () =>
      parseJudgeCalibrationLabelsJsonl(
        '{"id":"case-a","sourceFaithRunId":"faith-run-1","category":"faithful","human":{"faithful":true,"note":"reviewed"}}\n{bad json}\n',
      ),
    /line 2/i,
  );
});

check('trace records planned, valid, invalid, error attempts and lineage', () => {
  const attempts = [
    valid(true),
    valid(true),
    valid(false),
    invalid(),
    requestError(),
  ];
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('case-a', true),
    attempts,
    plannedVotes: 5,
  });

  assert.equal(trace.sourceFaithRunId, 'faith-run-1');
  assert.equal(trace.sourceFaithTraceId, 'faith-trace-case-a');
  assert.deepEqual(trace.governance, GOVERNANCE);
  assert.deepEqual(trace.attempts, {
    planned: 5,
    executed: 5,
    valid: 3,
    invalid: 1,
    error: 1,
    items: attempts,
  });
  assert.deepEqual(trace.majority, {
    faithful: true,
    quorum: 3,
    trueVotes: 2,
    falseVotes: 1,
    validVotes: 3,
    reachedQuorum: true,
    indeterminateReason: null,
    unstable: true,
    agree: true,
  });
  const { governance: _governance, ...withoutGovernance } = trace;
  assert.throws(
    () => decodeJudgeCalibrationTrace(withoutGovernance),
    /governance/i,
  );
});

check('disagreement diagnostics select a reason from the judge majority', () => {
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('case-a', false),
    attempts: [valid(true), valid(true), valid(false)],
    plannedVotes: 3,
  });
  assert.equal(trace.majority.faithful, true);
  assert.equal(trace.majority.agree, false);
  assert.equal(judgeReasonForMajority(trace), 'faithful');
});

check('1/5, 2/5, and a 2:2 tie remain indeterminate', () => {
  const traces = [];
  for (const [id, attempts, reason] of [
    [
      'one-valid',
      [valid(false), invalid(), invalid(), requestError(), requestError()],
      'insufficient_valid_votes',
    ],
    [
      'two-valid',
      [valid(false), valid(false), invalid(), requestError(), requestError()],
      'insufficient_valid_votes',
    ],
    [
      'tie',
      [valid(true), valid(true), valid(false), valid(false), invalid()],
      'tie',
    ],
  ] as const) {
    const trace = buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase(id, false),
      attempts,
      plannedVotes: 5,
    });
    assert.equal(trace.majority.faithful, null);
    assert.equal(trace.majority.agree, null);
    assert.equal(trace.majority.indeterminateReason, reason);
    traces.push(trace);
  }

  const record = judgeMetricsRecord(computeJudgeCalibrationMetrics(traces));
  assert.deepEqual(
    record['judge.agreement_rate'],
    metricObservation(null, 0, 0),
  );
  assert.deepEqual(record['judge.indeterminate'], metricObservation(3));
  assert.deepEqual(record['judge.attempt.invalid'], metricObservation(4));
  assert.deepEqual(record['judge.attempt.error'], metricObservation(4));
});

check('each explicitly labeled policy dimension reaches quorum independently', () => {
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('policy', true, {
      distinguished: true,
      conflictExplained: false,
      misstatedAsOfficial: false,
    }),
    plannedVotes: 5,
    attempts: [
      valid(true, {
        distinguished: true,
        conflictExplained: false,
        misstatedAsOfficial: true,
      }),
      valid(true, {
        distinguished: false,
        conflictExplained: false,
        misstatedAsOfficial: true,
      }),
      valid(true, {
        distinguished: true,
        misstatedAsOfficial: false,
      }),
      valid(true, { misstatedAsOfficial: false }),
      valid(true),
    ],
  });

  assert.deepEqual(trace.policy.distinguished, {
    human: true,
    judge: true,
    quorum: 3,
    trueVotes: 2,
    falseVotes: 1,
    validVotes: 3,
    reachedQuorum: true,
    indeterminateReason: null,
    unstable: true,
    agree: true,
  });
  assert.equal(trace.policy.conflictExplained?.judge, null);
  assert.equal(
    trace.policy.conflictExplained?.indeterminateReason,
    'insufficient_valid_votes',
  );
  assert.equal(trace.policy.misstatedAsOfficial?.judge, null);
  assert.equal(trace.policy.misstatedAsOfficial?.indeterminateReason, 'tie');
});

check('response behavior is calibrated only when humans label it explicitly', () => {
  const unlabeled = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('unlabeled-behavior', true),
    plannedVotes: 5,
    attempts: Array.from({ length: 5 }, () => valid(true)),
  });
  assert.equal(unlabeled.responseBehavior, undefined);

  const labeled = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase(
      'labeled-behavior',
      true,
      undefined,
      'refusal',
    ),
    plannedVotes: 5,
    attempts: [
      valid(true, undefined, 'refusal'),
      valid(true, undefined, 'refusal'),
      valid(true, undefined, 'answer'),
      valid(true, undefined, 'refusal'),
      invalid(),
    ],
  });
  assert.deepEqual(labeled.responseBehavior, {
    human: 'refusal',
    judge: 'refusal',
    quorum: 3,
    answerVotes: 1,
    refusalVotes: 3,
    nonAnswerVotes: 0,
    validVotes: 4,
    reachedQuorum: true,
    indeterminateReason: null,
    unstable: true,
    agree: true,
  });

  const metrics = computeJudgeCalibrationMetrics([unlabeled, labeled]);
  assert.deepEqual(metrics.responseBehavior, {
    total: 1,
    agree: 1,
    indeterminate: 0,
    unstable: 1,
    judged: 1,
    agreementRate: 1,
  });
});

check('trace decoder rejects inconsistent counts, labels, and quorum', () => {
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('policy-trace', true, {
      distinguished: true,
    }),
    plannedVotes: 5,
    attempts: [
      valid(true, { distinguished: true }),
      valid(true, { distinguished: true }),
      valid(true, { distinguished: false }),
      invalid(),
      requestError(),
    ],
  });

  assert.throws(
    () =>
      decodeJudgeCalibrationTrace({
        ...trace,
        attempts: { ...trace.attempts, valid: 4 },
      }),
    /attempt counts|valid vote count/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationTrace({
        ...trace,
        majority: {
          ...trace.majority,
          trueVotes: 2,
          falseVotes: 1,
          unstable: true,
        },
      }),
    /faithful quorum diagnostics/i,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationTrace({
        ...trace,
        human: { ...trace.human, policy: undefined },
      }),
    /policy result requires an explicit human label/i,
  );
  assert.throws(
    () =>
      buildJudgeCalibrationTrace({
        calibrationCase: calibrationCase('bad-quorum', true),
        plannedVotes: 2,
        quorum: 3,
        attempts: [valid(true), valid(true)],
      }),
    /quorum.*planned votes/i,
  );
});

check('metrics exclude indeterminate cases and retain attempt diagnostics', () => {
  const traces = [
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('agree', true),
      plannedVotes: 5,
      attempts: Array.from({ length: 5 }, () => valid(true)),
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('disagree', true),
      plannedVotes: 5,
      attempts: [valid(false), valid(false), valid(false), invalid(), requestError()],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('insufficient', false),
      plannedVotes: 5,
      attempts: [valid(false), valid(false), invalid(), requestError(), requestError()],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('tie', false),
      plannedVotes: 5,
      attempts: [valid(true), valid(true), valid(false), valid(false), invalid()],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('policy', true, {
        distinguished: true,
      }),
      plannedVotes: 5,
      attempts: [
        valid(true, { distinguished: true }),
        valid(true, { distinguished: false }),
        valid(true, { distinguished: true }),
        valid(true),
        valid(true),
      ],
    }),
  ];

  const metrics = computeJudgeCalibrationMetrics(traces);
  assert.equal(metrics.judged, 3);
  assert.equal(metrics.agree, 2);
  assert.equal(metrics.judgeFailed, 2);
  assert.equal(metrics.agreementRate, 2 / 3);
  assert.deepEqual(metrics.attempts, {
    planned: 25,
    executed: 25,
    valid: 19,
    invalid: 3,
    error: 3,
  });
  assert.equal(metrics.policy.distinguished.total, 1);
  assert.equal(metrics.policy.distinguished.judged, 1);
  assert.equal(metrics.policy.distinguished.agree, 1);
  assert.equal(metrics.policy.distinguished.unstable, 1);
  assert.equal(metrics.policy.distinguished.indeterminate, 0);
  assert.equal(metrics.policy.distinguished.agreementRate, 1);
  assert.deepEqual(metrics.responseBehavior, {
    total: 0,
    agree: 0,
    indeterminate: 0,
    unstable: 0,
    judged: 0,
    agreementRate: null,
  });

  const record = judgeMetricsRecord(metrics);
  assert.deepEqual(record['judge.agreement_rate'], metricObservation(2 / 3, 2, 3));
  assert.deepEqual(record['judge.indeterminate'], metricObservation(2));
  assert.deepEqual(record['judge.attempt.planned'], metricObservation(25));
  assert.deepEqual(record['judge.attempt.valid'], metricObservation(19));
  assert.deepEqual(record['judge.attempt.invalid'], metricObservation(3));
  assert.deepEqual(record['judge.attempt.error'], metricObservation(3));
  assert.deepEqual(
    record['judge.response_behavior.agreement_rate'],
    metricObservation(null, 0, 0),
  );
});

console.log(`\n通过 ${passed} 项`);

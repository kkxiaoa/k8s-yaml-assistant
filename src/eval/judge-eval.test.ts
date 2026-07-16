import assert from 'node:assert/strict';
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

function calibrationCase(
  id: string,
  faithful: boolean,
  policy?: JudgeCalibrationCase['human']['policy'],
): JudgeCalibrationCase {
  return {
    id,
    category: 'faithful',
    sourceFaithRunId: 'faith-run-1',
    sourceFaithTraceId: `faith-trace-${id}`,
    question: `${id}?`,
    context: 'context',
    sources: [SOURCE],
    answer: 'answer',
    human: {
      faithful,
      ...(policy ? { policy } : {}),
      note: 'human note',
    },
  };
}

function vote(
  faithful: boolean,
  policy?: JudgeVote['policy'],
): JudgeVote {
  return {
    faithful,
    unsupported: faithful ? [] : ['unsupported'],
    reason: faithful ? 'faithful' : 'unsupported',
    ...(policy ? { policy } : {}),
  };
}

function valid(
  faithful: boolean,
  policy?: JudgeVote['policy'],
): JudgeAttempt {
  return { status: 'valid', vote: vote(faithful, policy) };
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
        category: 'faithful',
        human: { faithful: true, note: 'reviewed' },
      },
    ]).length,
    1,
  );
  assert.throws(
    () =>
      decodeJudgeCalibrationLabels([
        {
          id: 'case-a',
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
        '{"id":"case-a","category":"faithful","human":{"faithful":true,"note":"reviewed"}}\n{bad json}\n',
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
});

check('1/5, 2/5, and a 2:2 tie remain indeterminate', () => {
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
  }
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

  const record = judgeMetricsRecord(metrics);
  assert.deepEqual(record['judge.agreement_rate'], metricObservation(2 / 3, 2, 3));
  assert.deepEqual(record['judge.failed'], metricObservation(2));
  assert.deepEqual(record['judge.attempt.planned'], metricObservation(25));
  assert.deepEqual(record['judge.attempt.valid'], metricObservation(19));
  assert.deepEqual(record['judge.attempt.invalid'], metricObservation(3));
  assert.deepEqual(record['judge.attempt.error'], metricObservation(3));
});

console.log(`\n通过 ${passed} 项`);

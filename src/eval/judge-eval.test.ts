import assert from 'node:assert/strict';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationMetrics,
  judgeMetricsRecord,
  type JudgeCalibrationCase,
  type JudgeVote,
} from './metrics/judge-metrics';
import { metricObservation } from './protocol';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

function calibrationCase(
  id: string,
  faithful: boolean,
  policy?: JudgeCalibrationCase['human']['policy'],
): JudgeCalibrationCase {
  return {
    id,
    category: 'test',
    question: `${id}?`,
    context: 'context',
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

console.log('judge-eval:');

check('buildJudgeCalibrationTrace 计算 faithful 多数与不稳定标记', () => {
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('case-a', true),
    votes: [vote(true), vote(true), vote(false)],
  });

  assert.equal(trace.majority.faithful, true);
  assert.equal(trace.majority.trueVotes, 2);
  assert.equal(trace.majority.totalVotes, 3);
  assert.equal(trace.majority.unstable, true);
  assert.equal(trace.majority.agree, true);
});

check('policy 维度统计 missing / disagree / unstable', () => {
  const trace = buildJudgeCalibrationTrace({
    calibrationCase: calibrationCase('policy-a', true, {
      distinguished: true,
      conflictExplained: false,
      misstatedAsOfficial: false,
    }),
    votes: [
      vote(true, { distinguished: true, conflictExplained: true }),
      vote(true, { distinguished: false, conflictExplained: true }),
      vote(true, { distinguished: true, conflictExplained: true }),
    ],
  });

  assert.deepEqual(trace.policy.distinguished, {
    human: true,
    judge: true,
    trueVotes: 2,
    totalVotes: 3,
    missing: false,
    unstable: true,
    agree: true,
  });
  assert.deepEqual(trace.policy.conflictExplained, {
    human: false,
    judge: true,
    trueVotes: 3,
    totalVotes: 3,
    missing: false,
    unstable: false,
    agree: false,
  });
  assert.deepEqual(trace.policy.misstatedAsOfficial, {
    human: false,
    judge: null,
    trueVotes: 0,
    totalVotes: 0,
    missing: true,
    unstable: false,
    agree: false,
  });
});

check('computeJudgeCalibrationMetrics 汇总 faithful 与 policy 指标', () => {
  const traces = [
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('agree', true),
      votes: [vote(true), vote(true), vote(true)],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('disagree', true),
      votes: [vote(false), vote(false), vote(true)],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('failed', false),
      votes: [],
    }),
    buildJudgeCalibrationTrace({
      calibrationCase: calibrationCase('policy', true, {
        distinguished: true,
      }),
      votes: [
        vote(true, { distinguished: true }),
        vote(true, { distinguished: false }),
        vote(true, { distinguished: true }),
      ],
    }),
  ];

  const metrics = computeJudgeCalibrationMetrics(traces);

  assert.equal(metrics.judged, 3);
  assert.equal(metrics.agree, 2);
  assert.equal(metrics.judgeFailed, 1);
  assert.equal(metrics.unstableCount, 1);
  assert.equal(metrics.agreementRate, 2 / 3);
  assert.equal(metrics.policy.distinguished.total, 1);
  assert.equal(metrics.policy.distinguished.judged, 1);
  assert.equal(metrics.policy.distinguished.agree, 1);
  assert.equal(metrics.policy.distinguished.unstable, 1);
  assert.equal(metrics.policy.distinguished.agreementRate, 1);

  assert.deepEqual(judgeMetricsRecord(metrics), {
    'judge.agree': metricObservation(2),
    'judge.agreement_rate': metricObservation(2 / 3, 2, 3),
    'judge.failed': metricObservation(1),
    'judge.judged': metricObservation(3),
    'judge.policy.conflictExplained.agree': metricObservation(0),
    'judge.policy.conflictExplained.agreement_rate': metricObservation(
      null,
      0,
      0,
    ),
    'judge.policy.conflictExplained.judged': metricObservation(0),
    'judge.policy.conflictExplained.missing': metricObservation(0),
    'judge.policy.conflictExplained.unstable': metricObservation(0),
    'judge.policy.distinguished.agree': metricObservation(1),
    'judge.policy.distinguished.agreement_rate': metricObservation(1, 1, 1),
    'judge.policy.distinguished.judged': metricObservation(1),
    'judge.policy.distinguished.missing': metricObservation(0),
    'judge.policy.distinguished.unstable': metricObservation(1),
    'judge.policy.misstatedAsOfficial.agree': metricObservation(0),
    'judge.policy.misstatedAsOfficial.agreement_rate': metricObservation(
      null,
      0,
      0,
    ),
    'judge.policy.misstatedAsOfficial.judged': metricObservation(0),
    'judge.policy.misstatedAsOfficial.missing': metricObservation(0),
    'judge.policy.misstatedAsOfficial.unstable': metricObservation(0),
    'judge.unstable': metricObservation(1),
  });
});

console.log(`\n通过 ${passed} 项`);

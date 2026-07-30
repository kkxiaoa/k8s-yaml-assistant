import assert from 'node:assert/strict';
import { preflightFixCases } from './assertions';
import { FIX_CASES } from './cases/fix-cases';
import type { GenerationEvalCase } from './cases/generation-cases';
import {
  buildFixCaseResult,
  buildGenerationCaseResult,
  computeFixEvalMetrics,
  computeGenerationEvalMetrics,
  fixMetricsRecord,
  generationMetricsRecord,
} from './metrics/generation-metrics';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationMetrics,
  judgeMetricsRecord,
  type JudgeCalibrationCase,
} from './metrics/judge-metrics';
import { METRIC_DEFINITIONS } from './metrics/definitions';
import { faithMetricsRecord, retrievalMetricsRecord } from './runner-protocol';
import { ratioObservation } from './protocol';
import {
  buildGovernanceReport,
  formatGovernanceCoverage,
  formatGovernanceReport,
  requireGovernanceMetric,
  type GovernanceDisplayMetric,
} from './governance-report';

const FIELD_DEVELOPMENT = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

const CASES = [
  { id: 'development-complete', governance: FIELD_DEVELOPMENT },
  {
    id: 'regression-complete',
    governance: {
      task: 'policy_explanation',
      origin: 'bad_case',
      role: 'regression',
    } as const,
  },
  {
    id: 'holdout-error',
    governance: {
      task: 'refusal',
      origin: 'schema_generated',
      role: 'holdout',
    } as const,
  },
];

interface PassResult {
  id: string;
  pass: boolean;
}

const RESULTS: PassResult[] = [
  { id: 'development-complete', pass: true },
  { id: 'regression-complete', pass: false },
];

function passMetric(results: readonly PassResult[]): GovernanceDisplayMetric[] {
  return [
    {
      label: 'pass',
      unit: 'ratio',
      observation: ratioObservation(
        results.filter((result) => result.pass).length,
        results.length,
      ),
    },
  ];
}

const report = buildGovernanceReport({
  cases: CASES,
  results: RESULTS,
  harnessErrors: [{ evalCaseId: 'holdout-error' }],
  resultCaseId: (result) => result.id,
  aggregate: passMetric,
});

for (const dimension of report.dimensions) {
  const selectedIds = dimension.buckets.flatMap(
    (bucket) => bucket.selectedCaseIds,
  );
  assert.deepEqual([...selectedIds].sort(), CASES.map((item) => item.id).sort());
  assert.equal(new Set(selectedIds).size, CASES.length);
  assert.equal(
    dimension.buckets.reduce((sum, bucket) => sum + bucket.selected, 0),
    3,
  );
  assert.equal(
    dimension.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    2,
  );
  assert.equal(
    dimension.buckets.reduce((sum, bucket) => sum + bucket.harnessError, 0),
    1,
  );
}

const role = report.dimensions.find((dimension) => dimension.dimension === 'role');
assert.ok(role);
assert.deepEqual(
  role.buckets.map((bucket) => [
    bucket.value,
    bucket.selected,
    bucket.completed,
    bucket.harnessError,
  ]),
  [
    ['development', 1, 1, 0],
    ['regression', 1, 1, 0],
    ['holdout', 1, 0, 1],
  ],
);

const formatted = formatGovernanceReport(report);
assert.match(
  formatted,
  /holdout: selected=1 completed=0 harness error=1 \| pass=N\/A \(0\/0\)/,
);
assert.doesNotMatch(formatted, /holdout:.*pass=0(?:\.0)?%/);

assert.throws(
  () =>
    buildGovernanceReport({
      cases: CASES,
      results: RESULTS,
      harnessErrors: [],
      resultCaseId: (result) => result.id,
      aggregate: passMetric,
    }),
  /selected.*completed.*harness|do not reconcile/i,
);
assert.throws(
  () =>
    buildGovernanceReport({
      cases: CASES,
      results: RESULTS,
      harnessErrors: [
        { evalCaseId: 'development-complete' },
        { evalCaseId: 'holdout-error' },
      ],
      resultCaseId: (result) => result.id,
      aggregate: passMetric,
    }),
  /both completed and harness error|overlap/i,
);

const coverage = formatGovernanceCoverage('fixture', CASES);
assert.match(coverage, /fixture/);
assert.match(coverage, /task:.*field_explanation=1.*missing=.*error_explanation/);
assert.match(coverage, /origin:.*human=1.*missing=/);
assert.match(coverage, /role:.*holdout=1/);

function retrievalMetrics(
  results: readonly { id: string; recall: number; reciprocalRank: number }[],
): GovernanceDisplayMetric[] {
  const metrics = retrievalMetricsRecord({
    recallNumerator: results.reduce((sum, result) => sum + result.recall, 0),
    mrrNumerator: results.reduce(
      (sum, result) => sum + result.reciprocalRank,
      0,
    ),
    caseCount: results.length,
    retrievalMissCount: 0,
    rerankMissCount: 0,
  });
  return [
    {
      label: 'Recall',
      unit: 'ratio',
      observation: metrics['retrieval.semantic.recall'],
    },
    {
      label: 'MRR',
      unit: 'ratio',
      observation: metrics['retrieval.semantic.mrr'],
    },
  ];
}

function faithMetrics(
  results: readonly { id: string; faithful: boolean | null; refusal: boolean }[],
): GovernanceDisplayMetric[] {
  const judged = results.filter((result) => result.faithful !== null);
  const refusals = judged.filter((result) => result.refusal);
  const metrics = faithMetricsRecord({
    faithfulCount: judged.filter((result) => result.faithful).length,
    judgedCount: judged.length,
    expectedBehaviorSatisfiedCount: judged.length,
    behaviorJudgedCount: judged.length,
    groundedSuccessCount: judged.filter((result) => result.faithful).length,
    refusedCorrectlyCount: refusals.filter((result) => result.faithful).length,
    refusalJudgedCount: refusals.length,
    unsupportedResponseCount: judged.filter((result) => !result.faithful)
      .length,
    behaviorMismatchCount: 0,
    retrievalIncompleteCount: 0,
    sourceIncompleteCount: 0,
    judgeIndeterminateCount: results.length - judged.length,
    judgeInvalidAttemptCount: 0,
    judgeErrorAttemptCount: 0,
    caseCount: results.length,
  });
  return [
    {
      label: 'faithful',
      unit: 'ratio',
      observation: metrics['faith.faithful_rate'],
    },
    {
      label: 'refusal',
      unit: 'ratio',
      observation: metrics['faith.refusal_correct_rate'],
    },
    {
      label: 'indeterminate',
      unit: 'count',
      observation: metrics['faith.judge_indeterminate'],
    },
  ];
}

const SOURCE = {
  n: 1,
  id: 'schema::v1::Pod::spec.field',
  title: 'Pod field',
  sourceType: 'schema' as const,
  provenance: { authority: 'cluster_api' as const, version: 'v1' },
  targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.field' }],
};
const calibrationCase: JudgeCalibrationCase = {
  id: 'judge-case',
  governance: FIELD_DEVELOPMENT,
  category: 'faithful',
  sourceFaithRunId: 'faith-run',
  sourceFaithTraceId: 'faith-run:judge-case',
  question: 'question',
  context: 'context',
  sources: [SOURCE],
  answer: 'answer',
  human: { faithful: true, note: 'supported' },
};
const judgeTrace = buildJudgeCalibrationTrace({
  calibrationCase,
  attempts: Array.from({ length: 3 }, () => ({
    status: 'valid' as const,
    vote: {
      faithful: true,
      unsupported: [],
      reason: 'supported',
    },
  })),
  plannedVotes: 3,
});

const attempt = {
  submitIndex: 1,
  yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo',
  parseOk: true,
  validationOk: true,
  errors: [],
};
const generationCase: GenerationEvalCase = {
  id: 'generation-case',
  governance: {
    task: 'generation',
    origin: 'human',
    role: 'development',
  },
  requirement: 'Create a ConfigMap',
  expectedResources: [
    {
      ref: 'config',
      identity: { apiVersion: 'v1', kind: 'ConfigMap', name: 'demo' },
      assertions: [{ type: 'equals', path: 'metadata.name', value: 'demo' }],
    },
  ],
  relations: [],
};
const generationResult = buildGenerationCaseResult(generationCase, {
  yaml: attempt.yaml,
  rounds: 0,
  attempts: [attempt],
  diagnostics: [],
});

const fixCase = FIX_CASES[0]!;
const fixFixture = preflightFixCases([fixCase])[0]!;
const failedAttempt = {
  submitIndex: 1,
  yaml: 'bad: [',
  parseOk: false,
  validationOk: false,
  errors: [{ path: '', message: 'YAML parse failed' }],
};
const fixResult = buildFixCaseResult(
  fixCase,
  {
    yaml: null,
    rounds: 2,
    attempts: [failedAttempt],
    diagnostics: [{ stage: 'repair', message: 'max rounds reached' }],
  },
  fixFixture,
);

const metricRegistryKeys = METRIC_DEFINITIONS.map((definition) => definition.key);
const metricReports = [
  buildGovernanceReport({
    cases: [{ id: 'retrieval-case', governance: FIELD_DEVELOPMENT }],
    results: [{ id: 'retrieval-case', recall: 1, reciprocalRank: 0.5 }],
    harnessErrors: [],
    resultCaseId: (result) => result.id,
    aggregate: retrievalMetrics,
  }),
  buildGovernanceReport({
    cases: [{ id: 'faith-case', governance: FIELD_DEVELOPMENT }],
    results: [{ id: 'faith-case', faithful: true, refusal: false }],
    harnessErrors: [],
    resultCaseId: (result) => result.id,
    aggregate: faithMetrics,
  }),
  buildGovernanceReport({
    cases: [{ id: judgeTrace.id, governance: FIELD_DEVELOPMENT }],
    results: [judgeTrace],
    harnessErrors: [],
    resultCaseId: (result) => result.id,
    aggregate: (results) => {
      const metrics = judgeMetricsRecord(computeJudgeCalibrationMetrics(results));
      return [
        {
          label: 'agreement',
          unit: 'ratio',
          observation: requireGovernanceMetric(
            metrics,
            'judge.agreement_rate',
          ),
        },
        {
          label: 'indeterminate',
          unit: 'count',
          observation: requireGovernanceMetric(metrics, 'judge.indeterminate'),
        },
      ];
    },
  }),
  buildGovernanceReport({
    cases: [{ id: generationResult.id, governance: FIELD_DEVELOPMENT }],
    results: [generationResult],
    harnessErrors: [],
    resultCaseId: (result) => result.id,
    aggregate: (results) => {
      const metrics = generationMetricsRecord(
        computeGenerationEvalMetrics([...results]),
      );
      return [
        {
          label: 'content',
          unit: 'ratio',
          observation: requireGovernanceMetric(
            metrics,
            'generation.content_pass_rate',
          ),
        },
      ];
    },
  }),
  buildGovernanceReport({
    cases: [{ id: fixResult.id, governance: FIELD_DEVELOPMENT }],
    results: [fixResult],
    harnessErrors: [],
    resultCaseId: (result) => result.id,
    aggregate: (results) => {
      const metrics = fixMetricsRecord(computeFixEvalMetrics([...results]));
      return [
        {
          label: 'content',
          unit: 'ratio',
          observation: requireGovernanceMetric(metrics, 'fix.success_rate'),
        },
        {
          label: 'correction',
          unit: 'ratio',
          observation: requireGovernanceMetric(
            metrics,
            'fix.expected_correction_pass_rate',
          ),
        },
        {
          label: 'preserve',
          unit: 'ratio',
          observation: requireGovernanceMetric(
            metrics,
            'fix.preserve_pass_rate',
          ),
        },
        {
          label: 'side-effect',
          unit: 'ratio',
          observation: requireGovernanceMetric(
            metrics,
            'fix.side_effect_free_pass_rate',
          ),
        },
      ];
    },
  }),
];

for (const metricReport of metricReports) {
  assert.equal(metricReport.dimensions.length, 3);
  assert.ok(
    metricReport.dimensions.every((dimension) =>
      dimension.buckets.every((bucket) => bucket.metrics.length > 0),
    ),
  );
}
assert.deepEqual(
  METRIC_DEFINITIONS.map((definition) => definition.key),
  metricRegistryKeys,
);

console.log('governance report: ok');

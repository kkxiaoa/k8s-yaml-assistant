import assert from 'node:assert/strict';
import {
  EVAL_SCHEMA_VERSION,
  metricObservation,
  ratioObservation,
  type EvalBaseline,
  type EvalRun,
} from '../protocol';
import { METRIC_DEFINITION_VERSION } from './definitions';
import {
  compareEvalArtifacts,
  compareMetricRecords,
  type EvalMetricComparison,
} from './compare';

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

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function retrievalMetrics() {
  return {
    'retrieval.semantic.recall': ratioObservation(9, 10),
    'retrieval.semantic.mrr': ratioObservation(8, 10),
    'retrieval.semantic.case_count': metricObservation(10),
    'retrieval.retrieval_miss_count': metricObservation(1),
    'retrieval.rerank_miss_count': metricObservation(0),
    'retrieval.harness_error_count': metricObservation(0),
  };
}

function retrievalRun(): Extract<EvalRun, { kind: 'retrieval' }> {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: 'current-run',
    kind: 'retrieval',
    status: 'completed',
    scope: 'full',
    createdAt: '2026-07-16T00:00:00.000Z',
    completedAt: '2026-07-16T00:01:00.000Z',
    dataset: {
      id: 'retrieval/semantic',
      hash: HASH_A,
      cases: [
        { id: 'case-1', governance: GOVERNANCE },
        { id: 'case-2', governance: GOVERNANCE },
      ],
      caseCount: 2,
    },
    artifactPaths: { trace: 'traces/current-run.retrieval.jsonl' },
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    config: {
      corpusManifestHash: HASH_B,
      indexHash: HASH_B,
      embeddingModel: 'embedding-current',
      rerankModel: 'rerank-current',
      queryExpansion: {
        enabled: true,
        registryHash: HASH_C,
        reviewedAliasCount: 3,
      },
      k: 3,
    },
    metrics: retrievalMetrics(),
  };
}

function retrievalBaseline(): Extract<EvalBaseline, { kind: 'retrieval' }> {
  const run = retrievalRun();
  return {
    schemaVersion: run.schemaVersion,
    sourceRunId: 'baseline-run',
    promotedAt: '2026-07-15T00:00:00.000Z',
    kind: run.kind,
    scope: run.scope,
    dataset: run.dataset,
    metricDefinitionVersion: run.metricDefinitionVersion,
    config: {
      ...run.config,
      corpusManifestHash: HASH_A,
      indexHash: HASH_A,
      embeddingModel: 'embedding-baseline',
      rerankModel: 'rerank-baseline',
      queryExpansion: {
        enabled: false,
        registryHash: null,
        reviewedAliasCount: 0,
      },
    },
    metrics: retrievalMetrics(),
  };
}

function generationBaseline(): Extract<EvalBaseline, { kind: 'generation' }> {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    sourceRunId: 'generation-baseline',
    promotedAt: '2026-07-15T00:00:00.000Z',
    kind: 'generation',
    scope: 'full',
    dataset: {
      id: 'generation/full',
      hash: HASH_A,
      cases: [{ id: 'case-1', governance: GOVERNANCE }],
      caseCount: 1,
    },
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    config: {
      answerModel: 'answer-model',
      systemPromptHash: HASH_A,
      toolSchemaIdentity: 'tool-v1',
      validationSchemaIdentity: 'validation-v1',
    },
    metrics: {},
  };
}

function metric(
  result: Pick<EvalMetricComparison, 'comparisons'>,
  key: string,
) {
  const found = result.comparisons.find((item) => item.key === key);
  assert.ok(found, `missing comparison for ${key}`);
  return found;
}

console.log('metric-compare:');

check('lower-is-better metrics improve when they decrease', () => {
  const faith = compareMetricRecords(
    'faith',
    { 'faith.hallucination': metricObservation(1) },
    { 'faith.hallucination': metricObservation(2) },
  );
  assert.deepEqual(metric(faith, 'faith.hallucination'), {
    key: 'faith.hallucination',
    current: metricObservation(1),
    baseline: metricObservation(2),
    delta: -1,
    verdict: 'improved',
  });

  const generation = compareMetricRecords(
    'generation',
    { 'generation.max_round_failure_rate': ratioObservation(1, 10) },
    { 'generation.max_round_failure_rate': ratioObservation(2, 10) },
  );
  assert.equal(
    metric(generation, 'generation.max_round_failure_rate').verdict,
    'improved',
  );
});

check('higher-is-better metrics regress when they decrease', () => {
  const result = compareMetricRecords(
    'retrieval',
    { 'retrieval.semantic.recall': ratioObservation(89, 100) },
    { 'retrieval.semantic.recall': ratioObservation(90, 100) },
  );
  const recall = metric(result, 'retrieval.semantic.recall');
  assert.ok(recall.delta !== null && Math.abs(recall.delta + 0.01) < 1e-12);
  assert.equal(recall.verdict, 'regressed');
});

check('neutral metrics retain delta without a quality verdict', () => {
  const result = compareMetricRecords(
    'generation',
    { 'generation.avg_rounds': ratioObservation(3, 2) },
    { 'generation.avg_rounds': ratioObservation(2, 2) },
  );
  assert.deepEqual(metric(result, 'generation.avg_rounds'), {
    key: 'generation.avg_rounds',
    current: ratioObservation(3, 2),
    baseline: ratioObservation(2, 2),
    delta: 0.5,
    verdict: 'neutral',
  });
});

check('N/A on either side is explicitly not comparable', () => {
  const result = compareMetricRecords(
    'faith',
    { 'faith.faithful_rate': ratioObservation(0, 0) },
    { 'faith.faithful_rate': ratioObservation(1, 1) },
  );
  assert.deepEqual(metric(result, 'faith.faithful_rate'), {
    key: 'faith.faithful_rate',
    current: ratioObservation(0, 0),
    baseline: ratioObservation(1, 1),
    delta: null,
    verdict: 'not_comparable',
    reason: 'current_na',
  });
});

check('comparison identity rejects kind, dataset, version, and retrieval k changes', () => {
  const current = retrievalRun();
  const baseline = retrievalBaseline();
  const cases: Array<[EvalBaseline, string]> = [
    [generationBaseline(), 'kind_mismatch'],
    [
      { ...baseline, dataset: { ...baseline.dataset, id: 'other-dataset' } },
      'dataset_id_mismatch',
    ],
    [
      { ...baseline, dataset: { ...baseline.dataset, hash: HASH_C } },
      'dataset_hash_mismatch',
    ],
    [
      {
        ...baseline,
        dataset: {
          ...baseline.dataset,
          cases: [{ id: 'case-1', governance: GOVERNANCE }],
          caseCount: 1,
        },
      },
      'dataset_case_count_mismatch',
    ],
    [
      { ...baseline, metricDefinitionVersion: 'different-version' },
      'metric_definition_version_mismatch',
    ],
    [{ ...baseline, config: { ...baseline.config, k: 5 } }, 'retrieval_k_mismatch'],
  ];

  for (const [candidate, code] of cases) {
    const result = compareEvalArtifacts(current, candidate);
    assert.equal(result.compatible, false, code);
    assert.ok(result.identityIssues.some((issue) => issue.code === code), code);
    assert.ok(
      result.comparisons.every(
        (comparison) => comparison.verdict === 'not_comparable',
      ),
      code,
    );
  }
});

check('system config changes remain comparable and are listed as experiment variables', () => {
  const result = compareEvalArtifacts(retrievalRun(), retrievalBaseline());
  assert.equal(result.compatible, true);
  const paths = result.experimentChanges.map((change) => change.path);
  for (const path of [
    'config.corpusManifestHash',
    'config.indexHash',
    'config.embeddingModel',
    'config.rerankModel',
    'config.queryExpansion.enabled',
    'config.queryExpansion.registryHash',
    'config.queryExpansion.reviewedAliasCount',
  ]) {
    assert.ok(paths.includes(path), path);
  }
  assert.equal(paths.includes('config.k'), false);
});

check('a shared historical definition version is unsupported by the current registry', () => {
  const current = {
    ...retrievalRun(),
    metricDefinitionVersion: 'historical-version',
  };
  const baseline = {
    ...retrievalBaseline(),
    metricDefinitionVersion: 'historical-version',
  };
  const result = compareEvalArtifacts(current, baseline);

  assert.equal(result.compatible, false);
  assert.ok(
    result.identityIssues.some(
      (issue) =>
        issue.code === 'unsupported_metric_definition_version' &&
        issue.expected === METRIC_DEFINITION_VERSION,
    ),
  );
});

check('missing required metrics block comparison completeness', () => {
  const current = retrievalRun();
  const { ['retrieval.semantic.recall']: _missing, ...metrics } =
    current.metrics;
  const result = compareEvalArtifacts(
    { ...current, metrics },
    retrievalBaseline(),
  );

  assert.equal(result.hasBlockingHarnessGap, true);
  assert.deepEqual(result.requiredGaps, [
    { key: 'retrieval.semantic.recall', missingFrom: 'current' },
  ]);
});

check('missing diagnostic metrics are reported without blocking', () => {
  const current = retrievalRun();
  const { ['retrieval.rerank_miss_count']: _missing, ...metrics } =
    current.metrics;
  const result = compareEvalArtifacts(
    { ...current, metrics },
    retrievalBaseline(),
  );

  assert.equal(result.hasBlockingHarnessGap, false);
  assert.deepEqual(result.diagnosticGaps, [
    { key: 'retrieval.rerank_miss_count', missingFrom: 'current' },
  ]);
});

console.log(`\n通过 ${passed} 项`);

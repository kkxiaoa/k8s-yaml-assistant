import assert from 'node:assert/strict';
import {
  EVAL_CASE_ERROR_STAGES,
  EVAL_RUN_FATAL_STAGES,
  EVAL_SCHEMA_VERSION,
  computeDatasetHash,
  decodeEvalBaseline,
  decodeEvalRun,
  decodeTraceEnvelope,
  metricObservation,
  ratioObservation,
} from './protocol';

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

function omit(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const result = { ...value };
  delete result[key];
  return result;
}

const CREATED_AT = '2026-07-12T01:00:00.000Z';
const COMPLETED_AT = '2026-07-12T01:01:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function datasetCases(...ids: string[]) {
  return ids.map((id) => ({ id, governance: GOVERNANCE }));
}

const RETRIEVAL_CONFIG = {
  corpusManifestHash: HASH_D,
  indexHash: HASH_B,
  embeddingModel: 'voyage-4',
  rerankModel: 'rerank-2.5',
  queryExpansion: {
    enabled: true,
    registryHash: HASH_C,
    reviewedAliasCount: 12,
  },
  k: 3,
};

const FAITH_CONFIG = {
  ...RETRIEVAL_CONFIG,
  answerModel: 'deepseek-chat',
  judgeModel: 'deepseek-reasoner',
  answerPromptHash: HASH_C,
  judgePromptHash: HASH_D,
  judgeParserSchemaIdentity: 'judge-parser-v1',
  judgeAttemptLimit: 2,
};

const JUDGE_CONFIG = {
  judgeModel: 'deepseek-reasoner',
  voteCount: 5,
  promptHash: HASH_C,
  parserSchemaIdentity: 'judge-parser-v1',
};

const GENERATION_CONFIG = {
  answerModel: 'deepseek-chat',
  systemPromptHash: HASH_B,
  toolSchemaIdentity: 'submit-yaml-v1',
  validationSchemaIdentity: 'k8s-schema-validation-v1',
};

function runFixture(
  kind: 'retrieval' | 'faith' | 'judge' | 'generation' | 'fix' =
    'retrieval',
): Record<string, unknown> {
  const config =
    kind === 'retrieval'
      ? RETRIEVAL_CONFIG
      : kind === 'faith'
        ? FAITH_CONFIG
        : kind === 'judge'
          ? JUDGE_CONFIG
          : GENERATION_CONFIG;

  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: `run-${kind}`,
    kind,
    status: 'completed',
    scope: kind === 'judge' ? 'calibration' : 'full',
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    dataset: {
      id: `${kind}-cases`,
      hash: HASH_A,
      cases: datasetCases('case-a', 'case-b'),
      caseCount: 2,
    },
    artifactPaths: { trace: `traces/run-${kind}.${kind}.jsonl` },
    metricDefinitionVersion: 'legacy-v1',
    metrics: {
      'example.rate': { value: 0.5, numerator: 1, denominator: 2 },
    },
    config,
  };
}

function baselineFixture(
  kind: 'retrieval' | 'faith' | 'judge' | 'generation' | 'fix' =
    'retrieval',
): Record<string, unknown> {
  const run = runFixture(kind);
  return {
    schemaVersion: run.schemaVersion,
    sourceRunId: run.id,
    promotedAt: COMPLETED_AT,
    kind: run.kind,
    scope: run.scope,
    dataset: run.dataset,
    metricDefinitionVersion: run.metricDefinitionVersion,
    metrics: run.metrics,
    config: run.config,
  };
}

function traceFixture(): Record<string, unknown> {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    traceId: 'trace-1',
    runId: 'run-retrieval',
    evalCaseId: 'case-a',
    governance: GOVERNANCE,
    kind: 'retrieval',
    createdAt: CREATED_AT,
    outcome: 'success',
    payload: { rank: 1 },
  };
}

console.log('eval-protocol:');

check('all EvalRun variants decode through the kind discriminant', () => {
  for (const kind of [
    'retrieval',
    'faith',
    'judge',
    'generation',
    'fix',
  ] as const) {
    assert.equal(decodeEvalRun(runFixture(kind)).kind, kind);
  }
});

check('EvalRun rejects every required common field when absent', () => {
  for (const field of [
    'schemaVersion',
    'id',
    'kind',
    'status',
    'scope',
    'createdAt',
    'dataset',
    'artifactPaths',
    'metricDefinitionVersion',
    'metrics',
    'config',
  ]) {
    assert.throws(() => decodeEvalRun(omit(runFixture(), field)), field);
  }
  const withoutTrace = {
    ...runFixture(),
    artifactPaths: {},
  };
  assert.throws(() => decodeEvalRun(withoutTrace), 'artifactPaths.trace');
});

check('dataset identity requires governance and rejects duplicate IDs or count mismatch', () => {
  const missingHash = {
    ...runFixture(),
    dataset: omit(runFixture().dataset as Record<string, unknown>, 'hash'),
  };
  assert.throws(() => decodeEvalRun(missingHash), 'missing dataset hash');

  const missingGovernance = {
    ...runFixture(),
    dataset: {
      id: 'retrieval-cases',
      hash: HASH_A,
      cases: [{ id: 'case-a' }],
      caseCount: 1,
    },
  };
  assert.throws(() => decodeEvalRun(missingGovernance), 'missing governance');

  const duplicateIds = {
    ...runFixture(),
    dataset: {
      id: 'retrieval-cases',
      hash: HASH_A,
      cases: datasetCases('case-a', 'case-a'),
      caseCount: 2,
    },
  };
  assert.throws(() => decodeEvalRun(duplicateIds), 'duplicate case IDs');

  const wrongCount = {
    ...runFixture(),
    dataset: {
      id: 'retrieval-cases',
      hash: HASH_A,
      cases: datasetCases('case-a', 'case-b'),
      caseCount: 1,
    },
  };
  assert.throws(() => decodeEvalRun(wrongCount), 'caseCount mismatch');
});

check('dataset hash is stable across case and object-key order', () => {
  const first = [
    { id: 'a', question: 'q-a', expected: { kind: 'Pod', paths: ['a', 'b'] } },
    { id: 'b', question: 'q-b', expected: { kind: 'Service', paths: ['c'] } },
  ];
  const reordered = [
    { question: 'q-b', expected: { paths: ['c'], kind: 'Service' }, id: 'b' },
    { expected: { paths: ['a', 'b'], kind: 'Pod' }, question: 'q-a', id: 'a' },
  ];

  assert.equal(computeDatasetHash(first), computeDatasetHash(reordered));
});

check('dataset hash changes when case semantics change but IDs do not', () => {
  const before = [{ id: 'a', question: 'what is spec.replicas?', expected: 3 }];
  const after = [{ id: 'a', question: 'what is spec.replicas?', expected: 5 }];
  const idsOnly = [{ id: 'a' }];
  const pathsReordered = [
    { id: 'a', question: 'what is spec.replicas?', paths: ['b', 'a'] },
  ];

  assert.notEqual(computeDatasetHash(before), computeDatasetHash(after));
  assert.notEqual(computeDatasetHash(before), computeDatasetHash(idsOnly));
  assert.notEqual(
    computeDatasetHash([
      { id: 'a', question: 'what is spec.replicas?', paths: ['a', 'b'] },
    ]),
    computeDatasetHash(pathsReordered),
  );
});

check('dataset hash changes when only the governance role changes', () => {
  const before = [{ id: 'a', question: 'question', governance: GOVERNANCE }];
  const after = [
    {
      ...before[0],
      governance: { ...GOVERNANCE, role: 'regression' as const },
    },
  ];

  assert.notEqual(computeDatasetHash(before), computeDatasetHash(after));
});

check('dataset hash rejects values that stable JSON cannot preserve', () => {
  assert.throws(() => computeDatasetHash([{ id: 'a', value: undefined }]));
  assert.throws(() => computeDatasetHash([{ id: 'a', value: Number.NaN }]));
  assert.throws(() => computeDatasetHash([{ id: 'a', value: BigInt(1) }]));
  assert.throws(() => computeDatasetHash([{ id: 'a', values: [, 1] }]));
});

check('dataset hash preserves JSON keys that overlap object prototypes', () => {
  const withPrototypeKey = JSON.parse(
    '{"id":"a","__proto__":{"expected":"one"}}',
  ) as unknown;
  const changedPrototypeKey = JSON.parse(
    '{"id":"a","__proto__":{"expected":"two"}}',
  ) as unknown;

  assert.notEqual(
    computeDatasetHash([withPrototypeKey]),
    computeDatasetHash([changedPrototypeKey]),
  );
});

check('retrieval config requires the complete retrieval identity', () => {
  for (const field of [
    'corpusManifestHash',
    'indexHash',
    'embeddingModel',
    'rerankModel',
    'queryExpansion',
    'k',
  ]) {
    assert.throws(() =>
      decodeEvalRun({
        ...runFixture('retrieval'),
        config: omit(RETRIEVAL_CONFIG, field),
      }),
    );
  }
});

check('faith config requires model, prompt, parser, and attempt identities', () => {
  for (const field of [
    'corpusManifestHash',
    'answerModel',
    'judgeModel',
    'answerPromptHash',
    'judgePromptHash',
    'judgeParserSchemaIdentity',
    'judgeAttemptLimit',
  ]) {
    assert.throws(() =>
      decodeEvalRun({
        ...runFixture('faith'),
        config: omit(FAITH_CONFIG, field),
      }),
    );
  }
});

check('judge config accepts calibration or targeted scope and requires vote identity', () => {
  assert.throws(() =>
    decodeEvalRun({ ...runFixture('judge'), scope: 'full' }),
  );
  assert.doesNotThrow(() =>
    decodeEvalRun({ ...runFixture('judge'), scope: 'targeted' }),
  );
  assert.throws(() => decodeEvalRun(omit(runFixture('judge'), 'dataset')));
  for (const field of [
    'judgeModel',
    'voteCount',
    'promptHash',
    'parserSchemaIdentity',
  ]) {
    assert.throws(() =>
      decodeEvalRun({
        ...runFixture('judge'),
        config: omit(JUDGE_CONFIG, field),
      }),
    );
  }
});

check('generation and fix configs require model and validation identities', () => {
  for (const kind of ['generation', 'fix'] as const) {
    for (const field of [
      'answerModel',
      'systemPromptHash',
      'toolSchemaIdentity',
      'validationSchemaIdentity',
    ]) {
      assert.throws(() =>
        decodeEvalRun({
          ...runFixture(kind),
          config: omit(GENERATION_CONFIG, field),
        }),
      );
    }
  }
});

check('MetricObservation accepts only finite numbers or null', () => {
  assert.deepEqual(metricObservation(0.5), { value: 0.5 });
  assert.deepEqual(metricObservation(null), { value: null });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => metricObservation(value));
  }
});

check('ratio observations derive value from a non-negative finite pair', () => {
  assert.deepEqual(ratioObservation(1, 2), {
    value: 0.5,
    numerator: 1,
    denominator: 2,
  });
  assert.throws(() => metricObservation(0.9, 1, 2), /numerator.*denominator|ratio/i);
  assert.throws(() => metricObservation(0.5, 1));
  assert.throws(() => metricObservation(0.5, undefined, 2));
  assert.throws(() => metricObservation(0.5, -1, 2));
  assert.throws(() => metricObservation(0.5, 1, -2));
  assert.throws(() => metricObservation(0.5, Number.POSITIVE_INFINITY, 2));
});

check('zero denominator has exactly the 0/0 => null structure', () => {
  assert.deepEqual(ratioObservation(0, 0), {
    value: null,
    numerator: 0,
    denominator: 0,
  });
  assert.throws(() => ratioObservation(1, 0));
  assert.throws(() => metricObservation(0, 0, 0));
  assert.throws(() => metricObservation(null, 1, 0));
});

check('run schema version and timestamps are validated', () => {
  assert.equal(EVAL_SCHEMA_VERSION, 3);
  assert.throws(() => decodeEvalRun({ ...runFixture(), schemaVersion: 2 }));
  assert.throws(() => decodeEvalRun({ ...runFixture(), createdAt: 'yesterday' }));
  assert.throws(() =>
    decodeEvalRun({ ...runFixture(), completedAt: '2026-02-30T00:00:00Z' }),
  );
});

check('running run has neither completion nor failure state', () => {
  const running = omit(runFixture(), 'completedAt');
  running.status = 'running';
  assert.equal(decodeEvalRun(running).status, 'running');
  assert.throws(() =>
    decodeEvalRun({ ...running, completedAt: COMPLETED_AT }),
  );
  assert.throws(() => decodeEvalRun({ ...running, completedAt: undefined }));
  assert.throws(() =>
    decodeEvalRun({
      ...running,
      failure: { stage: 'dataset_preflight', message: 'failed' },
    }),
  );
  assert.throws(() => decodeEvalRun({ ...running, failure: undefined }));
});

check('completed run requires completedAt and forbids failure', () => {
  assert.throws(() => decodeEvalRun(omit(runFixture(), 'completedAt')));
  assert.throws(() =>
    decodeEvalRun({
      ...runFixture(),
      failure: { stage: 'metric_aggregation', message: 'failed' },
    }),
  );
  assert.throws(() =>
    decodeEvalRun({ ...runFixture(), failure: undefined }),
  );
});

check('failed run requires completedAt and a structured failure', () => {
  const failed = {
    ...runFixture(),
    status: 'failed',
    failure: { stage: 'index', message: 'index unavailable' },
  };
  assert.equal(decodeEvalRun(failed).status, 'failed');
  assert.throws(() => decodeEvalRun(omit(failed, 'failure')));
  assert.throws(() => decodeEvalRun(omit(failed, 'completedAt')));
  assert.throws(() => decodeEvalRun({ ...failed, failure: undefined }));
  assert.throws(() => decodeEvalRun({ ...failed, completedAt: undefined }));
  assert.throws(() =>
    decodeEvalRun({ ...failed, failure: { message: 'index unavailable' } }),
  );
});

check('baseline is portable and rejects every run artifact field', () => {
  for (const kind of [
    'retrieval',
    'faith',
    'judge',
    'generation',
    'fix',
  ] as const) {
    assert.equal(decodeEvalBaseline(baselineFixture(kind)).kind, kind);
  }

  assert.throws(() =>
    decodeEvalBaseline({
      ...baselineFixture(),
      artifactPaths: { trace: 'traces/run-retrieval.retrieval.jsonl' },
    }),
  );
  assert.throws(() =>
    decodeEvalBaseline({ ...baselineFixture(), status: 'completed' }),
  );
  assert.throws(() =>
    decodeEvalBaseline({ ...baselineFixture(), schemaVersion: 2 }),
  );
  assert.throws(() =>
    decodeEvalBaseline({ ...baselineFixture(), promotedAt: 'tomorrow' }),
  );
});

check('run decoder validates persisted metric observations', () => {
  assert.throws(() =>
    decodeEvalRun({
      ...runFixture(),
      metrics: {
        'invalid.rate': { value: 0, numerator: 0, denominator: 0 },
      },
    }),
  );
});

check('TraceEnvelope requires all identity, outcome, and payload fields', () => {
  for (const field of [
    'schemaVersion',
    'traceId',
    'runId',
    'evalCaseId',
    'governance',
    'kind',
    'createdAt',
    'outcome',
    'payload',
  ]) {
    assert.throws(() => decodeTraceEnvelope(omit(traceFixture(), field)), field);
  }
  assert.throws(() =>
    decodeTraceEnvelope({ ...traceFixture(), payload: undefined }),
  );
});

check('TraceEnvelope validates schema version and timestamp', () => {
  assert.throws(() =>
    decodeTraceEnvelope({ ...traceFixture(), schemaVersion: 2 }),
  );
  assert.throws(() =>
    decodeTraceEnvelope({ ...traceFixture(), createdAt: 'not-an-instant' }),
  );
});

check('error trace requires error details and other outcomes forbid them', () => {
  const errorTrace = {
    ...traceFixture(),
    outcome: 'error',
    error: { stage: 'rerank', message: 'timeout' },
  };
  assert.equal(decodeTraceEnvelope(errorTrace).outcome, 'error');
  assert.throws(() =>
    decodeTraceEnvelope(omit({ ...traceFixture(), outcome: 'error' }, 'error')),
  );
  for (const outcome of ['success', 'failed', 'skipped'] as const) {
    assert.throws(() =>
      decodeTraceEnvelope({
        ...traceFixture(),
        outcome,
        error: { stage: 'rerank', message: 'timeout' },
      }),
    );
  }
  assert.throws(() =>
    decodeTraceEnvelope({ ...traceFixture(), error: undefined }),
  );
});

check('run and case errors accept only the stable stage taxonomy', () => {
  assert.ok(EVAL_CASE_ERROR_STAGES.includes('judge_parse'));
  assert.ok(EVAL_CASE_ERROR_STAGES.includes('schema_validation'));
  assert.ok(EVAL_RUN_FATAL_STAGES.includes('dataset_preflight'));
  assert.ok(EVAL_RUN_FATAL_STAGES.includes('artifact_write'));

  assert.throws(() =>
    decodeTraceEnvelope({
      ...traceFixture(),
      outcome: 'error',
      error: { stage: 'case:pod-image:retrieval', message: 'failed' },
    }),
  );
  assert.throws(() =>
    decodeEvalRun({
      ...runFixture(),
      status: 'failed',
      failure: { stage: 'runner', message: 'failed' },
    }),
  );
});

check('protocol decoders reject unknown legacy fields', () => {
  assert.throws(() => decodeEvalRun({ ...runFixture(), faithSelection: {} }));
  assert.throws(() =>
    decodeEvalRun({
      ...runFixture('retrieval'),
      config: {
        ...RETRIEVAL_CONFIG,
        corpusContentHash: HASH_A,
      },
    }),
  );
  assert.throws(() =>
    decodeTraceEnvelope({ ...traceFixture(), id: 'legacy-trace-id' }),
  );
});

console.log(`\n通过 ${passed} 项`);

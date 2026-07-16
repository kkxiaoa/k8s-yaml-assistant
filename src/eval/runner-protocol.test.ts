import assert from 'node:assert/strict';
import {
  AGENT_MAX_TOKENS,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
  ANSWER_MODEL,
} from '../server/agent-contract';
import {
  buildCorpusManifest,
  SCHEMA_CORPUS_PROVIDER,
} from '../knowledge/corpus';
import { computeIndexHash } from '../retrieval/index-store';
import { RetrievalPipelineError } from '../retrieval/retrieve';
import { VALIDATION_LOGIC_REVISION } from '../validation/validate';
import { ANSWER_SYSTEM, MODEL } from './answer';
import {
  FAITH_JUDGE_ATTEMPT_LIMIT,
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_SYSTEM,
} from './judge';
import { TEXT_MAX_TOKENS } from './llm';
import {
  computeCanonicalHash,
  metricObservation,
  type MetricObservation,
} from './protocol';
import {
  buildRetrievalEvalTracePayload,
  faithMetricsRecord,
  faithDatasetIdentity,
  faithEvalConfig,
  fixDatasetIdentity,
  fixEvalConfig,
  generationDatasetIdentity,
  generationEvalConfig,
  generatedResultEvaluationStage,
  harnessErrorMetrics,
  judgeDatasetIdentity,
  judgeEvalConfig,
  prepareFaithDataset,
  retrievalDatasetIdentity,
  retrievalExecutionError,
  retrievalEvalConfig,
  retrievalMetricsRecord,
  selectFaithCases,
  selectRetrievalCases,
  toPersistedPayload,
} from './runner-protocol';
import type { GroundedAnswerCase } from './cases/grounded-answer-cases';
import type { SemanticRetrievalCase } from './cases/retrieval-cases';
import type { GenerationEvalCase } from './cases/generation-cases';
import type { FixCase } from './cases/fix-cases';
import type { JudgeCalibrationCase } from './metrics/judge-metrics';
import {
  EvalCaseExecutionError,
  EvalRunExecutionError,
} from './run-session';

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

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const SEMANTIC_CASE: SemanticRetrievalCase = {
  id: 'semantic',
  question: 'How?',
  expectedChunkIds: ['Chunk::b', 'Chunk::a'],
  target: { kind: 'Pod' },
  source: 'human',
};
const GROUNDED_REFERENCE: GroundedAnswerCase = {
  id: 'semantic',
  input: { kind: 'retrieval_case', retrievalCaseId: 'semantic' },
  expectedBehavior: 'answer_with_sources',
  sourceExpectation: { mode: 'required', types: ['schema'] },
};
const STANDALONE_REFUSAL: GroundedAnswerCase = {
  id: 'refusal',
  input: { kind: 'standalone_question', question: 'Unknown?' },
  expectedBehavior: 'refuse_insufficient_context',
};

const GENERATION_CASE: GenerationEvalCase = {
  id: 'gen-1',
  requirement: 'Create a Pod',
  expectedResources: [
    {
      ref: 'pod',
      identity: { apiVersion: 'v1', kind: 'Pod', name: 'demo' },
      assertions: [{ type: 'equals', path: 'spec.restartPolicy', value: 'Never' }],
    },
  ],
  relations: [],
};

const FIX_CASE: FixCase = {
  id: 'fix-1',
  defectType: 'type_error',
  brokenYaml:
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: "2"',
  target: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
  preserve: [{ type: 'equals', path: 'metadata.name', value: 'web' }],
  expectedCorrections: [
    { type: 'equals', path: 'spec.replicas', value: 2 },
  ],
};

const JUDGE_CASE: JudgeCalibrationCase = {
  id: 'judge-1',
  category: 'faithful',
  sourceFaithRunId: 'faith-run-1',
  sourceFaithTraceId: 'faith-run-1:judge-1',
  question: 'Question',
  context: 'Context',
  sources: [
    {
      n: 1,
      id: 'Chunk::judge',
      title: 'Judge source',
      sourceType: 'schema',
      provenance: { authority: 'cluster_api', version: 'v1' },
      targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.field' }],
    },
  ],
  answer: 'Answer',
  human: { faithful: true, note: 'Supported' },
};

console.log('runner-protocol:');

check('semantic retrieval dataset contains only Recall/MRR cases', () => {
  const selected = selectRetrievalCases([SEMANTIC_CASE]);
  const identity = retrievalDatasetIdentity(selected);

  assert.deepEqual(selected.map((item) => item.id), ['semantic']);
  assert.deepEqual(identity.caseIds, ['semantic']);
  assert.equal(identity.caseCount, 1);
  assert.equal(identity.id, 'retrieval/semantic');
});

check('dataset hashes ignore case declaration order but change with semantics', () => {
  const second = { ...SEMANTIC_CASE, id: 'semantic-2', question: 'Why?' };
  const ordered = retrievalDatasetIdentity([SEMANTIC_CASE, second]);
  const reversed = retrievalDatasetIdentity([second, SEMANTIC_CASE]);
  const changed = retrievalDatasetIdentity([
    { ...SEMANTIC_CASE, expectedChunkIds: ['Chunk::changed'] },
    second,
  ]);

  assert.equal(ordered.hash, reversed.hash);
  assert.notEqual(ordered.hash, changed.hash);
});

check('faith selection includes explicit referenced and standalone cases', () => {
  const grounded = [GROUNDED_REFERENCE, STANDALONE_REFUSAL];
  const full = selectFaithCases(undefined, grounded);
  const smoke = selectFaithCases('1', grounded);
  const prepared = prepareFaithDataset(full.cases, [SEMANTIC_CASE]);
  const identity = faithDatasetIdentity(full.cases, [SEMANTIC_CASE]);

  assert.equal(full.scope, 'full');
  assert.equal(smoke.scope, 'smoke');
  assert.deepEqual(identity.caseIds, ['semantic', 'refusal']);
  assert.deepEqual(prepared.identity, identity);
  assert.equal(prepared.cases[0]?.question, SEMANTIC_CASE.question);
  assert.deepEqual(
    prepared.cases[0]?.expectedChunkIds,
    SEMANTIC_CASE.expectedChunkIds,
  );
  assert.equal(prepared.cases[1]?.question, 'Unknown?');
  assert.equal(identity.id, 'faith/grounded-answer-selection');
  assert.notEqual(
    identity.hash,
    retrievalDatasetIdentity([SEMANTIC_CASE]).hash,
  );
  assert.notEqual(
    faithDatasetIdentity(full.cases, [
      { ...SEMANTIC_CASE, question: 'Changed?' },
    ]).hash,
    identity.hash,
  );
  assert.notEqual(
    faithDatasetIdentity(
      [
        {
          ...GROUNDED_REFERENCE,
          sourceExpectation: {
            mode: 'allow_missing_with_disclosure',
            types: ['schema'],
          },
        },
        STANDALONE_REFUSAL,
      ],
      [SEMANTIC_CASE],
    ).hash,
    identity.hash,
  );
});

check('faith full, policy, and smoke select only grounded-answer cases', () => {
  const grounded: GroundedAnswerCase[] = [
    GROUNDED_REFERENCE,
    {
      ...GROUNDED_REFERENCE,
      id: 'policy-semantic',
    },
    STANDALONE_REFUSAL,
  ];

  assert.deepEqual(
    selectFaithCases(undefined, grounded).cases.map((item) => item.id),
    ['semantic', 'policy-semantic', 'refusal'],
  );
  assert.deepEqual(
    selectFaithCases('--policy', grounded).cases.map((item) => item.id),
    ['policy-semantic'],
  );
  assert.deepEqual(
    selectFaithCases('1', grounded).cases.map((item) => item.id),
    ['semantic', 'refusal'],
  );
});

check('judge dataset hashes question/context/answer and human labels', () => {
  const original = judgeDatasetIdentity([JUDGE_CASE]);
  for (const changed of [
    { ...JUDGE_CASE, question: 'Changed' },
    { ...JUDGE_CASE, context: 'Changed' },
    { ...JUDGE_CASE, sources: [] },
    { ...JUDGE_CASE, answer: 'Changed' },
    { ...JUDGE_CASE, sourceFaithTraceId: 'faith-run-1:changed' },
    {
      ...JUDGE_CASE,
      human: { ...JUDGE_CASE.human, faithful: false },
    },
  ]) {
    assert.notEqual(judgeDatasetIdentity([changed]).hash, original.hash);
  }
});

check('generation and fix hashes cover their full expected contracts', () => {
  const generation = generationDatasetIdentity([GENERATION_CASE]);
  assert.notEqual(
    generationDatasetIdentity([
      {
        ...GENERATION_CASE,
        expectedResources: [
          {
            ...GENERATION_CASE.expectedResources[0]!,
            assertions: [
              { type: 'equals', path: 'spec.restartPolicy', value: 'Always' },
            ],
          },
        ],
      },
    ]).hash,
    generation.hash,
  );

  const fix = fixDatasetIdentity([FIX_CASE]);
  assert.notEqual(
    fixDatasetIdentity([{ ...FIX_CASE, brokenYaml: 'changed' }]).hash,
    fix.hash,
  );
  assert.notEqual(
    fixDatasetIdentity([
      {
        ...FIX_CASE,
        target: { ...FIX_CASE.target, kind: 'StatefulSet' },
      },
    ]).hash,
    fix.hash,
  );
  assert.notEqual(
    fixDatasetIdentity([
      {
        ...FIX_CASE,
        expectedCorrections: [
          { type: 'equals', path: 'spec.replicas', value: 3 },
        ],
      },
    ]).hash,
    fix.hash,
  );
});

check('faith and judge prompt hashes are derived from actual request inputs', () => {
  const faith = faithEvalConfig(3);
  const calibration = judgeEvalConfig(5);

  assert.equal(
    faith.answerPromptHash,
    computeCanonicalHash({
      system: ANSWER_SYSTEM,
      request: { model: MODEL, maxTokens: TEXT_MAX_TOKENS },
    }),
  );
  const judgeHash = computeCanonicalHash({
    system: JUDGE_SYSTEM,
    request: { model: JUDGE_MODEL, maxTokens: TEXT_MAX_TOKENS },
  });
  assert.equal(faith.judgePromptHash, judgeHash);
  assert.equal(faith.judgeAttemptLimit, FAITH_JUDGE_ATTEMPT_LIMIT);
  assert.equal(calibration.promptHash, judgeHash);
  assert.equal(
    calibration.parserSchemaIdentity,
    JUDGE_PARSER_SCHEMA_IDENTITY,
  );
});

check('retrieval config resolves the embedding model at run start', () => {
  const previous = process.env.VOYAGE_EMBEDDING_MODEL;
  process.env.VOYAGE_EMBEDDING_MODEL = 'identity-test-model';
  try {
    const config = retrievalEvalConfig(3);
    const corpus = buildCorpusManifest();
    assert.equal(config.embeddingModel, 'identity-test-model');
    assert.equal(config.corpusContentHash, corpus.contentHash);
    assert.equal(config.corpusManifestHash, corpus.manifestHash);
    assert.equal(
      config.indexHash,
      computeIndexHash(corpus, 'identity-test-model'),
    );
  } finally {
    if (previous === undefined) delete process.env.VOYAGE_EMBEDDING_MODEL;
    else process.env.VOYAGE_EMBEDDING_MODEL = previous;
  }
});

check('generation/fix identities hash actual system, tool, and validation inputs', () => {
  const generation = generationEvalConfig();
  const fix = fixEvalConfig();
  const request = {
    model: ANSWER_MODEL,
    maxTokens: AGENT_MAX_TOKENS,
  };

  assert.equal(
    generation.systemPromptHash,
    computeCanonicalHash({
      system: GENERATION_SYSTEM,
      request,
      maxRepairRounds: MAX_REPAIR_ROUNDS,
    }),
  );
  assert.equal(
    fix.systemPromptHash,
    computeCanonicalHash({
      system: FIX_SYSTEM,
      request,
      maxRepairRounds: MAX_REPAIR_ROUNDS,
    }),
  );
  assert.equal(
    generation.toolSchemaIdentity,
    computeCanonicalHash(SUBMIT_YAML_TOOL),
  );
  assert.equal(generation.toolSchemaIdentity, fix.toolSchemaIdentity);
  assert.equal(
    generation.validationSchemaIdentity,
    fix.validationSchemaIdentity,
  );
  assert.equal(
    generation.validationSchemaIdentity,
    computeCanonicalHash({
      logicRevision: VALIDATION_LOGIC_REVISION,
      schemaProviderManifestHash:
        SCHEMA_CORPUS_PROVIDER.manifest().manifestHash,
    }),
  );
  assert.equal(VALIDATION_LOGIC_REVISION, 'schema-validator-v1');
});

check('retrieval payload preserves retrieval trace and rank diagnostics', () => {
  const payload = buildRetrievalEvalTracePayload({
    trace: {
      question: 'How?',
      mode: 'free',
      queryText: 'How?',
      path: 'search',
      coarseHits: [],
      rerankHits: [],
      finalHits: [],
      latencyMs: { total: 1 },
      cache: { index: { status: 'hit' }, embeddingHit: false },
      createdAt: '2026-07-12T00:00:00.000Z',
    },
    expectedChunkIds: ['Chunk::a'],
    rankedIds: ['Chunk::b', 'Chunk::a'],
    k: 1,
  });

  assert.equal(payload.trace.question, 'How?');
  assert.deepEqual(payload.expected, { chunkIds: ['Chunk::a'], k: 1 });
  assert.deepEqual(payload.ranking, {
    topKIds: ['Chunk::b'],
    foundIds: [],
    firstRelevantRank: 2,
    recall: 0,
    reciprocalRank: 0.5,
  });
});

check('persisted payload drops optional object fields and rejects lossy numbers', () => {
  assert.deepEqual(toPersistedPayload({ value: 1, optional: undefined }), {
    value: 1,
  });
  assert.throws(
    () => toPersistedPayload({ value: Number.NaN }),
    /non-finite number/,
  );
});

check('every evaluator records harness errors as a count observation', () => {
  for (const kind of [
    'retrieval',
    'faith',
    'judge',
    'generation',
    'fix',
  ] as const) {
    assert.deepEqual(harnessErrorMetrics(kind, 2), {
      [`${kind}.harness_error_count`]: metricObservation(2),
    });
  }
  assert.throws(() => harnessErrorMetrics('retrieval', -1), /non-negative/);
});

check('faith refusal rate is N/A without a conclusive refusal case', () => {
  const record = faithMetricsRecord({
    faithfulCount: 2,
    judgedCount: 2,
    refusedCorrectlyCount: 0,
    refusalJudgedCount: 0,
    hallucinationCount: 0,
    dualCauseCount: 0,
    judgeIndeterminateCount: 0,
    judgeInvalidAttemptCount: 0,
    judgeErrorAttemptCount: 0,
    caseCount: 2,
  });
  assert.deepEqual(
    record['faith.refusal_correct_rate'],
    metricObservation(null, 0, 0),
  );
});

check('all retrieval and faith case errors leave quality N/A', () => {
  const retrieval: Record<string, MetricObservation> = {
    ...retrievalMetricsRecord({
      recallNumerator: 0,
      mrrNumerator: 0,
      caseCount: 0,
      retrievalMissCount: 0,
      rerankMissCount: 0,
    }),
    ...harnessErrorMetrics('retrieval', 3),
  };
  const faith: Record<string, MetricObservation> = {
    ...faithMetricsRecord({
      faithfulCount: 0,
      judgedCount: 0,
      refusedCorrectlyCount: 0,
      refusalJudgedCount: 0,
      hallucinationCount: 0,
      dualCauseCount: 0,
      judgeIndeterminateCount: 0,
      judgeInvalidAttemptCount: 0,
      judgeErrorAttemptCount: 0,
      caseCount: 0,
    }),
    ...harnessErrorMetrics('faith', 3),
  };

  assert.deepEqual(
    retrieval['retrieval.semantic.recall'],
    metricObservation(null, 0, 0),
  );
  assert.deepEqual(
    faith['faith.faithful_rate'],
    metricObservation(null, 0, 0),
  );
  assert.deepEqual(
    retrieval['retrieval.harness_error_count'],
    metricObservation(3),
  );
  assert.deepEqual(
    faith['faith.harness_error_count'],
    metricObservation(3),
  );
});

check('generated result exceptions use the last parser boundary', () => {
  assert.equal(
    generatedResultEvaluationStage({ attempts: [{ parseOk: false }] }),
    'yaml_parse',
  );
  assert.equal(
    generatedResultEvaluationStage({ attempts: [{ parseOk: true }] }),
    'schema_validation',
  );
  assert.equal(
    generatedResultEvaluationStage({ attempts: [] }),
    'schema_validation',
  );
});

check('retrieval failures preserve pipeline stage and make index fatal', () => {
  for (const stage of ['embedding', 'retrieval', 'rerank'] as const) {
    const failure = retrievalExecutionError(
      new RetrievalPipelineError(stage, new Error(`${stage} failed`)),
      (resolvedStage) => ({ resolvedStage }),
    );
    assert.ok(failure instanceof EvalCaseExecutionError);
    assert.equal(failure.stage, stage);
    assert.deepEqual(failure.payload, { resolvedStage: stage });
  }

  const indexFailure = retrievalExecutionError(
    new RetrievalPipelineError('index', new Error('index failed')),
    (stage) => ({ stage }),
  );
  assert.ok(indexFailure instanceof EvalRunExecutionError);
  assert.equal(indexFailure.stage, 'index');
});

await checkAsync('runner modules can be imported without starting an eval', async () => {
  await Promise.all([
    import('./retrieval-eval'),
    import('./faithfulness-eval'),
    import('./judge-eval'),
    import('./generation-eval'),
    import('./fix-eval'),
  ]);
});

console.log(`\n通过 ${passed} 项`);

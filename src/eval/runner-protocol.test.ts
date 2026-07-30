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
  ASK_MAX_TOKENS,
  ASK_SYSTEM,
  buildAskUserMessage,
} from '../server/pipeline';
import {
  buildCorpusManifest,
  SCHEMA_CORPUS_PROVIDER,
} from '../knowledge/corpus';
import { computeIndexHash } from '../retrieval/index-store';
import { RetrievalPipelineError } from '../retrieval/retrieve';
import { VALIDATION_LOGIC_REVISION } from '../validation/validate';
import {
  FAITH_JUDGE_ATTEMPT_LIMIT,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_SYSTEM,
  JUDGE_USER_MESSAGE_TEMPLATE,
} from './judge';
import {
  computeCanonicalHash,
  metricObservation,
  type MetricObservation,
} from './protocol';
import {
  buildRetrievalEvalTracePayload,
  faithMetricsRecord,
  faithDatasetIdentity,
  faithTraceDatasetIdentity,
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
  selectEvalSuiteCases,
  selectFaithCases,
  selectJudgeCases,
  selectRetrievalCases,
  toPersistedPayload,
} from './runner-protocol';
import type { GroundedAnswerCase } from './cases/grounded-answer-cases';
import type { SemanticRetrievalCase } from './cases/retrieval-cases';
import type { GenerationEvalCase } from './cases/generation-cases';
import { FIX_CASES, type FixCase } from './cases/fix-cases';
import type { JudgeCalibrationCase } from './metrics/judge-metrics';
import { decodeFaithTrace, type FaithTrace } from './faith-store';
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
  governance: {
    task: 'field_explanation',
    origin: 'human',
    role: 'development',
  },
  question: 'How?',
  expectedChunkIds: ['Chunk::b', 'Chunk::a'],
  target: { kind: 'Pod' },
};
const GROUNDED_REFERENCE: GroundedAnswerCase = {
  id: 'semantic',
  input: { kind: 'retrieval_case', retrievalCaseId: 'semantic' },
  expectedBehavior: 'answer_with_sources',
  sourceExpectation: { mode: 'required', types: ['schema'] },
};
const HOLDOUT_RETRIEVAL_CASE: SemanticRetrievalCase = {
  ...SEMANTIC_CASE,
  id: 'holdout-semantic',
  governance: { ...SEMANTIC_CASE.governance, role: 'holdout' },
};
const REGRESSION_RETRIEVAL_CASE: SemanticRetrievalCase = {
  ...SEMANTIC_CASE,
  id: 'regression-semantic',
  governance: { ...SEMANTIC_CASE.governance, role: 'regression' },
};
const GROUNDED_HOLDOUT_REFERENCE: GroundedAnswerCase = {
  id: HOLDOUT_RETRIEVAL_CASE.id,
  input: {
    kind: 'retrieval_case',
    retrievalCaseId: HOLDOUT_RETRIEVAL_CASE.id,
  },
  expectedBehavior: 'answer_with_sources',
};
const STANDALONE_REFUSAL: GroundedAnswerCase = {
  id: 'refusal',
  governance: {
    task: 'refusal',
    origin: 'human',
    role: 'development',
  },
  input: { kind: 'standalone_question', question: 'Unknown?' },
  expectedBehavior: 'refuse_insufficient_context',
};
const VALIDATION_ERROR_GROUNDED: GroundedAnswerCase = {
  id: 'error-deployment-replicas-type',
  governance: {
    task: 'error_explanation',
    origin: 'human',
    role: 'development',
  },
  input: {
    kind: 'validation_error',
    fixCaseId: 'fix-type-replicas',
    question:
      'Deployment 的 spec.replicas 为什么提示类型错误，应该怎么修复？',
    expectedChunkIds: [
      'schema::apps/v1::Deployment::spec.replicas',
    ],
  },
  expectedBehavior: 'answer_with_sources',
  sourceExpectation: { mode: 'required', types: ['schema'] },
};

const GENERATION_CASE: GenerationEvalCase = {
  id: 'gen-1',
  governance: {
    task: 'generation',
    origin: 'human',
    role: 'development',
  },
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
  governance: {
    task: 'fix',
    origin: 'human',
    role: 'development',
  },
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
  governance: SEMANTIC_CASE.governance,
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
  const selection = selectRetrievalCases([], [SEMANTIC_CASE]);
  const identity = retrievalDatasetIdentity(selection.cases);

  assert.equal(selection.scope, 'tuning');
  assert.equal(selection.k, 3);
  assert.deepEqual(selection.cases.map((item) => item.id), ['semantic']);
  assert.deepEqual(identity.cases, [
    { id: 'semantic', governance: SEMANTIC_CASE.governance },
  ]);
  assert.equal(identity.caseCount, 1);
  assert.equal(identity.id, 'retrieval/semantic');
});

check('retrieval defaults to tuning and only explicit flags select holdout or full', () => {
  const cases = [
    HOLDOUT_RETRIEVAL_CASE,
    SEMANTIC_CASE,
    REGRESSION_RETRIEVAL_CASE,
  ];
  const tuning = selectRetrievalCases([], cases);
  const holdout = selectRetrievalCases(['--holdout'], cases);
  const full = selectRetrievalCases(['5', '--full'], cases);

  assert.equal(tuning.scope, 'tuning');
  assert.deepEqual(tuning.cases.map((item) => item.id), [
    'semantic',
    'regression-semantic',
  ]);
  assert.equal(holdout.scope, 'holdout');
  assert.deepEqual(holdout.cases.map((item) => item.id), [
    'holdout-semantic',
  ]);
  assert.equal(full.scope, 'full');
  assert.equal(full.k, 5);
  assert.deepEqual(full.cases.map((item) => item.id), [
    'holdout-semantic',
    'semantic',
    'regression-semantic',
  ]);
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
  assert.notEqual(
    retrievalDatasetIdentity([
      {
        ...SEMANTIC_CASE,
        governance: { ...SEMANTIC_CASE.governance, role: 'regression' },
      },
      second,
    ]).hash,
    ordered.hash,
  );
});

check('faith selection includes explicit referenced and standalone cases', () => {
  const grounded = [GROUNDED_REFERENCE, STANDALONE_REFUSAL];
  const full = selectFaithCases(['--full'], grounded, [SEMANTIC_CASE]);
  const smoke = selectFaithCases(['1'], grounded, [SEMANTIC_CASE]);
  const prepared = prepareFaithDataset(grounded, [SEMANTIC_CASE]);
  const identity = full.identity;

  assert.equal(full.scope, 'full');
  assert.equal(smoke.scope, 'smoke');
  assert.deepEqual(identity.cases, [
    { id: 'semantic', governance: SEMANTIC_CASE.governance },
    { id: 'refusal', governance: STANDALONE_REFUSAL.governance },
  ]);
  assert.deepEqual(prepared.identity, identity);
  assert.equal(prepared.cases[0]?.question, SEMANTIC_CASE.question);
  assert.deepEqual(
    prepared.cases[0]?.expectedChunkIds,
    SEMANTIC_CASE.expectedChunkIds,
  );
  assert.deepEqual(
    prepared.cases[0]?.governance,
    SEMANTIC_CASE.governance,
  );
  assert.deepEqual(
    prepared.cases[1]?.governance,
    STANDALONE_REFUSAL.governance,
  );
  assert.equal(prepared.cases[1]?.question, 'Unknown?');
  assert.equal(identity.id, 'faith/grounded-answer-selection');
  assert.notEqual(
    identity.hash,
    retrievalDatasetIdentity([SEMANTIC_CASE]).hash,
  );
  assert.notEqual(
    faithDatasetIdentity(grounded, [
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
  assert.notEqual(
    faithDatasetIdentity(grounded, [
      {
        ...SEMANTIC_CASE,
        governance: { ...SEMANTIC_CASE.governance, role: 'regression' },
      },
    ]).hash,
    identity.hash,
  );
});

check('validation-error faith identity snapshots the resolved real fixture', () => {
  const fixCase = FIX_CASES.find(
    (candidate) => candidate.id === 'fix-type-replicas',
  )!;
  const prepared = prepareFaithDataset(
    [VALIDATION_ERROR_GROUNDED],
    [],
    [fixCase],
  );
  const resolved = prepared.cases[0]!;

  assert.deepEqual(resolved.target, fixCase.target);
  assert.equal(resolved.editorContext?.yaml, fixCase.brokenYaml);
  assert.equal(resolved.editorContext?.kind, 'Deployment');
  assert.ok((resolved.editorContext?.errors.length ?? 0) > 0);

  const trace: FaithTrace = {
    id: resolved.id,
    governance: resolved.governance,
    input: resolved.input,
    question: resolved.question,
    expectedBehavior: resolved.expectedBehavior,
    sourceExpectation: resolved.sourceExpectation,
    target: resolved.target,
    editorContext: resolved.editorContext,
    retrieval: {
      expectedChunkIds: resolved.expectedChunkIds,
      topIds: [],
      foundCount: 0,
      fullRecall: false,
      queryExpansionConfig: {
        enabled: false,
        registryHash: null,
        reviewedAliasCount: 0,
      },
    },
    answer: '',
    judgeAttempts: [],
    verdict: null,
    outcome: 'error',
    errorPhase: 'retrieval',
  };
  assert.deepEqual(decodeFaithTrace(trace).editorContext, resolved.editorContext);
  const { editorContext: _editorContext, ...withoutEditorContext } = trace;
  assert.throws(
    () => decodeFaithTrace(withoutEditorContext),
    /validation-error.*editor context/i,
  );
  assert.equal(
    faithTraceDatasetIdentity([trace]).hash,
    prepared.identity.hash,
  );
  assert.notEqual(
    faithDatasetIdentity(
      [VALIDATION_ERROR_GROUNDED],
      [],
      [
        {
          ...fixCase,
          brokenYaml: fixCase.brokenYaml.replace('replicas: "3"', 'replicas: "4"'),
        },
      ],
    ).hash,
    prepared.identity.hash,
  );
});

check('grounded and persisted faith snapshots share governance identity', () => {
  const prepared = prepareFaithDataset([GROUNDED_REFERENCE], [SEMANTIC_CASE]);
  const trace: FaithTrace = {
    id: SEMANTIC_CASE.id,
    governance: SEMANTIC_CASE.governance,
    input: GROUNDED_REFERENCE.input,
    question: SEMANTIC_CASE.question,
    expectedBehavior: GROUNDED_REFERENCE.expectedBehavior,
    sourceExpectation: GROUNDED_REFERENCE.sourceExpectation,
    target: SEMANTIC_CASE.target,
    retrieval: {
      expectedChunkIds: SEMANTIC_CASE.expectedChunkIds,
      topIds: [],
      foundCount: 0,
      fullRecall: false,
      queryExpansionConfig: {
        enabled: false,
        registryHash: null,
        reviewedAliasCount: 0,
      },
    },
    answer: '',
    judgeAttempts: [],
    verdict: null,
    outcome: 'error',
    errorPhase: 'retrieval',
  };

  assert.equal(faithTraceDatasetIdentity([trace]).hash, prepared.identity.hash);
  assert.notEqual(
    faithTraceDatasetIdentity([
      {
        ...trace,
        governance: { ...trace.governance, role: 'regression' },
      },
    ]).hash,
    prepared.identity.hash,
  );
});

check('faith suite and diagnostic selections exclude holdout unless explicitly requested', () => {
  const grounded: GroundedAnswerCase[] = [
    GROUNDED_REFERENCE,
    {
      ...GROUNDED_REFERENCE,
      id: 'policy-semantic',
    },
    GROUNDED_HOLDOUT_REFERENCE,
    {
      ...GROUNDED_HOLDOUT_REFERENCE,
      id: 'policy-holdout-semantic',
    },
    STANDALONE_REFUSAL,
  ];
  const retrievalCases = [SEMANTIC_CASE, HOLDOUT_RETRIEVAL_CASE];

  assert.deepEqual(
    selectFaithCases([], grounded, retrievalCases).cases.map((item) => item.id),
    ['semantic', 'policy-semantic', 'refusal'],
  );
  assert.deepEqual(
    selectFaithCases(['--holdout'], grounded, retrievalCases).cases.map(
      (item) => item.id,
    ),
    ['holdout-semantic', 'policy-holdout-semantic'],
  );
  assert.deepEqual(
    selectFaithCases(['--full'], grounded, retrievalCases).cases.map(
      (item) => item.id,
    ),
    [
      'semantic',
      'policy-semantic',
      'holdout-semantic',
      'policy-holdout-semantic',
      'refusal',
    ],
  );
  assert.deepEqual(
    selectFaithCases(['--policy'], grounded, retrievalCases).cases.map(
      (item) => item.id,
    ),
    ['policy-semantic'],
  );
  assert.deepEqual(
    selectFaithCases(['1'], grounded, retrievalCases).cases.map(
      (item) => item.id,
    ),
    ['semantic', 'refusal'],
  );
  assert.throws(
    () => selectFaithCases(['--holdout', '--policy'], grounded, retrievalCases),
    /holdout.*policy|diagnostic.*suite|suite.*diagnostic/i,
  );
});

check('generation and fix suite selection uses the shared role rules', () => {
  const holdoutGeneration: GenerationEvalCase = {
    ...GENERATION_CASE,
    id: 'gen-holdout',
    governance: { ...GENERATION_CASE.governance, role: 'holdout' },
  };
  const holdoutFix: FixCase = {
    ...FIX_CASE,
    id: 'fix-holdout',
    governance: { ...FIX_CASE.governance, role: 'holdout' },
  };

  assert.deepEqual(
    selectEvalSuiteCases([], [GENERATION_CASE, holdoutGeneration]).cases.map(
      (item) => item.id,
    ),
    ['gen-1'],
  );
  assert.deepEqual(
    selectEvalSuiteCases(['--holdout'], [FIX_CASE, holdoutFix]).cases.map(
      (item) => item.id,
    ),
    ['fix-holdout'],
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
    {
      ...JUDGE_CASE,
      governance: {
        ...JUDGE_CASE.governance,
        role: 'regression' as const,
      },
    },
  ]) {
    assert.notEqual(judgeDatasetIdentity([changed]).hash, original.hash);
  }
});

check('judge selection uses the canonical calibration set for full and targeted runs', () => {
  const second: JudgeCalibrationCase = {
    ...JUDGE_CASE,
    id: 'judge-2',
    sourceFaithTraceId: 'faith-run-1:judge-2',
  };
  const cases = [JUDGE_CASE, second];

  const calibration = selectJudgeCases([], cases);
  const targeted = selectJudgeCases(
    ['--case', 'judge-2', '--case', 'judge-1'],
    cases,
  );

  assert.equal(calibration.scope, 'calibration');
  assert.deepEqual(
    calibration.cases.map((evalCase) => evalCase.id),
    ['judge-1', 'judge-2'],
  );
  assert.equal(targeted.scope, 'targeted');
  assert.deepEqual(
    targeted.cases.map((evalCase) => evalCase.id),
    ['judge-1', 'judge-2'],
  );
  assert.throws(
    () => selectJudgeCases(['--case', 'missing'], cases),
    /unknown judge case ID: missing/,
  );
  assert.throws(
    () =>
      selectJudgeCases(
        ['--case', 'judge-1', '--case', 'judge-1'],
        cases,
      ),
    /duplicate judge case ID: judge-1/,
  );
  assert.throws(
    () => selectJudgeCases(['judge-1'], cases),
    /用法/,
  );
});

check('generation and fix hashes cover their full expected contracts', () => {
  const generation = generationDatasetIdentity([GENERATION_CASE]);
  assert.notEqual(
    generationDatasetIdentity([
      {
        ...GENERATION_CASE,
        governance: { ...GENERATION_CASE.governance, role: 'regression' },
      },
    ]).hash,
    generation.hash,
  );
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
    fixDatasetIdentity([
      {
        ...FIX_CASE,
        governance: { ...FIX_CASE.governance, role: 'regression' },
      },
    ]).hash,
    fix.hash,
  );
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
  assert.equal(ANSWER_MODEL, 'deepseek-v4-flash');
  assert.equal(JUDGE_MODEL, 'deepseek-v4-pro');
  assert.notEqual(ANSWER_MODEL, JUDGE_MODEL);

  const runtimeEnvironment = {
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_ANSWER_MODEL: 'deepseek-v4-flash',
    VOYAGE_EMBEDDING_URL: 'https://api.voyageai.com/v1/embeddings',
    VOYAGE_RERANK_URL: 'https://api.voyageai.com/v1/rerank',
    VOYAGE_EMBEDDING_MODEL: 'voyage-3',
    VOYAGE_RERANK_MODEL: 'rerank-2.5',
    INDEX_DIR: 'data/index',
    ENABLE_QUERY_EXPANSION: 'true',
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(runtimeEnvironment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  let faith: ReturnType<typeof faithEvalConfig>;
  let calibration: ReturnType<typeof judgeEvalConfig>;
  try {
    faith = faithEvalConfig(3);
    calibration = judgeEvalConfig(5);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(
    faith.answerPromptHash,
    computeCanonicalHash({
      system: ASK_SYSTEM,
      userMessages: [
        buildAskUserMessage({
          question: '<question>',
          context: '<docs>',
          mode: 'free',
        }),
        buildAskUserMessage({
          question: '<question>',
          context: '<docs>',
          mode: 'explain_error',
          editorContext: {
            yaml: '<current_yaml>',
            kind: '<kind>',
            apiVersion: '<apiVersion>',
            cursorPath: '<cursorPath>',
            selectedText: '<selectedText>',
            errors: [
              { path: '<error_path>', message: '<error_message>' },
            ],
          },
        }),
      ],
      request: { model: ANSWER_MODEL, maxTokens: ASK_MAX_TOKENS },
    }),
  );
  const judgeHash = computeCanonicalHash({
    system: JUDGE_SYSTEM,
    userMessageTemplate: JUDGE_USER_MESSAGE_TEMPLATE,
    request: { model: JUDGE_MODEL, maxTokens: JUDGE_MAX_TOKENS },
  });
  assert.equal(faith.judgePromptHash, judgeHash);
  assert.equal(faith.judgeAttemptLimit, FAITH_JUDGE_ATTEMPT_LIMIT);
  assert.equal(faith.answerModel, ANSWER_MODEL);
  assert.equal(calibration.promptHash, judgeHash);
  assert.equal(
    calibration.parserSchemaIdentity,
    JUDGE_PARSER_SCHEMA_IDENTITY,
  );
});

check('retrieval config resolves the embedding model at run start', () => {
  const environment = {
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_ANSWER_MODEL: 'deepseek-v4-flash',
    VOYAGE_EMBEDDING_URL: 'https://api.voyageai.com/v1/embeddings',
    VOYAGE_RERANK_URL: 'https://api.voyageai.com/v1/rerank',
    VOYAGE_EMBEDDING_MODEL: 'voyage-4',
    VOYAGE_RERANK_MODEL: 'rerank-2.5',
    INDEX_DIR: 'data/index-ab',
    ENABLE_QUERY_EXPANSION: 'true',
  } as const;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const config = retrievalEvalConfig(3);
    const corpus = buildCorpusManifest();
    assert.equal(config.embeddingModel, 'voyage-4');
    assert.equal(config.corpusManifestHash, corpus.manifestHash);
    assert.equal(
      config.indexHash,
      computeIndexHash(corpus, 'voyage-4'),
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  assert.equal(VALIDATION_LOGIC_REVISION, 'schema-validator-v2');
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
    expectedBehaviorSatisfiedCount: 2,
    behaviorJudgedCount: 2,
    groundedSuccessCount: 2,
    refusedCorrectlyCount: 0,
    refusalJudgedCount: 0,
    unsupportedResponseCount: 0,
    behaviorMismatchCount: 0,
    retrievalIncompleteCount: 0,
    sourceIncompleteCount: 0,
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
      expectedBehaviorSatisfiedCount: 0,
      behaviorJudgedCount: 0,
      groundedSuccessCount: 0,
      refusedCorrectlyCount: 0,
      refusalJudgedCount: 0,
      unsupportedResponseCount: 0,
      behaviorMismatchCount: 0,
      retrievalIncompleteCount: 0,
      sourceIncompleteCount: 0,
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

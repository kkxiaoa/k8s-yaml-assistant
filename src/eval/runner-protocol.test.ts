import assert from 'node:assert/strict';
import {
  AGENT_MAX_TOKENS,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
  ANSWER_MODEL,
} from '../server/agent-contract';
import { VALIDATION_LOGIC_REVISION } from '../validation/validate';
import { ANSWER_SYSTEM, MODEL } from './answer';
import {
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_PARSE_ATTEMPTS,
  JUDGE_SYSTEM,
} from './judge';
import { TEXT_MAX_TOKENS } from './llm';
import { computeCanonicalHash } from './protocol';
import {
  buildRetrievalEvalTracePayload,
  faithDatasetIdentity,
  faithEvalConfig,
  fixDatasetIdentity,
  fixEvalConfig,
  generationDatasetIdentity,
  generationEvalConfig,
  judgeDatasetIdentity,
  judgeEvalConfig,
  retrievalDatasetIdentity,
  retrievalEvalConfig,
  selectFaithCases,
  selectRetrievalCases,
  toPersistedPayload,
} from './runner-protocol';
import type { RetrievalEvalCase } from './cases/retrieval-cases';
import type { GenerationEvalCase } from './cases/generation-cases';
import type { FixEvalCase } from './cases/fix-cases';
import type { JudgeCalibrationCase } from './metrics/judge-metrics';

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

const ANSWERABLE: RetrievalEvalCase = {
  id: 'answerable',
  taskType: 'ask_free',
  question: 'How?',
  expectedChunkIds: ['Chunk::b', 'Chunk::a'],
  resource: 'Pod',
  answerable: true,
  source: 'human',
};
const REFUSAL: RetrievalEvalCase = {
  id: 'refusal',
  taskType: 'refusal',
  question: 'Unknown?',
  expectedChunkIds: [],
  answerable: false,
  source: 'human',
};

const GENERATION_CASE: GenerationEvalCase = {
  id: 'gen-1',
  requirement: 'Create a Pod',
  expectedKinds: ['Pod'],
  mustHavePaths: ['metadata.name'],
  consistencyChecks: [],
};

const FIX_CASE: FixEvalCase = {
  id: 'fix-1',
  defect: 'replicas is a string',
  defectType: 'type_error',
  brokenYaml: 'kind: Deployment\nspec:\n  replicas: "2"',
  expectedKind: 'Deployment',
  mustPreserve: [{ path: 'metadata.name', value: 'web' }],
};

const JUDGE_CASE: JudgeCalibrationCase = {
  id: 'judge-1',
  category: 'faithful',
  question: 'Question',
  context: 'Context',
  answer: 'Answer',
  human: { faithful: true, note: 'Supported' },
};

console.log('runner-protocol:');

check('retrieval dataset contains only cases that enter Recall/MRR', () => {
  const selected = selectRetrievalCases([REFUSAL, ANSWERABLE]);
  const identity = retrievalDatasetIdentity(selected);

  assert.deepEqual(selected.map((item) => item.id), ['answerable']);
  assert.deepEqual(identity.caseIds, ['answerable']);
  assert.equal(identity.caseCount, 1);
});

check('dataset hashes ignore case declaration order but change with semantics', () => {
  const second = { ...ANSWERABLE, id: 'answerable-2', question: 'Why?' };
  const ordered = retrievalDatasetIdentity([ANSWERABLE, second]);
  const reversed = retrievalDatasetIdentity([second, ANSWERABLE]);
  const changed = retrievalDatasetIdentity([
    { ...ANSWERABLE, expectedChunkIds: ['Chunk::changed'] },
    second,
  ]);

  assert.equal(ordered.hash, reversed.hash);
  assert.notEqual(ordered.hash, changed.hash);
});

check('faith selection includes the actually selected answerable and refusal cases', () => {
  const full = selectFaithCases(undefined, [ANSWERABLE, REFUSAL]);
  const smoke = selectFaithCases('1', [ANSWERABLE, REFUSAL]);
  const identity = faithDatasetIdentity(full.cases);

  assert.equal(full.scope, 'full');
  assert.equal(smoke.scope, 'smoke');
  assert.deepEqual(identity.caseIds, ['answerable', 'refusal']);
});

check('judge dataset hashes question/context/answer and human labels', () => {
  const original = judgeDatasetIdentity([JUDGE_CASE]);
  for (const changed of [
    { ...JUDGE_CASE, question: 'Changed' },
    { ...JUDGE_CASE, context: 'Changed' },
    { ...JUDGE_CASE, answer: 'Changed' },
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
      { ...GENERATION_CASE, mustHavePaths: ['spec.containers'] },
    ]).hash,
    generation.hash,
  );

  const fix = fixDatasetIdentity([FIX_CASE]);
  assert.notEqual(
    fixDatasetIdentity([{ ...FIX_CASE, brokenYaml: 'changed' }]).hash,
    fix.hash,
  );
  assert.notEqual(
    fixDatasetIdentity([{ ...FIX_CASE, expectedKind: 'Pod' }]).hash,
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
    parseAttempts: JUDGE_PARSE_ATTEMPTS,
  });
  assert.equal(faith.judgePromptHash, judgeHash);
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
    assert.equal(retrievalEvalConfig(3).embeddingModel, 'identity-test-model');
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
  assert.match(generation.validationSchemaIdentity, /^[a-f0-9]{64}$/);
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
      cache: { indexHit: true, embeddingHit: false },
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

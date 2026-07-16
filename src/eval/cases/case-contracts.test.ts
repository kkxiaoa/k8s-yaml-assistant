import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import {
  RETRIEVAL_CASES,
  decodeSemanticRetrievalCases,
} from './retrieval-cases';
import {
  GROUNDED_ANSWER_CASES,
  decodeGroundedAnswerCases,
  evaluateSourceExpectation,
  resolveGroundedAnswerCase,
} from './grounded-answer-cases';

function semanticCase(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'pod-image',
    question: 'Pod 里怎么指定容器镜像?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.image'],
    target: { kind: 'Pod' },
    source: 'human',
    ...overrides,
  };
}

function expectInvalid(run: () => unknown, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ZodError, String(error));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const knownChunkIds = new Set([
  'schema::v1::Pod::spec.containers.image',
]);

expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase({ expectedChunkIds: [] })],
    { knownChunkIds },
  ),
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase({ target: {} })],
    { knownChunkIds },
  ),
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase({ target: { kind: '   ' } })],
    { knownChunkIds },
  ),
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase({ question: '   ' })],
    { knownChunkIds },
  ),
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase(), semanticCase()],
    { knownChunkIds },
  ),
  /duplicate semantic retrieval case id/,
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [semanticCase({ expectedChunkIds: ['missing-chunk'] })],
    { knownChunkIds },
  ),
  /unknown expected chunk id/,
);
expectInvalid(() =>
  decodeSemanticRetrievalCases(
    [
      semanticCase({
        expectedChunkIds: [
          'schema::v1::Pod::spec.containers.image',
          'schema::v1::Pod::spec.containers.image',
        ],
      }),
    ],
    { knownChunkIds },
  ),
  /duplicate expected chunk id/,
);

for (const legacyOrEditorField of [
  'answerable',
  'taskType',
  'cursorPath',
  'selectedText',
  'yaml',
  'errors',
]) {
  expectInvalid(() =>
    decodeSemanticRetrievalCases(
      [semanticCase({ [legacyOrEditorField]: true })],
      { knownChunkIds },
    ),
  );
}

const semanticCases = decodeSemanticRetrievalCases(
  [semanticCase()],
  { knownChunkIds },
);

expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'missing-reference',
        input: { kind: 'retrieval_case', retrievalCaseId: 'missing' },
        expectedBehavior: 'answer_with_sources',
      },
    ],
    semanticCases,
  ),
  /unknown retrieval case id/,
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'duplicate',
        input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
        expectedBehavior: 'answer_with_sources',
      },
      {
        id: 'duplicate',
        input: { kind: 'standalone_question', question: 'unknown?' },
        expectedBehavior: 'refuse_insufficient_context',
      },
    ],
    semanticCases,
  ),
  /duplicate grounded answer case id/,
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'blank-question',
        input: { kind: 'standalone_question', question: '   ' },
        expectedBehavior: 'refuse_insufficient_context',
      },
    ],
    semanticCases,
  ),
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'empty-source-expectation',
          input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
          expectedBehavior: 'answer_with_sources',
          sourceExpectation: { mode: 'required', types: [] },
        },
      ],
      semanticCases,
    ),
  /sourceExpectation|types/i,
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'duplicate-source-type',
          input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
          expectedBehavior: 'answer_with_sources',
          sourceExpectation: {
            mode: 'required',
            types: ['schema', 'schema'],
          },
        },
      ],
      semanticCases,
    ),
  /duplicate source type/i,
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'unknown-source-type',
        input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
        expectedBehavior: 'answer_with_sources',
        sourceExpectation: { mode: 'required', types: ['unknown'] },
      },
    ],
    semanticCases,
  ),
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'conflict-without-source-expectation',
          input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
          expectedBehavior: 'explain_schema_policy_conflict',
        },
      ],
      semanticCases,
    ),
  /conflict.*source expectation/i,
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'conflict-without-policy',
          input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
          expectedBehavior: 'explain_schema_policy_conflict',
          sourceExpectation: { mode: 'required', types: ['schema'] },
        },
      ],
      semanticCases,
    ),
  /conflict.*schema.*policy/i,
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'standalone-answer',
        input: { kind: 'standalone_question', question: 'unknown?' },
        expectedBehavior: 'answer_with_sources',
      },
    ],
    semanticCases,
  ),
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'referenced-refusal',
        input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
        expectedBehavior: 'refuse_insufficient_context',
      },
    ],
    semanticCases,
  ),
);

assert.equal(RETRIEVAL_CASES.length, 81);
assert.equal(GROUNDED_ANSWER_CASES.length, 86);
assert.deepEqual(
  GROUNDED_ANSWER_CASES.filter(
    (evalCase) =>
      evalCase.expectedBehavior === 'explain_schema_policy_conflict',
  ).map((evalCase) => ({
    id: evalCase.id,
    sourceExpectation:
      'sourceExpectation' in evalCase
        ? evalCase.sourceExpectation
        : undefined,
  })),
  [
    {
      id: 'policy-conflict-latest',
      sourceExpectation: { mode: 'required', types: ['schema', 'policy'] },
    },
    {
      id: 'policy-conflict-nodeport',
      sourceExpectation: { mode: 'required', types: ['schema', 'policy'] },
    },
    {
      id: 'policy-conflict-privileged',
      sourceExpectation: {
        mode: 'allow_missing_with_disclosure',
        types: ['schema', 'policy'],
      },
    },
  ],
);
const resolvedConflict = resolveGroundedAnswerCase(
  GROUNDED_ANSWER_CASES.find(
    (evalCase) => evalCase.id === 'policy-conflict-privileged',
  )!,
);
assert.deepEqual(resolvedConflict.sourceExpectation, {
  mode: 'allow_missing_with_disclosure',
  types: ['schema', 'policy'],
});
assert.deepEqual(
  evaluateSourceExpectation(
    { mode: 'required', types: ['schema', 'policy'] },
    ['schema'],
  ),
  {
    mode: 'required',
    expectedTypes: ['schema', 'policy'],
    presentTypes: ['schema'],
    missingTypes: ['policy'],
    status: 'missing_required',
  },
);
assert.deepEqual(
  evaluateSourceExpectation(
    {
      mode: 'allow_missing_with_disclosure',
      types: ['schema', 'policy'],
    },
    ['schema'],
  ),
  {
    mode: 'allow_missing_with_disclosure',
    expectedTypes: ['schema', 'policy'],
    presentTypes: ['schema'],
    missingTypes: ['policy'],
    status: 'disclosure_required',
  },
);
assert.equal(
  evaluateSourceExpectation(undefined, ['schema', 'policy']),
  undefined,
);
assert.deepEqual(
  GROUNDED_ANSWER_CASES.filter(
    (evalCase) => evalCase.input.kind === 'standalone_question',
  ).map((evalCase) => evalCase.id),
  [
    'refusal-prometheus-retention',
    'refusal-gateway-httproute',
    'refusal-cert-manager',
    'refusal-nonexistent-field',
    'refusal-cluster-runtime',
  ],
);

console.log('case contracts: ok');

import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { preflightFixCases, type FixCase } from '../assertions';
import { FIX_CASES } from './fix-cases';
import { GENERATION_CASES } from './generation-cases';
import { selectCasesForSuite } from './governance';
import {
  RETRIEVAL_CASES,
  decodeSemanticRetrievalCases,
} from './retrieval-cases';
import {
  GROUNDED_ANSWER_CASES,
  decodeGroundedAnswerCases,
  evaluateSourceExpectation,
  groundedAnswerAskMode,
  resolveGroundedAnswerCase,
} from './grounded-answer-cases';

const FIELD_DEVELOPMENT = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;
const FIELD_HOLDOUT = {
  ...FIELD_DEVELOPMENT,
  role: 'holdout',
} as const;
const REFUSAL_DEVELOPMENT = {
  task: 'refusal',
  origin: 'human',
  role: 'development',
} as const;
const ERROR_DEVELOPMENT = {
  task: 'error_explanation',
  origin: 'human',
  role: 'development',
} as const;

function semanticCase(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'pod-image',
    question: 'Pod 里怎么指定容器镜像?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.image'],
    target: { kind: 'Pod' },
    governance: FIELD_DEVELOPMENT,
    ...overrides,
  };
}

function validationErrorCase(
  inputOverrides: Record<string, unknown> = {},
  caseOverrides: Record<string, unknown> = {},
): unknown {
  return {
    id: 'error-deployment-replicas-type',
    input: {
      kind: 'validation_error',
      fixCaseId: 'fix-type-replicas',
      question:
        'Deployment 的 spec.replicas 为什么提示类型错误，应该怎么修复？',
      expectedChunkIds: [
        'schema::apps/v1::Deployment::spec.replicas',
      ],
      ...inputOverrides,
    },
    expectedBehavior: 'answer_with_sources',
    sourceExpectation: { mode: 'required', types: ['schema'] },
    governance: ERROR_DEVELOPMENT,
    ...caseOverrides,
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
    [semanticCase({ governance: undefined })],
    { knownChunkIds },
  ),
);
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
  'source',
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

expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [validationErrorCase({ fixCaseId: 'missing-fix-case' })],
      semanticCases,
      FIX_CASES,
    ),
  /unknown fix case id: missing-fix-case/i,
);

const noValidationErrorFixCase: FixCase = {
  ...FIX_CASES.find((evalCase) => evalCase.id === 'fix-type-replicas')!,
  id: 'fix-no-validation-error',
  brokenYaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`,
};
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        validationErrorCase({
          fixCaseId: noValidationErrorFixCase.id,
        }),
      ],
      semanticCases,
      [...FIX_CASES, noValidationErrorFixCase],
    ),
  /declared defect|validation errors|preflight/i,
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        validationErrorCase({
          errors: [{ path: 'spec.replicas', message: 'hand-written' }],
        }),
      ],
      semanticCases,
      FIX_CASES,
    ),
  /errors/i,
);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [validationErrorCase({}, { governance: FIELD_DEVELOPMENT })],
      semanticCases,
      FIX_CASES,
    ),
  /validation_error_grounded_answer.*field_explanation/i,
);

const decodedValidationErrorCase = decodeGroundedAnswerCases(
  [validationErrorCase()],
  semanticCases,
  FIX_CASES,
)[0]!;
const resolvedValidationErrorCase = resolveGroundedAnswerCase(
  decodedValidationErrorCase,
  semanticCases,
  FIX_CASES,
);
const referencedFixCase = FIX_CASES.find(
  (evalCase) => evalCase.id === 'fix-type-replicas',
)!;
const referencedFixture = preflightFixCases([referencedFixCase])[0]!;
assert.deepEqual(resolvedValidationErrorCase.target, referencedFixCase.target);
assert.deepEqual(resolvedValidationErrorCase.editorContext, {
  yaml: referencedFixCase.brokenYaml,
  kind: referencedFixCase.target.kind,
  apiVersion: referencedFixCase.target.apiVersion,
  errors: referencedFixture.validationErrors,
});
assert.ok(resolvedValidationErrorCase.editorContext.errors.length > 0);
assert.match(
  resolvedValidationErrorCase.editorContext.errors[0]!.message,
  /number|类型|整数/i,
);
assert.equal(
  groundedAnswerAskMode(resolvedValidationErrorCase.input),
  'explain_error',
);
assert.equal(
  groundedAnswerAskMode({
    kind: 'retrieval_case',
    retrievalCaseId: 'pod-image',
  }),
  'free',
);
assert.equal(
  groundedAnswerAskMode({
    kind: 'standalone_question',
    question: 'unknown?',
  }),
  'free',
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
        governance: REFUSAL_DEVELOPMENT,
      },
    ],
    semanticCases,
  ),
  /duplicate grounded answer case id/,
);
const answerableGatewayQuestion = 'Gateway API 的 HTTPRoute 怎么按权重分流?';
const answerableGatewayCases = decodeSemanticRetrievalCases([
  semanticCase({
    id: 'gateway-httproute-backend-weight',
    question: answerableGatewayQuestion,
    target: {
      kind: 'HTTPRoute',
      apiVersion: 'gateway.networking.k8s.io/v1',
    },
    expectedChunkIds: [
      'schema::gateway.networking.k8s.io/v1::HTTPRoute::spec.rules.backendRefs.weight',
    ],
  }),
]);
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'gateway-httproute-backend-weight',
          input: {
            kind: 'retrieval_case',
            retrievalCaseId: 'gateway-httproute-backend-weight',
          },
          expectedBehavior: 'answer_with_sources',
        },
        {
          id: 'refusal-gateway-httproute',
          input: {
            kind: 'standalone_question',
            question: answerableGatewayQuestion,
          },
          expectedBehavior: 'refuse_insufficient_context',
          governance: REFUSAL_DEVELOPMENT,
        },
      ],
      answerableGatewayCases,
    ),
  /stale refusal.*answerable question/i,
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'standalone-without-governance',
        input: { kind: 'standalone_question', question: 'unknown?' },
        expectedBehavior: 'refuse_insufficient_context',
      },
    ],
    semanticCases,
  ),
);
expectInvalid(() =>
  decodeGroundedAnswerCases(
    [
      {
        id: 'blank-question',
        input: { kind: 'standalone_question', question: '   ' },
        expectedBehavior: 'refuse_insufficient_context',
        governance: REFUSAL_DEVELOPMENT,
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
expectInvalid(
  () =>
    decodeGroundedAnswerCases(
      [
        {
          id: 'referenced-governance-override',
          input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
          expectedBehavior: 'answer_with_sources',
          governance: REFUSAL_DEVELOPMENT,
        },
      ],
      semanticCases,
    ),
  /governance/i,
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
        governance: REFUSAL_DEVELOPMENT,
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

assert.equal(RETRIEVAL_CASES.length, 83);
assert.equal(GROUNDED_ANSWER_CASES.length, 88);
assert.deepEqual(
  GROUNDED_ANSWER_CASES.filter(
    (evalCase) => evalCase.input.kind === 'validation_error',
  ).map((evalCase) => ({
    id: evalCase.id,
    input: evalCase.input,
    governance: 'governance' in evalCase ? evalCase.governance : undefined,
    hasCopiedYaml: 'yaml' in evalCase.input,
    hasCopiedErrors: 'errors' in evalCase.input,
  })),
  [
    {
      id: 'error-deployment-replicas-type',
      input: {
        kind: 'validation_error',
        fixCaseId: 'fix-type-replicas',
        question:
          'Deployment 的 spec.replicas 为什么提示类型错误，应该怎么修复？',
        expectedChunkIds: [
          'schema::apps/v1::Deployment::spec.replicas',
        ],
      },
      governance: ERROR_DEVELOPMENT,
      hasCopiedYaml: false,
      hasCopiedErrors: false,
    },
    {
      id: 'error-storageclass-missing-provisioner',
      input: {
        kind: 'validation_error',
        fixCaseId: 'fix-missing-provisioner',
        question:
          'StorageClass 为什么提示缺少 provisioner，应该怎么修复？',
        expectedChunkIds: [
          'schema::storage.k8s.io/v1::StorageClass::provisioner',
        ],
      },
      governance: ERROR_DEVELOPMENT,
      hasCopiedYaml: false,
      hasCopiedErrors: false,
    },
  ],
);
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
      sourceExpectation: { mode: 'required', types: ['schema', 'policy'] },
    },
  ],
);
const resolvedConflict = resolveGroundedAnswerCase(
  GROUNDED_ANSWER_CASES.find(
    (evalCase) => evalCase.id === 'policy-conflict-privileged',
  )!,
);
assert.deepEqual(
  resolveGroundedAnswerCase(
    {
      id: 'resolved-reference',
      input: { kind: 'retrieval_case', retrievalCaseId: 'pod-image' },
      expectedBehavior: 'answer_with_sources',
    },
    semanticCases,
  ).governance,
  FIELD_DEVELOPMENT,
);
assert.deepEqual(resolvedConflict.sourceExpectation, {
  mode: 'required',
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
    'refusal-nonexistent-field',
    'refusal-cluster-runtime',
  ],
);
assert.deepEqual(
  RETRIEVAL_CASES.filter((evalCase) =>
    [
      'gateway-httproute-backend-weight',
      'certificate-issuer-ref',
    ].includes(evalCase.id),
  ),
  [
    {
      id: 'gateway-httproute-backend-weight',
      governance: FIELD_DEVELOPMENT,
      target: {
        kind: 'HTTPRoute',
        apiVersion: 'gateway.networking.k8s.io/v1',
      },
      question: 'Gateway API 的 HTTPRoute 怎么按权重分流?',
      expectedChunkIds: [
        'schema::gateway.networking.k8s.io/v1::HTTPRoute::spec.rules.backendRefs.weight',
      ],
    },
    {
      id: 'certificate-issuer-ref',
      governance: FIELD_HOLDOUT,
      target: {
        kind: 'Certificate',
        apiVersion: 'cert-manager.io/v1',
      },
      question: 'cert-manager 的 Certificate 怎么指定签发者 issuer?',
      expectedChunkIds: [
        'schema::cert-manager.io/v1::Certificate::spec.issuerRef',
      ],
    },
  ],
);
for (const id of [
  'gateway-httproute-backend-weight',
  'certificate-issuer-ref',
]) {
  const resolved = resolveGroundedAnswerCase(
    GROUNDED_ANSWER_CASES.find((evalCase) => evalCase.id === id)!,
  );
  const retrieval = RETRIEVAL_CASES.find((evalCase) => evalCase.id === id)!;
  assert.deepEqual(resolved.governance, retrieval.governance);
  assert.deepEqual(resolved.expectedChunkIds, retrieval.expectedChunkIds);
}
assert.equal(
  RETRIEVAL_CASES.every((evalCase) => !('source' in evalCase)),
  true,
);
assert.equal(
  RETRIEVAL_CASES.filter(
    (evalCase) => evalCase.governance.task === 'field_explanation',
  ).length,
  74,
);
assert.equal(
  RETRIEVAL_CASES.filter(
    (evalCase) => evalCase.governance.task === 'policy_explanation',
  ).length,
  9,
);
assert.deepEqual(
  RETRIEVAL_CASES.filter(
    (evalCase) => evalCase.governance.role === 'regression',
  )
    .map((evalCase) => evalCase.id)
    .sort(),
  [
    'deploy-container-image',
    'endpoints-subsets',
    'pod-volumes',
    'policy-conflict-latest',
    'policy-conflict-privileged',
    'pvc-resources',
    'pvc-volumemode',
    'rolebinding-subjects',
    'sc-allowexpansion',
    'sc-volumebindingmode',
    'sts-volumeclaimtemplates',
  ],
);
assert.equal(
  RETRIEVAL_CASES.every(
    (evalCase) => evalCase.governance.origin === 'human',
  ),
  true,
);
assert.deepEqual(
  RETRIEVAL_CASES.filter(
    (evalCase) => evalCase.governance.role === 'holdout',
  ).map((evalCase) => evalCase.id),
  ['certificate-issuer-ref'],
);
assert.equal(
  GROUNDED_ANSWER_CASES.filter(
    (evalCase) => evalCase.input.kind === 'standalone_question',
  ).every(
    (evalCase) =>
      'governance' in evalCase &&
      evalCase.governance.task === 'refusal' &&
      evalCase.governance.origin === 'human' &&
      evalCase.governance.role === 'development',
  ),
  true,
);

const daemonSetHoldout = GENERATION_CASES.find(
  (evalCase) => evalCase.id === 'daemonset-holdout',
);
const hpaFixHoldout = FIX_CASES.find(
  (evalCase) => evalCase.id === 'fix-holdout-hpa-maxreplicas-type',
);
assert.ok(daemonSetHoldout);
assert.ok(hpaFixHoldout);
assert.equal(
  selectCasesForSuite(GENERATION_CASES, 'tuning').includes(daemonSetHoldout),
  false,
);
assert.equal(
  selectCasesForSuite(GENERATION_CASES, 'holdout').includes(daemonSetHoldout),
  true,
);
assert.equal(
  selectCasesForSuite(GENERATION_CASES, 'full').includes(daemonSetHoldout),
  true,
);
assert.equal(
  selectCasesForSuite(FIX_CASES, 'tuning').includes(hpaFixHoldout),
  false,
);
assert.equal(
  selectCasesForSuite(FIX_CASES, 'holdout').includes(hpaFixHoldout),
  true,
);
assert.equal(
  selectCasesForSuite(FIX_CASES, 'full').includes(hpaFixHoldout),
  true,
);

console.log('case contracts: ok');

import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import {
  assertTuningEligibleCase,
  EvalCaseGovernanceSchema,
  governanceSchemaForCaseFamily,
  parseEvalSuiteArgs,
  resolveTuningEligibleCasesById,
  selectCasesForSuite,
} from './governance';

const FIELD_DEVELOPMENT = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function expectInvalid(run: () => unknown, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ZodError, String(error));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

for (const missing of ['task', 'origin', 'role'] as const) {
  const value: Record<string, unknown> = { ...FIELD_DEVELOPMENT };
  delete value[missing];
  expectInvalid(() => EvalCaseGovernanceSchema.parse(value));
}

for (const [field, value] of [
  ['task', 'unknown_task'],
  ['origin', 'unknown_origin'],
  ['role', 'unknown_role'],
] as const) {
  expectInvalid(() =>
    EvalCaseGovernanceSchema.parse({
      ...FIELD_DEVELOPMENT,
      [field]: value,
    }),
  );
}

expectInvalid(() =>
  EvalCaseGovernanceSchema.parse({
    ...FIELD_DEVELOPMENT,
    tag: 'legacy',
  }),
);
expectInvalid(
  () =>
    EvalCaseGovernanceSchema.parse({
      task: 'field_explanation',
      origin: 'bad_case',
      role: 'development',
    }),
  /bad_case.*regression/i,
);
expectInvalid(
  () =>
    EvalCaseGovernanceSchema.parse({
      task: 'field_explanation',
      origin: 'bad_case',
      role: 'holdout',
    }),
  /bad_case.*regression/i,
);

assert.deepEqual(
  EvalCaseGovernanceSchema.parse({
    task: 'field_explanation',
    origin: 'human',
    role: 'regression',
  }),
  {
    task: 'field_explanation',
    origin: 'human',
    role: 'regression',
  },
);

const retrievalGovernance = governanceSchemaForCaseFamily('retrieval');
for (const task of ['error_explanation', 'refusal', 'generation', 'fix'] as const) {
  expectInvalid(
    () => retrievalGovernance.parse({ ...FIELD_DEVELOPMENT, task }),
    /retrieval.*task/i,
  );
}
for (const task of [
  'field_explanation',
  'policy_explanation',
  'free_question',
] as const) {
  assert.equal(
    retrievalGovernance.parse({ ...FIELD_DEVELOPMENT, task }).task,
    task,
  );
}

expectInvalid(
  () =>
    governanceSchemaForCaseFamily('generation').parse({
      ...FIELD_DEVELOPMENT,
      task: 'fix',
    }),
  /generation.*task/i,
);
expectInvalid(
  () =>
    governanceSchemaForCaseFamily('fix').parse({
      ...FIELD_DEVELOPMENT,
      task: 'generation',
    }),
  /fix.*task/i,
);
expectInvalid(
  () =>
    governanceSchemaForCaseFamily('standalone_grounded_answer').parse({
      ...FIELD_DEVELOPMENT,
      task: 'field_explanation',
    }),
  /standalone_grounded_answer.*task/i,
);

assert.equal(
  governanceSchemaForCaseFamily('standalone_grounded_answer').parse({
    ...FIELD_DEVELOPMENT,
    task: 'refusal',
  }).task,
  'refusal',
);

const governedCases = [
  { id: 'development', governance: FIELD_DEVELOPMENT },
  {
    id: 'holdout',
    governance: { ...FIELD_DEVELOPMENT, role: 'holdout' as const },
  },
  {
    id: 'regression',
    governance: { ...FIELD_DEVELOPMENT, role: 'regression' as const },
  },
];

assert.deepEqual(
  selectCasesForSuite(governedCases, 'tuning').map((item) => item.id),
  ['development', 'regression'],
);
assert.deepEqual(
  selectCasesForSuite(governedCases, 'holdout').map((item) => item.id),
  ['holdout'],
);
assert.deepEqual(
  selectCasesForSuite(governedCases, 'full').map((item) => item.id),
  ['development', 'holdout', 'regression'],
);

assert.deepEqual(parseEvalSuiteArgs([]), {
  suite: 'tuning',
  explicit: false,
  remainingArgs: [],
});
assert.deepEqual(parseEvalSuiteArgs(['5', '--full']), {
  suite: 'full',
  explicit: true,
  remainingArgs: ['5'],
});
assert.deepEqual(parseEvalSuiteArgs(['--holdout']), {
  suite: 'holdout',
  explicit: true,
  remainingArgs: [],
});
assert.throws(
  () => parseEvalSuiteArgs(['--full', '--holdout']),
  /conflicting|full.*holdout|holdout.*full/i,
);

const holdout = governedCases[1]!;
assert.throws(
  () => assertTuningEligibleCase(holdout, 'calibration label holdout'),
  /calibration label holdout.*holdout/i,
);
assert.throws(
  () =>
    resolveTuningEligibleCasesById(
      ['holdout'],
      governedCases,
      'alias target target-holdout',
    ),
  /alias target target-holdout.*holdout/i,
);

console.log('case governance: ok');

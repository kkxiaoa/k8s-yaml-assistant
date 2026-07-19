import { z } from 'zod';

export const EvalCaseTaskSchema = z.enum([
  'field_explanation',
  'policy_explanation',
  'error_explanation',
  'free_question',
  'refusal',
  'generation',
  'fix',
]);

export const EvalCaseOriginSchema = z.enum([
  'human',
  'schema_generated',
  'bad_case',
]);

export const EvalCaseRoleSchema = z.enum([
  'development',
  'regression',
  'holdout',
]);

export const EvalCaseGovernanceSchema = z
  .strictObject({
    task: EvalCaseTaskSchema,
    origin: EvalCaseOriginSchema,
    role: EvalCaseRoleSchema,
  })
  .superRefine((governance, context) => {
    if (
      governance.origin === 'bad_case' &&
      governance.role !== 'regression'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'bad_case origin requires regression role',
        path: ['role'],
      });
    }
  });

export type EvalCaseTask = z.infer<typeof EvalCaseTaskSchema>;
export type EvalCaseOrigin = z.infer<typeof EvalCaseOriginSchema>;
export type EvalCaseRole = z.infer<typeof EvalCaseRoleSchema>;
export type EvalCaseGovernance = z.infer<typeof EvalCaseGovernanceSchema>;

export const EvalSuiteSchema = z.enum(['tuning', 'holdout', 'full']);
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export interface GovernedEvalCase {
  id: string;
  governance: EvalCaseGovernance;
}

export interface ParsedEvalSuiteArgs {
  suite: EvalSuite;
  explicit: boolean;
  remainingArgs: string[];
}

const SUITE_BY_FLAG = new Map<string, EvalSuite>([
  ['--tuning', 'tuning'],
  ['--holdout', 'holdout'],
  ['--full', 'full'],
]);

export function parseEvalSuiteArgs(
  argv: readonly string[],
): ParsedEvalSuiteArgs {
  let selected: EvalSuite | undefined;
  const remainingArgs: string[] = [];

  for (const arg of argv) {
    const suite = SUITE_BY_FLAG.get(arg);
    if (suite === undefined) {
      remainingArgs.push(arg);
      continue;
    }
    if (selected !== undefined) {
      throw new Error(
        `conflicting eval suite flags: ${selected} and ${suite}`,
      );
    }
    selected = suite;
  }

  return {
    suite: selected ?? 'tuning',
    explicit: selected !== undefined,
    remainingArgs,
  };
}

export function selectCasesForSuite<T extends GovernedEvalCase>(
  cases: readonly T[],
  suite: EvalSuite,
): T[] {
  const resolvedSuite = EvalSuiteSchema.parse(suite);
  if (resolvedSuite === 'full') return [...cases];
  return cases.filter((evalCase) =>
    resolvedSuite === 'holdout'
      ? evalCase.governance.role === 'holdout'
      : evalCase.governance.role !== 'holdout',
  );
}

export function assertTuningEligibleCase(
  evalCase: GovernedEvalCase,
  context: string,
): void {
  if (evalCase.governance.role === 'holdout') {
    throw new Error(
      `${context}: Holdout case is not tuning-eligible: ${evalCase.id}`,
    );
  }
}

export function resolveTuningEligibleCasesById<T extends GovernedEvalCase>(
  caseIds: readonly string[],
  cases: readonly T[],
  context: string,
): T[] {
  const byId = new Map(cases.map((evalCase) => [evalCase.id, evalCase]));
  return caseIds.map((caseId) => {
    const evalCase = byId.get(caseId);
    if (evalCase === undefined) {
      throw new Error(`${context}: eval case not found: ${caseId}`);
    }
    assertTuningEligibleCase(evalCase, context);
    return evalCase;
  });
}

export const EvalCaseFamilySchema = z.enum([
  'retrieval',
  'standalone_grounded_answer',
  'validation_error_grounded_answer',
  'generation',
  'fix',
]);

export type EvalCaseFamily = z.infer<typeof EvalCaseFamilySchema>;

const ALLOWED_TASKS_BY_FAMILY: Readonly<
  Record<EvalCaseFamily, ReadonlySet<EvalCaseTask>>
> = Object.freeze({
  retrieval: new Set<EvalCaseTask>([
    'field_explanation',
    'policy_explanation',
    'free_question',
  ]),
  standalone_grounded_answer: new Set<EvalCaseTask>(['refusal']),
  validation_error_grounded_answer: new Set<EvalCaseTask>([
    'error_explanation',
  ]),
  generation: new Set<EvalCaseTask>(['generation']),
  fix: new Set<EvalCaseTask>(['fix']),
});

export function governanceSchemaForCaseFamily(family: EvalCaseFamily) {
  const resolvedFamily = EvalCaseFamilySchema.parse(family);
  return EvalCaseGovernanceSchema.superRefine((governance, context) => {
    if (!ALLOWED_TASKS_BY_FAMILY[resolvedFamily].has(governance.task)) {
      context.addIssue({
        code: 'custom',
        message: `${resolvedFamily} case does not accept task ${governance.task}`,
        path: ['task'],
      });
    }
  });
}

export function parseGovernanceForCaseFamily(
  value: unknown,
  family: EvalCaseFamily,
): EvalCaseGovernance {
  return governanceSchemaForCaseFamily(family).parse(value);
}

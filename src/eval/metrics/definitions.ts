import { z } from 'zod';
import { canonicalHash } from '../../shared/json';
import { DEFECT_TYPES } from '../assertions';
import { POLICY_DIMENSIONS } from '../judge-votes';
import {
  EvalKindSchema,
  type EvalKind,
  type MetricObservation,
} from '../protocol';

export const MetricDirectionSchema = z.enum([
  'higher_is_better',
  'lower_is_better',
  'neutral',
]);

export const MetricUnitSchema = z.enum([
  'ratio',
  'count',
  'milliseconds',
  'tokens',
  'usd',
  'number',
]);

export const MetricStabilitySchema = z.enum(['required', 'diagnostic']);

const NonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value), {
    message: 'must contain a non-whitespace character',
  });

const DENOMINATOR_FORBIDDEN_UNITS = new Set([
  'count',
  'milliseconds',
  'tokens',
  'usd',
]);

export const MetricDefinitionSchema = z
  .strictObject({
    key: NonBlankStringSchema,
    evalKind: EvalKindSchema,
    revision: z.int().positive(),
    direction: MetricDirectionSchema,
    unit: MetricUnitSchema,
    denominator: NonBlankStringSchema.optional(),
    stability: MetricStabilitySchema,
  })
  .superRefine((definition, context) => {
    const prefix = `${definition.evalKind}.`;
    if (!definition.key.startsWith(prefix)) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: `metric key prefix must be ${prefix}`,
      });
    }
    if (definition.unit === 'ratio' && definition.denominator === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['denominator'],
        message: 'ratio metric must declare a denominator',
      });
    }
    if (
      DENOMINATOR_FORBIDDEN_UNITS.has(definition.unit) &&
      definition.denominator !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['denominator'],
        message: `${definition.unit} metric cannot declare a denominator`,
      });
    }
  });

export type MetricDirection = z.infer<typeof MetricDirectionSchema>;
export type MetricUnit = z.infer<typeof MetricUnitSchema>;
export type MetricStability = z.infer<typeof MetricStabilitySchema>;
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export function defineMetricRegistry(
  value: readonly unknown[],
): readonly MetricDefinition[] {
  const definitions = z.array(MetricDefinitionSchema).parse(value).map(
    (definition): MetricDefinition => {
      if (definition.denominator !== undefined) return definition;
      const { denominator: _denominator, ...withoutDenominator } = definition;
      return withoutDenominator;
    },
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.key)) {
      throw new Error(`duplicate metric key: ${definition.key}`);
    }
    seen.add(definition.key);
  }
  return Object.freeze(
    definitions.map((definition) => Object.freeze(definition)),
  );
}

export function computeMetricDefinitionVersion(
  definitions: readonly unknown[],
): string {
  const decoded = defineMetricRegistry(definitions);
  return canonicalHash(
    [...decoded].sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function ratio(
  key: string,
  evalKind: EvalKind,
  direction: MetricDirection,
  denominator: string,
  stability: MetricStability,
): MetricDefinition {
  return {
    key,
    evalKind,
    revision: 1,
    direction,
    unit: 'ratio',
    denominator,
    stability,
  };
}

function count(
  key: string,
  evalKind: EvalKind,
  direction: MetricDirection,
  stability: MetricStability,
): MetricDefinition {
  return {
    key,
    evalKind,
    revision: 1,
    direction,
    unit: 'count',
    stability,
  };
}

function average(
  key: string,
  evalKind: EvalKind,
  denominator: string,
): MetricDefinition {
  return {
    key,
    evalKind,
    revision: 1,
    direction: 'neutral',
    unit: 'number',
    denominator,
    stability: 'diagnostic',
  };
}

const retrievalDefinitions: MetricDefinition[] = [
  ratio(
    'retrieval.semantic.recall',
    'retrieval',
    'higher_is_better',
    'completed_semantic_retrieval_cases',
    'required',
  ),
  ratio(
    'retrieval.semantic.mrr',
    'retrieval',
    'higher_is_better',
    'completed_semantic_retrieval_cases',
    'required',
  ),
  count(
    'retrieval.semantic.case_count',
    'retrieval',
    'neutral',
    'diagnostic',
  ),
  count(
    'retrieval.retrieval_miss_count',
    'retrieval',
    'lower_is_better',
    'diagnostic',
  ),
  count(
    'retrieval.rerank_miss_count',
    'retrieval',
    'lower_is_better',
    'diagnostic',
  ),
  count(
    'retrieval.harness_error_count',
    'retrieval',
    'lower_is_better',
    'required',
  ),
];

const faithDefinitions: MetricDefinition[] = [
  ratio(
    'faith.faithful_rate',
    'faith',
    'higher_is_better',
    'judge_conclusive_grounded_answer_cases',
    'required',
  ),
  ratio(
    'faith.refusal_correct_rate',
    'faith',
    'higher_is_better',
    'judge_conclusive_refusal_cases',
    'required',
  ),
  count('faith.hallucination', 'faith', 'lower_is_better', 'required'),
  count('faith.dual_cause', 'faith', 'lower_is_better', 'required'),
  count('faith.judged', 'faith', 'neutral', 'diagnostic'),
  count('faith.refusal_judged', 'faith', 'neutral', 'diagnostic'),
  count('faith.case_count', 'faith', 'neutral', 'diagnostic'),
  count(
    'faith.judge_indeterminate',
    'faith',
    'lower_is_better',
    'required',
  ),
  count(
    'faith.judge_invalid_attempt',
    'faith',
    'lower_is_better',
    'required',
  ),
  count(
    'faith.judge_error_attempt',
    'faith',
    'lower_is_better',
    'required',
  ),
  count(
    'faith.harness_error_count',
    'faith',
    'lower_is_better',
    'required',
  ),
];

const judgeDefinitions: MetricDefinition[] = [
  ratio(
    'judge.agreement_rate',
    'judge',
    'higher_is_better',
    'judge_conclusive_calibration_cases',
    'required',
  ),
  count('judge.agree', 'judge', 'neutral', 'diagnostic'),
  count('judge.judged', 'judge', 'neutral', 'diagnostic'),
  count(
    'judge.indeterminate',
    'judge',
    'lower_is_better',
    'required',
  ),
  count('judge.unstable', 'judge', 'lower_is_better', 'required'),
  count('judge.attempt.planned', 'judge', 'neutral', 'diagnostic'),
  count('judge.attempt.executed', 'judge', 'neutral', 'diagnostic'),
  count('judge.attempt.valid', 'judge', 'neutral', 'diagnostic'),
  count(
    'judge.attempt.invalid',
    'judge',
    'lower_is_better',
    'required',
  ),
  count(
    'judge.attempt.error',
    'judge',
    'lower_is_better',
    'required',
  ),
  ...POLICY_DIMENSIONS.flatMap((dimension): MetricDefinition[] => [
    ratio(
      `judge.policy.${dimension}.agreement_rate`,
      'judge',
      'higher_is_better',
      `judge_conclusive_policy_${dimension}_cases`,
      'required',
    ),
    count(
      `judge.policy.${dimension}.agree`,
      'judge',
      'neutral',
      'diagnostic',
    ),
    count(
      `judge.policy.${dimension}.judged`,
      'judge',
      'neutral',
      'diagnostic',
    ),
    count(
      `judge.policy.${dimension}.indeterminate`,
      'judge',
      'lower_is_better',
      'required',
    ),
    count(
      `judge.policy.${dimension}.unstable`,
      'judge',
      'lower_is_better',
      'required',
    ),
  ]),
  count(
    'judge.harness_error_count',
    'judge',
    'lower_is_better',
    'required',
  ),
];

function agentAttemptDefinitions(
  evalKind: Extract<EvalKind, 'generation' | 'fix'>,
): MetricDefinition[] {
  const completedCases = `completed_${evalKind}_cases`;
  return [
    ratio(
      `${evalKind}.first_parse_ok_rate`,
      evalKind,
      'higher_is_better',
      completedCases,
      'diagnostic',
    ),
    ratio(
      `${evalKind}.first_validation_ok_rate`,
      evalKind,
      'higher_is_better',
      completedCases,
      'diagnostic',
    ),
    ratio(
      `${evalKind}.repair_attempted_rate`,
      evalKind,
      'neutral',
      completedCases,
      'diagnostic',
    ),
    ratio(
      `${evalKind}.repair_success_after_fail_rate`,
      evalKind,
      'higher_is_better',
      `${evalKind}_first_validation_failed_cases`,
      'diagnostic',
    ),
    ratio(
      `${evalKind}.max_round_failure_rate`,
      evalKind,
      'lower_is_better',
      completedCases,
      'required',
    ),
    average(`${evalKind}.avg_submits`, evalKind, completedCases),
    average(`${evalKind}.avg_rounds`, evalKind, completedCases),
  ];
}

const generationDefinitions: MetricDefinition[] = [
  ratio(
    'generation.valid_yaml_rate',
    'generation',
    'higher_is_better',
    'completed_generation_cases',
    'required',
  ),
  ratio(
    'generation.resource_assertion_pass_rate',
    'generation',
    'higher_is_better',
    'applicable_generation_resource_assertions',
    'required',
  ),
  ratio(
    'generation.relation_pass_rate',
    'generation',
    'higher_is_better',
    'applicable_generation_relations',
    'required',
  ),
  ratio(
    'generation.content_pass_rate',
    'generation',
    'higher_is_better',
    'completed_generation_cases',
    'required',
  ),
  count('generation.case_count', 'generation', 'neutral', 'diagnostic'),
  ...agentAttemptDefinitions('generation'),
  count(
    'generation.harness_error_count',
    'generation',
    'lower_is_better',
    'required',
  ),
];

const fixDefinitions: MetricDefinition[] = [
  ratio(
    'fix.valid_yaml_rate',
    'fix',
    'higher_is_better',
    'completed_fix_cases',
    'required',
  ),
  ratio(
    'fix.expected_correction_pass_rate',
    'fix',
    'higher_is_better',
    'completed_fix_cases',
    'required',
  ),
  ratio(
    'fix.preserve_pass_rate',
    'fix',
    'higher_is_better',
    'completed_fix_cases',
    'required',
  ),
  ratio(
    'fix.side_effect_free_pass_rate',
    'fix',
    'higher_is_better',
    'completed_fix_cases',
    'required',
  ),
  ratio(
    'fix.success_rate',
    'fix',
    'higher_is_better',
    'completed_fix_cases',
    'required',
  ),
  count('fix.case_count', 'fix', 'neutral', 'diagnostic'),
  ...agentAttemptDefinitions('fix'),
  ...DEFECT_TYPES.map(
    (defectType): MetricDefinition =>
      ratio(
        `fix.defect.${defectType}.success_rate`,
        'fix',
        'higher_is_better',
        `completed_fix_${defectType}_cases`,
        'diagnostic',
      ),
  ),
  count(
    'fix.harness_error_count',
    'fix',
    'lower_is_better',
    'required',
  ),
];

export const METRIC_DEFINITIONS = defineMetricRegistry([
  ...retrievalDefinitions,
  ...faithDefinitions,
  ...judgeDefinitions,
  ...generationDefinitions,
  ...fixDefinitions,
]);

export const METRIC_DEFINITION_VERSION =
  computeMetricDefinitionVersion(METRIC_DEFINITIONS);

const METRIC_DEFINITION_BY_KEY = new Map(
  METRIC_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function metricDefinitionsForKind(
  evalKind: EvalKind,
): readonly MetricDefinition[] {
  return METRIC_DEFINITIONS.filter(
    (definition) => definition.evalKind === evalKind,
  );
}

export function assertMetricRecord(params: {
  evalKind: EvalKind;
  metricDefinitionVersion: string;
  metrics: Readonly<Record<string, MetricObservation>>;
}): void {
  const { evalKind, metricDefinitionVersion, metrics } = params;
  if (metricDefinitionVersion !== METRIC_DEFINITION_VERSION) {
    throw new Error(
      `metric definition version ${metricDefinitionVersion} is not current ${METRIC_DEFINITION_VERSION}`,
    );
  }

  for (const key of Object.keys(metrics).sort()) {
    const definition = METRIC_DEFINITION_BY_KEY.get(key);
    if (!definition) {
      throw new Error(`unregistered metric key: ${key}`);
    }
    if (definition.evalKind !== evalKind) {
      throw new Error(
        `metric key ${key} belongs to ${definition.evalKind}, not ${evalKind}`,
      );
    }

    const observation = metrics[key];
    if (!observation) {
      throw new Error(`metric observation missing for key: ${key}`);
    }
    const hasRatioComponents =
      observation.numerator !== undefined &&
      observation.denominator !== undefined;
    if (definition.denominator !== undefined && !hasRatioComponents) {
      throw new Error(
        `metric ${key} must include numerator and denominator`,
      );
    }
    if (definition.denominator === undefined && hasRatioComponents) {
      throw new Error(
        `metric ${key} must not include numerator and denominator`,
      );
    }
  }

  const missing = metricDefinitionsForKind(evalKind)
    .filter(
      (definition) =>
        definition.stability === 'required' && !(definition.key in metrics),
    )
    .map((definition) => definition.key)
    .sort();
  if (missing.length > 0) {
    throw new Error(`missing required metric keys: ${missing.join(', ')}`);
  }
}

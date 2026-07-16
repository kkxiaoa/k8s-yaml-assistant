import assert from 'node:assert/strict';
import { metricObservation, type EvalKind } from '../protocol';
import {
  METRIC_DEFINITIONS,
  METRIC_DEFINITION_VERSION,
  assertMetricRecord,
  computeMetricDefinitionVersion,
  defineMetricRegistry,
  metricDefinitionsForKind,
  type MetricDefinition,
} from './definitions';

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

const BASE_DEFINITION = {
  key: 'retrieval.test_rate',
  evalKind: 'retrieval',
  revision: 1,
  direction: 'higher_is_better',
  unit: 'ratio',
  denominator: 'completed_test_cases',
  stability: 'required',
} satisfies MetricDefinition;

function versionOf(
  overrides: Partial<MetricDefinition> = {},
): string {
  return computeMetricDefinitionVersion([
    { ...BASE_DEFINITION, ...overrides },
  ]);
}

function requiredRecord(kind: EvalKind) {
  return Object.fromEntries(
    metricDefinitionsForKind(kind)
      .filter((definition) => definition.stability === 'required')
      .map((definition) => [
        definition.key,
        definition.unit === 'ratio'
          ? metricObservation(null, 0, 0)
          : metricObservation(0),
      ]),
  );
}

console.log('metric-definitions:');

check('registry keys are globally unique and match eval kind prefixes', () => {
  assert.equal(
    new Set(METRIC_DEFINITIONS.map((definition) => definition.key)).size,
    METRIC_DEFINITIONS.length,
  );
  for (const definition of METRIC_DEFINITIONS) {
    assert.ok(
      definition.key.startsWith(`${definition.evalKind}.`),
      definition.key,
    );
  }

  assert.throws(
    () => defineMetricRegistry([BASE_DEFINITION, BASE_DEFINITION]),
    /duplicate metric key.*retrieval\.test_rate/i,
  );
  assert.throws(
    () =>
      defineMetricRegistry([
        { ...BASE_DEFINITION, evalKind: 'faith' },
      ]),
    /prefix.*faith|faith.*prefix/i,
  );
});

check('revision is a required positive integer', () => {
  for (const revision of [0, -1, 1.5]) {
    assert.throws(() =>
      defineMetricRegistry([{ ...BASE_DEFINITION, revision }]),
    );
  }
  assert.throws(() =>
    defineMetricRegistry([
      {
        key: BASE_DEFINITION.key,
        evalKind: BASE_DEFINITION.evalKind,
        direction: BASE_DEFINITION.direction,
        unit: BASE_DEFINITION.unit,
        denominator: BASE_DEFINITION.denominator,
        stability: BASE_DEFINITION.stability,
      },
    ]),
  );
});

check('ratio definitions require denominators and count-like units forbid them', () => {
  assert.throws(
    () =>
      defineMetricRegistry([
        { ...BASE_DEFINITION, denominator: undefined },
      ]),
    /ratio.*denominator|denominator.*ratio/i,
  );

  for (const unit of ['count', 'milliseconds', 'tokens', 'usd'] as const) {
    assert.throws(
      () => defineMetricRegistry([{ ...BASE_DEFINITION, unit }]),
      new RegExp(`${unit}.*denominator|denominator.*${unit}`, 'i'),
    );
  }

  assert.doesNotThrow(() =>
    defineMetricRegistry([
      { ...BASE_DEFINITION, unit: 'number' },
    ]),
  );
});

check('every definition explicitly declares required or diagnostic stability', () => {
  assert.ok(
    METRIC_DEFINITIONS.every(
      (definition) =>
        definition.stability === 'required' ||
        definition.stability === 'diagnostic',
    ),
  );
  assert.throws(() =>
    defineMetricRegistry([
      {
        key: BASE_DEFINITION.key,
        evalKind: BASE_DEFINITION.evalKind,
        revision: BASE_DEFINITION.revision,
        direction: BASE_DEFINITION.direction,
        unit: BASE_DEFINITION.unit,
        denominator: BASE_DEFINITION.denominator,
      },
    ]),
  );
});

check('registry declaration order does not affect definition version', () => {
  const second = {
    ...BASE_DEFINITION,
    key: 'retrieval.test_count',
    unit: 'count',
    denominator: undefined,
    direction: 'neutral',
    stability: 'diagnostic',
  } satisfies MetricDefinition;
  assert.equal(
    computeMetricDefinitionVersion([BASE_DEFINITION, second]),
    computeMetricDefinitionVersion([second, BASE_DEFINITION]),
  );
});

check('every semantic definition field participates in the version', () => {
  const original = versionOf();
  for (const version of [
    versionOf({ direction: 'lower_is_better' }),
    versionOf({ unit: 'number' }),
    versionOf({ denominator: 'applicable_test_cases' }),
    versionOf({ stability: 'diagnostic' }),
  ]) {
    assert.notEqual(version, original);
  }
});

check('revision changes the version when numerator or pass semantics change', () => {
  assert.notEqual(versionOf({ revision: 1 }), versionOf({ revision: 2 }));
});

check('current definition version is the canonical registry SHA-256', () => {
  assert.match(METRIC_DEFINITION_VERSION, /^[a-f0-9]{64}$/);
  assert.equal(
    METRIC_DEFINITION_VERSION,
    computeMetricDefinitionVersion(METRIC_DEFINITIONS),
  );
});

check('metric record validation enforces version, kind, registration, and completeness', () => {
  const metrics = requiredRecord('retrieval');
  assert.doesNotThrow(() =>
    assertMetricRecord({
      evalKind: 'retrieval',
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      metrics,
    }),
  );

  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: '0'.repeat(64),
        metrics,
      }),
    /metric definition version.*current/i,
  );
  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: METRIC_DEFINITION_VERSION,
        metrics: {
          ...metrics,
          'retrieval.unregistered': metricObservation(0),
        },
      }),
    /unregistered metric key.*retrieval\.unregistered/i,
  );
  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: METRIC_DEFINITION_VERSION,
        metrics: {
          ...metrics,
          'faith.judged': metricObservation(0),
        },
      }),
    /faith\.judged.*faith.*retrieval|faith.*retrieval/i,
  );

  const missingRequired = { ...metrics };
  delete missingRequired['retrieval.semantic.recall'];
  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: METRIC_DEFINITION_VERSION,
        metrics: missingRequired,
      }),
    /missing required metric.*retrieval\.semantic\.recall/i,
  );

  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: METRIC_DEFINITION_VERSION,
        metrics: {
          ...metrics,
          'retrieval.semantic.recall': metricObservation(1),
        },
      }),
    /retrieval\.semantic\.recall.*numerator.*denominator/i,
  );
  assert.throws(
    () =>
      assertMetricRecord({
        evalKind: 'retrieval',
        metricDefinitionVersion: METRIC_DEFINITION_VERSION,
        metrics: {
          ...metrics,
          'retrieval.semantic.case_count': metricObservation(1, 1, 1),
        },
      }),
    /retrieval\.semantic\.case_count.*numerator.*denominator/i,
  );
});

console.log(`\n通过 ${passed} 项`);

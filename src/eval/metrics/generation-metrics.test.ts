import assert from 'node:assert/strict';
import type { GenerateResult } from '../../server/agent';
import type { GenerationEvalCase } from '../cases/generation-cases';
import { preflightFixCases, type FixCase } from '../assertions';
import {
  buildFixCaseResult,
  buildGenerationCaseResult,
  computeFixEvalMetrics,
  computeGenerationEvalMetrics,
  fixMetricsRecord,
  generationMetricsRecord,
} from './generation-metrics';
import { metricObservation } from '../protocol';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

const validConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
`;

function result(yaml: string | null): GenerateResult {
  return {
    yaml,
    rounds: yaml ? 0 : 2,
    attempts: [
      {
        submitIndex: 1,
        yaml: yaml ?? 'bad: [',
        parseOk: yaml !== null,
        validationOk: yaml !== null,
        errors: yaml
          ? []
          : [{ path: '', message: 'YAML 解析失败: bad sequence' }],
      },
    ],
    diagnostics: yaml
      ? []
      : [{ stage: 'repair', message: '已达最大修复轮次' }],
  };
}

console.log('generation-metrics:');

check('buildGenerationCaseResult 生成结构化内容指标', () => {
  const evalCase: GenerationEvalCase = {
    id: 'gen-configmap',
    requirement: '生成名为 app-config、LOG_LEVEL=info 的 ConfigMap',
    expectedResources: [
      {
        ref: 'config',
        identity: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          name: 'app-config',
        },
        assertions: [
          { type: 'exists', path: 'data' },
          { type: 'equals', path: 'data.LOG_LEVEL', value: 'info' },
        ],
      },
    ],
    relations: [],
  };

  const item = buildGenerationCaseResult(evalCase, result(validConfigMap));

  assert.equal(item.validYaml, true);
  assert.equal(item.matchedResourceCount, 1);
  assert.equal(item.resourceAssertionPassCount, 2);
  assert.equal(item.resourceAssertionTotal, 2);
  assert.equal(item.resourceResults[0]?.match.status, 'matched');
  assert.ok(item.resourceResults[0]?.assertions.every((entry) => entry.pass));
  assert.equal(item.relationPass, null);
  assert.equal(item.contentPass, true);
});

check('wrong values fail content even when kind and paths exist', () => {
  const evalCase: GenerationEvalCase = {
    id: 'wrong-value',
    requirement: '生成 LOG_LEVEL=debug 的 ConfigMap',
    expectedResources: [
      {
        ref: 'config',
        identity: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          name: 'app-config',
        },
        assertions: [
          { type: 'equals', path: 'data.LOG_LEVEL', value: 'debug' },
        ],
      },
    ],
  };

  const item = buildGenerationCaseResult(evalCase, result(validConfigMap));
  assert.equal(item.validYaml, true);
  assert.equal(item.resourceResults[0]?.assertions[0]?.pass, false);
  assert.match(item.resourceResults[0]?.assertions[0]?.reason ?? '', /debug/);
  assert.equal(item.contentPass, false);
});

check('computeGenerationEvalMetrics 汇总资源断言、关系和完整内容', () => {
  const okCase: GenerationEvalCase = {
    id: 'ok',
    requirement: '生成 ConfigMap',
    expectedResources: [
      {
        ref: 'config',
        identity: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          name: 'app-config',
        },
        assertions: [
          { type: 'exists', path: 'data' },
          { type: 'equals', path: 'data.LOG_LEVEL', value: 'info' },
        ],
      },
    ],
  };
  const missCase: GenerationEvalCase = {
    id: 'miss',
    requirement: '生成 Secret',
    expectedResources: [
      {
        ref: 'secret',
        identity: { apiVersion: 'v1', kind: 'Secret', name: 'db-secret' },
        assertions: [{ type: 'exists', path: 'stringData.password' }],
      },
    ],
  };
  const metrics = computeGenerationEvalMetrics([
    buildGenerationCaseResult(okCase, result(validConfigMap)),
    buildGenerationCaseResult(missCase, result(null)),
  ]);

  assert.equal(metrics.caseCount, 2);
  assert.equal(metrics.validYamlCount, 1);
  assert.equal(metrics.resourceAssertionPassCount, 2);
  assert.equal(metrics.resourceAssertionCount, 3);
  assert.equal(metrics.relationCount, 0);
  assert.equal(metrics.contentPassCount, 1);
  assert.deepEqual(generationMetricsRecord(metrics), {
    'generation.avg_rounds': metricObservation(1, 2, 2),
    'generation.avg_submits': metricObservation(1, 2, 2),
    'generation.content_pass_rate': metricObservation(0.5, 1, 2),
    'generation.first_parse_ok_rate': metricObservation(0.5, 1, 2),
    'generation.first_validation_ok_rate': metricObservation(0.5, 1, 2),
    'generation.max_round_failure_rate': metricObservation(0.5, 1, 2),
    'generation.relation_pass_rate': metricObservation(null, 0, 0),
    'generation.repair_attempted_rate': metricObservation(0, 0, 2),
    'generation.repair_success_after_fail_rate': metricObservation(0, 0, 1),
    'generation.resource_assertion_pass_rate': metricObservation(2 / 3, 2, 3),
    'generation.valid_yaml_rate': metricObservation(0.5, 1, 2),
  });
});

check('no measured generation/fix cases produces N/A quality ratios', () => {
  const generation = generationMetricsRecord(computeGenerationEvalMetrics([]));
  const fix = fixMetricsRecord(computeFixEvalMetrics([]));

  for (const key of [
    'generation.valid_yaml_rate',
    'generation.resource_assertion_pass_rate',
    'generation.relation_pass_rate',
    'generation.content_pass_rate',
  ]) {
    assert.deepEqual(generation[key], metricObservation(null, 0, 0));
  }
  for (const key of [
    'fix.valid_yaml_rate',
    'fix.expected_correction_pass_rate',
    'fix.preserve_pass_rate',
    'fix.side_effect_free_pass_rate',
    'fix.success_rate',
  ]) {
    assert.deepEqual(fix[key], metricObservation(null, 0, 0));
  }
});

const fixCase: FixCase = {
  id: 'fix-configmap',
  defectType: 'unknown_field',
  brokenYaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
unexpected: true
`,
  target: { apiVersion: 'v1', kind: 'ConfigMap', name: 'app-config' },
  preserve: [{ type: 'equals', path: 'data.LOG_LEVEL', value: 'info' }],
  expectedCorrections: [
    {
      type: 'matches',
      path: 'unexpected',
      rule: { name: 'missing_or_empty' },
    },
  ],
};

const fixedConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
`;

check('buildFixCaseResult requires target-bound corrections and preservation', () => {
  const [fixture] = preflightFixCases([fixCase]);
  assert.ok(fixture);
  const item = buildFixCaseResult(fixCase, result(fixedConfigMap), fixture);

  assert.equal(item.validYaml, true);
  assert.equal(item.targetMatch.status, 'matched');
  assert.equal(item.correctionPass, true);
  assert.equal(item.preservePass, true);
  assert.equal(item.sideEffectFree, true);
  assert.equal(item.contentPass, true);
});

check('a preserve value on another document cannot satisfy the target', () => {
  const multiDocumentCase: FixCase = {
    id: 'fix-configmap',
    defectType: 'unknown_field',
    brokenYaml: `${fixCase.brokenYaml}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\ndata:\n  LOG_LEVEL: debug\n`,
    target: fixCase.target,
    preserve: fixCase.preserve,
    expectedCorrections: fixCase.expectedCorrections,
  };
  const [fixture] = preflightFixCases([multiDocumentCase]);
  assert.ok(fixture);
  const swappedValue = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: debug
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: other
data:
  LOG_LEVEL: info
`;

  const item = buildFixCaseResult(
    multiDocumentCase,
    result(swappedValue),
    fixture,
  );
  assert.equal(item.validYaml, true);
  assert.equal(item.correctionPass, true);
  assert.equal(item.sideEffectFree, true);
  assert.equal(item.preservePass, false);
  assert.equal(item.preserveResults[0]?.pass, false);
  assert.equal(item.contentPass, false);
});

check('an added resource fails an otherwise correct repair', () => {
  const [fixture] = preflightFixCases([fixCase]);
  assert.ok(fixture);
  const withExtra = `${fixedConfigMap}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: unrequested\ntype: Opaque\n`;
  const item = buildFixCaseResult(fixCase, result(withExtra), fixture);

  assert.equal(item.validYaml, true);
  assert.equal(item.correctionPass, true);
  assert.equal(item.preservePass, true);
  assert.equal(item.sideEffectFree, false);
  assert.equal(item.contentPass, false);
});

check('changing the target identity fails even when repaired fields are valid', () => {
  const [fixture] = preflightFixCases([fixCase]);
  assert.ok(fixture);
  const renamed = fixedConfigMap.replace('name: app-config', 'name: renamed');
  const item = buildFixCaseResult(fixCase, result(renamed), fixture);

  assert.equal(item.validYaml, true);
  assert.equal(item.targetMatch.status, 'missing');
  assert.equal(item.correctionPass, false);
  assert.equal(item.preservePass, false);
  assert.equal(item.sideEffectFree, false);
  assert.equal(item.contentPass, false);
});

check('fix metrics count complete acceptance rather than valid YAML alone', () => {
  const [fixture] = preflightFixCases([fixCase]);
  assert.ok(fixture);
  const passedItem = buildFixCaseResult(
    fixCase,
    result(fixedConfigMap),
    fixture,
  );
  const failedItem = buildFixCaseResult(
    { ...fixCase, id: 'fix-configmap-side-effect' },
    result(`${fixedConfigMap}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: unrequested\ntype: Opaque\n`),
    { ...fixture, caseId: 'fix-configmap-side-effect' },
  );

  const metrics = computeFixEvalMetrics([passedItem, failedItem]);

  assert.equal(metrics.validYamlCount, 2);
  assert.equal(metrics.correctionPassCount, 2);
  assert.equal(metrics.preservePassCount, 2);
  assert.equal(metrics.sideEffectFreePassCount, 1);
  assert.equal(metrics.contentPassCount, 1);
  assert.deepEqual(fixMetricsRecord(metrics), {
    'fix.avg_rounds': metricObservation(0, 0, 2),
    'fix.avg_submits': metricObservation(1, 2, 2),
    'fix.defect.unknown_field.success_rate': metricObservation(0.5, 1, 2),
    'fix.expected_correction_pass_rate': metricObservation(1, 2, 2),
    'fix.first_parse_ok_rate': metricObservation(1, 2, 2),
    'fix.first_validation_ok_rate': metricObservation(1, 2, 2),
    'fix.max_round_failure_rate': metricObservation(0, 0, 2),
    'fix.preserve_pass_rate': metricObservation(1, 2, 2),
    'fix.repair_attempted_rate': metricObservation(0, 0, 2),
    'fix.repair_success_after_fail_rate': metricObservation(null, 0, 0),
    'fix.side_effect_free_pass_rate': metricObservation(0.5, 1, 2),
    'fix.success_rate': metricObservation(0.5, 1, 2),
    'fix.valid_yaml_rate': metricObservation(1, 2, 2),
  });
});

console.log(`\n通过 ${passed} 项`);

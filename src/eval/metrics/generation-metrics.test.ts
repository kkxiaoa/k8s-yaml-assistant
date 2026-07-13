import assert from 'node:assert/strict';
import type { GenerateResult } from '../../server/agent';
import type { GenerationEvalCase } from '../cases/generation-cases';
import type { FixEvalCase } from '../cases/fix-cases';
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
    requirement: '生成 ConfigMap',
    expectedKinds: ['ConfigMap'],
    mustHavePaths: ['metadata.name', 'data'],
  };

  const item = buildGenerationCaseResult(evalCase, result(validConfigMap));

  assert.equal(item.validYaml, true);
  assert.equal(item.kindMatch, true);
  assert.deepEqual(item.requiredPathHits, ['metadata.name', 'data']);
  assert.equal(item.requiredPathCoverage, 1);
  assert.equal(item.consistencyPass, null);
  assert.equal(item.contentPass, true);
});

check('computeGenerationEvalMetrics 汇总合法率和内容覆盖', () => {
  const okCase: GenerationEvalCase = {
    id: 'ok',
    requirement: '生成 ConfigMap',
    expectedKinds: ['ConfigMap'],
    mustHavePaths: ['metadata.name', 'data'],
  };
  const missCase: GenerationEvalCase = {
    id: 'miss',
    requirement: '生成 Secret',
    expectedKinds: ['Secret'],
    mustHavePaths: ['metadata.name'],
  };
  const metrics = computeGenerationEvalMetrics([
    buildGenerationCaseResult(okCase, result(validConfigMap)),
    buildGenerationCaseResult(missCase, result(null)),
  ]);

  assert.equal(metrics.caseCount, 2);
  assert.equal(metrics.validYamlCount, 1);
  assert.equal(metrics.kindMatchCount, 1);
  assert.equal(metrics.requiredPathCoverageAvg, 1);
  assert.deepEqual(generationMetricsRecord(metrics), {
    'generation.avg_rounds': metricObservation(1, 2, 2),
    'generation.avg_submits': metricObservation(1, 2, 2),
    'generation.consistency_pass_rate': metricObservation(null, 0, 0),
    'generation.first_parse_ok_rate': metricObservation(0.5, 1, 2),
    'generation.first_validation_ok_rate': metricObservation(0.5, 1, 2),
    'generation.kind_match_rate': metricObservation(1, 1, 1),
    'generation.max_round_failure_rate': metricObservation(0.5, 1, 2),
    'generation.repair_attempted_rate': metricObservation(0, 0, 2),
    'generation.repair_success_after_fail_rate': metricObservation(0, 0, 1),
    'generation.required_path_coverage': metricObservation(1, 1, 1),
    'generation.valid_yaml_rate': metricObservation(0.5, 1, 2),
  });
});

check('buildFixCaseResult 和 fix metrics 统计 kind/意图保留', () => {
  const fixCase: FixEvalCase = {
    id: 'fix-configmap',
    defect: 'parse error',
    defectType: 'parse_error',
    brokenYaml: 'bad: [',
    expectedKind: 'ConfigMap',
    mustPreserve: [{ path: 'metadata.name', value: 'app-config' }],
  };

  const item = buildFixCaseResult(fixCase, result(validConfigMap));
  const metrics = computeFixEvalMetrics([item]);

  assert.equal(item.validYaml, true);
  assert.equal(item.kindKept, true);
  assert.equal(item.intentPreserved, true);
  assert.equal(metrics.validYamlCount, 1);
  assert.deepEqual(fixMetricsRecord(metrics), {
    'fix.avg_rounds': metricObservation(0, 0, 1),
    'fix.avg_submits': metricObservation(1, 1, 1),
    'fix.defect.parse_error.success_rate': metricObservation(1, 1, 1),
    'fix.first_parse_ok_rate': metricObservation(1, 1, 1),
    'fix.first_validation_ok_rate': metricObservation(1, 1, 1),
    'fix.intent_preserved_rate': metricObservation(1, 1, 1),
    'fix.kind_kept_rate': metricObservation(1, 1, 1),
    'fix.max_round_failure_rate': metricObservation(0, 0, 1),
    'fix.preserve_coverage': metricObservation(1, 1, 1),
    'fix.repair_attempted_rate': metricObservation(0, 0, 1),
    'fix.repair_success_after_fail_rate': metricObservation(null, 0, 0),
    'fix.success_rate': metricObservation(1, 1, 1),
  });
});

console.log(`\n通过 ${passed} 项`);

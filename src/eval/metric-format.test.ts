import assert from 'node:assert/strict';
import {
  formatMetricDelta,
  formatMetricValue,
  isPercentMetric,
} from './metric-format';

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

console.log('metric-format:');

check('rate/coverage/recall/mrr 按百分比显示', () => {
  assert.equal(isPercentMetric('generation.valid_yaml_rate'), true);
  assert.equal(isPercentMetric('fix.preserve_coverage'), true);
  assert.equal(isPercentMetric('serving.recall@3'), true);
  assert.equal(isPercentMetric('serving.mrr@3'), true);
  assert.equal(formatMetricValue('generation.valid_yaml_rate', 0.875), '87.5%');
  assert.equal(formatMetricDelta('serving.recall@3', -0.012), '-1.2%');
});

check('avg/count 按普通数值显示', () => {
  assert.equal(isPercentMetric('generation.avg_rounds'), false);
  assert.equal(isPercentMetric('judge.judged'), false);
  assert.equal(formatMetricValue('generation.avg_rounds', 1.25), '1.250');
  assert.equal(formatMetricValue('judge.judged', 20), '20');
  assert.equal(formatMetricDelta('generation.avg_rounds', 0.5), '+0.500');
});

console.log(`\n通过 ${passed} 项`);

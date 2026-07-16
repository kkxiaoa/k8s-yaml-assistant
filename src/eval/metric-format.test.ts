import assert from 'node:assert/strict';
import { ratioObservation } from './protocol';
import {
  formatMetricDelta,
  formatMetricObservation,
  formatMetricValue,
} from './metric-format';

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

console.log('metric-format:');

check('ratio formatting uses registry unit and includes sample counts', () => {
  assert.equal(formatMetricValue('ratio', 0.875), '87.5%');
  assert.equal(formatMetricDelta('ratio', -0.012), '-1.2%');
  assert.equal(
    formatMetricObservation('ratio', ratioObservation(7, 8)),
    '87.5% (7/8)',
  );
  assert.equal(
    formatMetricObservation('ratio', ratioObservation(0, 0)),
    'N/A (0/0)',
  );
});

check('number and count formatting no longer infer unit from metric key', () => {
  assert.equal(formatMetricValue('number', 1.25), '1.250');
  assert.equal(formatMetricValue('count', 20), '20');
  assert.equal(formatMetricDelta('number', 0.5), '+0.500');
});

check('declared latency, token, and cost units retain their units', () => {
  assert.equal(formatMetricValue('milliseconds', 12.5), '12.500 ms');
  assert.equal(formatMetricValue('tokens', 128), '128 tokens');
  assert.equal(formatMetricValue('usd', 0.012345), '$0.012345');
});

console.log(`\n通过 ${passed} 项`);

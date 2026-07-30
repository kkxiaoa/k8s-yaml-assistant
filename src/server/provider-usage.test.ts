import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelUsageCollector } from './provider-usage';

test('供应商 usage 按固定保守价格汇总为整数微美元', () => {
  const usage = new ModelUsageCollector();
  usage.requestStarted('deepseek');
  usage.deepSeekUsage(
    'deepseek-v4-flash',
    1_000_000,
    1_000_000,
    500_000,
    500_000,
  );
  usage.requestStarted('voyage');
  usage.voyageEmbeddingUsage('voyage-3', 1_000_000);
  usage.voyageRerankUsage('rerank-2.5', 1_000_000);

  assert.equal(usage.hasStartedRequest(), true);
  assert.equal(usage.settledCostMicrousd(), 670_000);
});

test('费用向上取整，缺失或非法 usage 拒绝按实际值结算', () => {
  const rounded = new ModelUsageCollector();
  rounded.requestStarted('deepseek');
  rounded.deepSeekUsage('deepseek-v4-flash', 1, 1);
  assert.equal(rounded.settledCostMicrousd(), 2);

  const missing = new ModelUsageCollector();
  missing.requestStarted('deepseek');
  missing.deepSeekUsage('deepseek-v4-flash', undefined, 1);
  assert.equal(missing.settledCostMicrousd(), null);

  const invalid = new ModelUsageCollector();
  invalid.requestStarted('voyage');
  invalid.voyageEmbeddingUsage('voyage-4', 1);
  assert.equal(invalid.settledCostMicrousd(), null);
});

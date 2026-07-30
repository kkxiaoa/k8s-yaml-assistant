import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelRouteAvailability } from './experience-control';

test('模型操作按真实供应商依赖和各自点数独立表达可用性', () => {
  assert.deepEqual(
    resolveModelRouteAvailability(null, null, {
      deepseek: true,
      retrieval: false,
    }),
    {
      ask: { enabled: false, reason: 'runtime_config_invalid' },
      generate: { enabled: true, reason: null },
      fix: { enabled: true, reason: null },
    },
  );
  assert.deepEqual(
    resolveModelRouteAvailability(null, null, {
      deepseek: false,
      retrieval: true,
    }),
    {
      ask: { enabled: false, reason: 'runtime_config_invalid' },
      generate: { enabled: false, reason: 'runtime_config_invalid' },
      fix: { enabled: false, reason: 'runtime_config_invalid' },
    },
  );
  assert.deepEqual(
    resolveModelRouteAvailability(null, 2, {
      deepseek: true,
      retrieval: true,
    }),
    {
      ask: { enabled: true, reason: null },
      generate: { enabled: false, reason: 'quota_exhausted' },
      fix: { enabled: false, reason: 'quota_exhausted' },
    },
  );
});

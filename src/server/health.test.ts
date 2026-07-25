import assert from 'node:assert/strict';
import test from 'node:test';
import type { IndexMissReason } from '../retrieval/index-store';
import {
  createHealthService,
  getLiveness,
  readinessCodeForIndexMiss,
  type HealthCheckDependencies,
} from './health';

function validDependencies(): HealthCheckDependencies {
  return {
    validateRuntimeConfig: async () => undefined,
    validateSchema: async () => undefined,
    validatePolicy: async () => undefined,
    loadAliases: async () => ({ ok: true }),
    loadIndex: async () => ({ ok: true }),
  };
}

test('liveness 不读取索引或调用供应商', () => {
  let dependencyCalls = 0;
  const unavailable = () => {
    dependencyCalls++;
    throw new Error('DeepSeek/Voyage unavailable');
  };
  const health = createHealthService({
    validateRuntimeConfig: unavailable,
    validateSchema: unavailable,
    validatePolicy: unavailable,
    loadAliases: unavailable,
    loadIndex: unavailable,
  });

  assert.deepEqual(health.liveness(), { status: 'live' });
  assert.deepEqual(getLiveness(), { status: 'live' });
  assert.equal(dependencyCalls, 0);
});

test('runtime config 失败映射为不含原值的封闭健康码', async () => {
  const rawValue = 'http://user:RawCredential@invalid.internal';
  const health = createHealthService({
    ...validDependencies(),
    validateRuntimeConfig: async () => {
      throw new Error(rawValue);
    },
  });

  const status = await health.readiness();
  assert.deepEqual(status, {
    status: 'not_ready',
    code: 'runtime_config_invalid',
  });
  assert.equal(JSON.stringify(status).includes(rawValue), false);
});

test('readiness 失败只返回稳定错误码并缓存首次结果', async () => {
  const sensitiveDetail =
    '/private/data/index hash=deadbeef VOYAGE_API_KEY=fixture-secret';
  let schemaCalls = 0;
  let policyCalls = 0;
  const health = createHealthService({
    ...validDependencies(),
    validateSchema: async () => {
      schemaCalls++;
      throw new Error(sensitiveDetail);
    },
    validatePolicy: async () => {
      policyCalls++;
    },
  });

  const firstPromise = health.readiness();
  const secondPromise = health.readiness();
  assert.strictEqual(secondPromise, firstPromise);
  const first = await firstPromise;
  const second = await health.readiness();

  assert.strictEqual(second, first);
  assert.deepEqual(first, { status: 'not_ready', code: 'schema_invalid' });
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes('/private/data/index'), false);
  assert.equal(serialized.includes('deadbeef'), false);
  assert.equal(serialized.includes('VOYAGE_API_KEY'), false);
  assert.equal(serialized.includes('fixture-secret'), false);
  assert.equal(schemaCalls, 1);
  assert.equal(policyCalls, 0);
});

test('schema、policy 与 alias 失败映射到封闭错误码', async () => {
  const cases: Array<{
    name: string;
    dependencies: HealthCheckDependencies;
    code: string;
  }> = [
    {
      name: 'schema',
      dependencies: {
        ...validDependencies(),
        validateSchema: async () => {
          throw new Error('schema /absolute/path');
        },
      },
      code: 'schema_invalid',
    },
    {
      name: 'policy',
      dependencies: {
        ...validDependencies(),
        validatePolicy: async () => {
          throw new Error('policy private detail');
        },
      },
      code: 'policy_invalid',
    },
    {
      name: 'aliases missing',
      dependencies: {
        ...validDependencies(),
        loadAliases: async () => ({
          ok: false,
          errorCode: 'aliases_missing',
        }),
      },
      code: 'aliases_missing',
    },
    {
      name: 'aliases invalid',
      dependencies: {
        ...validDependencies(),
        loadAliases: async () => ({
          ok: false,
          errorCode: 'aliases_invalid',
        }),
      },
      code: 'aliases_invalid',
    },
  ];

  for (const candidate of cases) {
    const result = await createHealthService(
      candidate.dependencies,
    ).readiness();
    assert.deepEqual(
      result,
      { status: 'not_ready', code: candidate.code },
      candidate.name,
    );
    assert.deepEqual(Object.keys(result).sort(), ['code', 'status']);
  }
});

test('所有索引 miss reason 收敛为有限 readiness 错误码', async () => {
  const cases: Array<[IndexMissReason, string]> = [
    ['missing_files', 'index_missing'],
    ['incomplete_files', 'index_missing'],
    ['corpus_count_mismatch', 'index_identity_mismatch'],
    ['corpus_manifest_mismatch', 'index_identity_mismatch'],
    ['embedding_model_mismatch', 'index_identity_mismatch'],
    ['index_hash_mismatch', 'index_identity_mismatch'],
    ['read_error', 'index_invalid'],
    ['format_mismatch', 'index_invalid'],
    ['invalid_manifest', 'index_invalid'],
    ['chunk_count_mismatch', 'index_invalid'],
    ['invalid_chunk', 'index_invalid'],
    ['duplicate_chunk_id', 'index_invalid'],
    ['embedding_dimension_mismatch', 'index_invalid'],
    ['invalid_embedding', 'index_invalid'],
  ];

  for (const [reason, code] of cases) {
    assert.equal(readinessCodeForIndexMiss(reason), code, reason);
    const health = createHealthService({
      ...validDependencies(),
      loadIndex: async () => ({ ok: false, reason }),
    });
    const result = await health.readiness();
    assert.deepEqual(result, { status: 'not_ready', code }, reason);
    assert.equal(JSON.stringify(result).includes(reason), false, reason);
  }
});

test('有效初始化只执行一次，readiness 与业务门禁复用同一状态', async () => {
  const calls = { config: 0, schema: 0, policy: 0, aliases: 0, index: 0 };
  const health = createHealthService({
    validateRuntimeConfig: async () => {
      calls.config++;
    },
    validateSchema: async () => {
      calls.schema++;
    },
    validatePolicy: async () => {
      calls.policy++;
    },
    loadAliases: async () => {
      calls.aliases++;
      return { ok: true };
    },
    loadIndex: async () => {
      calls.index++;
      return { ok: true };
    },
  });

  const readinessProbe = health.readiness();
  const askGate = health.readiness();
  assert.strictEqual(askGate, readinessProbe);
  assert.deepEqual(await readinessProbe, { status: 'ready' });
  assert.deepEqual(await health.readiness(), { status: 'ready' });
  assert.deepEqual(calls, {
    config: 1,
    schema: 1,
    policy: 1,
    aliases: 1,
    index: 1,
  });
});

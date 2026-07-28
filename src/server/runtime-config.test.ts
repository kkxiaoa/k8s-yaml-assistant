import assert from 'node:assert/strict';
import test from 'node:test';
import { POST as askPost } from '../../app/api/ask/route';
import { POST as checkPost } from '../../app/api/check/route';
import { POST as fixPost } from '../../app/api/fix/route';
import { POST as generatePost } from '../../app/api/generate/route';
import {
  decodeRuntimeConfig,
  getRuntimeCapabilityStatus,
  type RuntimeEnvironment,
} from './runtime-config';

const VALID_ENV = {
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
  DEEPSEEK_ANSWER_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_API_KEY: 'TestDeepSeekCredentialValue123',
  VOYAGE_EMBEDDING_URL: 'https://api.voyageai.com/v1/embeddings',
  VOYAGE_RERANK_URL: 'https://api.voyageai.com/v1/rerank',
  VOYAGE_EMBEDDING_MODEL: 'voyage-3',
  VOYAGE_RERANK_MODEL: 'rerank-2.5',
  VOYAGE_API_KEY: 'TestVoyageCredentialValue456',
  INDEX_DIR: 'data/index',
  ENABLE_QUERY_EXPANSION: 'true',
} as const;

const REQUIRED_NON_SECRET_FIELDS = [
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_ANSWER_MODEL',
  'VOYAGE_EMBEDDING_URL',
  'VOYAGE_RERANK_URL',
  'VOYAGE_EMBEDDING_MODEL',
  'VOYAGE_RERANK_MODEL',
  'INDEX_DIR',
  'ENABLE_QUERY_EXPANSION',
] as const;

function decode(overrides: RuntimeEnvironment = {}) {
  return decodeRuntimeConfig({ ...VALID_ENV, ...overrides });
}

async function withEnvironment<T>(
  environment: RuntimeEnvironment,
  run: () => Promise<T>,
): Promise<T> {
  const keys = new Set([...Object.keys(VALID_ENV), ...Object.keys(environment)]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('显式配置解码为无 Secret 的稳定快照', () => {
  const result = decode();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.config, {
    deepseek: {
      baseUrl: 'https://api.deepseek.com/anthropic',
    },
    voyage: {
      embeddingUrl: 'https://api.voyageai.com/v1/embeddings',
      rerankUrl: 'https://api.voyageai.com/v1/rerank',
      embeddingModel: 'voyage-3',
      rerankModel: 'rerank-2.5',
    },
    indexDir: 'data/index',
    queryExpansionEnabled: true,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(VALID_ENV.DEEPSEEK_API_KEY), false);
  assert.equal(serialized.includes(VALID_ENV.VOYAGE_API_KEY), false);
  assert.equal('answerModel' in result.config.deepseek, false);
});

test('缺失任一显式非 Secret 配置时封闭失败', () => {
  for (const field of REQUIRED_NON_SECRET_FIELDS) {
    assert.deepEqual(decode({ [field]: undefined }), {
      ok: false,
      error: { code: 'missing_value', field },
    });
  }
});

test('拒绝非 HTTPS、含凭据或带查询片段的供应商 URL', () => {
  const cases: Array<[string, string]> = [
    ['DEEPSEEK_BASE_URL', 'http://api.deepseek.com/anthropic'],
    [
      'DEEPSEEK_BASE_URL',
      'https://user:password@api.deepseek.com/anthropic',
    ],
    [
      'VOYAGE_EMBEDDING_URL',
      'https://api.voyageai.com/v1/embeddings?credential=raw-value',
    ],
    [
      'VOYAGE_RERANK_URL',
      'https://api.voyageai.com/v1/rerank#private-fragment',
    ],
  ];

  for (const [field, rawValue] of cases) {
    const result = decode({ [field]: rawValue });
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'invalid_value', field },
    });
    assert.equal(JSON.stringify(result).includes(rawValue), false);
  }
});

test('只接受显式 Flash 作答身份、合法 Voyage 模型和严格布尔值', () => {
  const cases: Array<[string, string]> = [
    ['DEEPSEEK_ANSWER_MODEL', 'claude-sonnet-4-6'],
    ['DEEPSEEK_ANSWER_MODEL', 'deepseek-v4-pro'],
    ['VOYAGE_EMBEDDING_MODEL', 'voyage 3'],
    ['VOYAGE_RERANK_MODEL', 'rerank/latest'],
    ['ENABLE_QUERY_EXPANSION', 'TRUE'],
    ['ENABLE_QUERY_EXPANSION', '1'],
    ['INDEX_DIR', ' data/index '],
  ];

  for (const [field, rawValue] of cases) {
    const result = decode({ [field]: rawValue });
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'invalid_value', field },
    });
    assert.equal(JSON.stringify(result).includes(rawValue), false);
  }

  const disabled = decode({ ENABLE_QUERY_EXPANSION: 'false' });
  assert.equal(disabled.ok, true);
  if (disabled.ok) assert.equal(disabled.config.queryExpansionEnabled, false);
});

test('拒绝未知供应商配置字段但忽略无关进程环境', () => {
  assert.deepEqual(decode({ DEEPSEEK_API_VERISON: 'secret-like-value' }), {
    ok: false,
    error: { code: 'unknown_field', field: 'DEEPSEEK_API_VERISON' },
  });
  assert.equal(decode({ NODE_ENV: 'production' }).ok, true);
});

test('Secret 缺失只关闭对应模型能力且不污染配置错误', () => {
  assert.deepEqual(
    getRuntimeCapabilityStatus('deepseek', {
      ...VALID_ENV,
      DEEPSEEK_API_KEY: undefined,
    }),
    { ok: false, code: 'deepseek_unavailable' },
  );
  assert.deepEqual(
    getRuntimeCapabilityStatus('voyage', {
      ...VALID_ENV,
      VOYAGE_API_KEY: undefined,
    }),
    { ok: false, code: 'voyage_unavailable' },
  );
  assert.deepEqual(
    getRuntimeCapabilityStatus('deepseek', {
      ...VALID_ENV,
      DEEPSEEK_BASE_URL: 'raw-invalid-url-value',
    }),
    { ok: false, code: 'runtime_config_invalid' },
  );
});

test('DeepSeek key 缺失时 Generate/Fix 返回安全 503，Check 仍可用', async () => {
  await withEnvironment(
    { ...VALID_ENV, DEEPSEEK_API_KEY: undefined },
    async () => {
      const generate = await generatePost(
        new Request('http://localhost/api/generate', {
          method: 'POST',
          body: JSON.stringify({ requirement: '创建一个 Pod' }),
        }),
      );
      assert.equal(generate.status, 503);
      assert.deepEqual(await generate.json(), {
        error: { code: 'deepseek_unavailable' },
      });

      const fix = await fixPost(
        new Request('http://localhost/api/fix', {
          method: 'POST',
          body: JSON.stringify({ yaml: 'apiVersion: v1\nkind: Pod' }),
        }),
      );
      assert.equal(fix.status, 503);
      assert.deepEqual(await fix.json(), {
        error: { code: 'deepseek_unavailable' },
      });

      const check = await checkPost(
        new Request('http://localhost/api/check', {
          method: 'POST',
          body: JSON.stringify({ yaml: 'kind: [' }),
        }),
      );
      assert.equal(check.status, 200);
      assert.ok(Array.isArray((await check.json()).errors));
    },
  );
});

test('Voyage key 缺失时 Ask 在读取索引和调用供应商前安全返回 503', async () => {
  await withEnvironment(
    { ...VALID_ENV, VOYAGE_API_KEY: undefined },
    async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls++;
        throw new Error('supplier should not be called');
      }) as typeof fetch;
      try {
        const response = await askPost(
          new Request('http://localhost/api/ask', {
            method: 'POST',
            body: JSON.stringify({ question: 'Pod 的 image 字段是什么？' }),
          }),
        );
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: { code: 'voyage_unavailable' },
        });
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('Generate 将 DeepSeek 余额错误收敛为不含原始响应体的 503', async () => {
  await withEnvironment(VALID_ENV, async () => {
    const originalFetch = globalThis.fetch;
    const rawBody = 'billing response includes TestCredentialValue999';
    globalThis.fetch = (async () =>
      Response.json(
        { error: { type: 'billing_error', message: rawBody } },
        { status: 402 },
      )) as typeof fetch;
    try {
      const response = await generatePost(
        new Request('http://localhost/api/generate', {
          method: 'POST',
          body: JSON.stringify({ requirement: '创建一个 Pod' }),
        }),
      );
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: { code: 'upstream_balance_exhausted' },
      });
      assert.equal(text.includes(rawBody), false);
      assert.equal(text.includes('TestCredentialValue999'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { embed } from '../retrieval/embeddings';
import { rerank } from '../retrieval/rerank';
import { getClient } from './pipeline';
import { RuntimeConfigFault } from './runtime-config';
import {
  assertModelInputByteBudget,
  DEEPSEEK_CLIENT_POLICY,
  ModelInputBudgetError,
  VOYAGE_REQUEST_TIMEOUT_MS,
} from './model-request-policy';
import {
  UpstreamHttpError,
  classifyUpstreamError,
  upstreamErrorEvent,
  upstreamErrorResponse,
} from './upstream-error';

const SUPPLIER_ENV = {
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
  DEEPSEEK_ANSWER_MODEL: 'deepseek-v4-flash',
  DEEPSEEK_API_KEY: 'TestDeepSeekCredentialValue123',
  VOYAGE_EMBEDDING_URL: 'https://embedding.test.invalid/v1/embeddings',
  VOYAGE_RERANK_URL: 'https://rerank.test.invalid/v1/rerank',
  VOYAGE_EMBEDDING_MODEL: 'voyage-3',
  VOYAGE_RERANK_MODEL: 'rerank-2.5',
  VOYAGE_API_KEY: 'TestVoyageCredentialValue456',
  INDEX_DIR: 'data/index',
  ENABLE_QUERY_EXPANSION: 'true',
} as const;

async function withSupplierEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(SUPPLIER_ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
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

test('超时、认证、余额、配额和服务故障映射为有限 503 错误码', () => {
  const cases: Array<[unknown, string]> = [
    [new APIConnectionTimeoutError({ message: 'raw timeout detail' }), 'upstream_timeout'],
    [new UpstreamHttpError(401), 'upstream_authentication_failed'],
    [new UpstreamHttpError(403), 'upstream_authentication_failed'],
    [new UpstreamHttpError(402), 'upstream_balance_exhausted'],
    [new UpstreamHttpError(429), 'upstream_quota_exceeded'],
    [new UpstreamHttpError(500), 'upstream_unavailable'],
    [new UpstreamHttpError(504), 'upstream_unavailable'],
  ];

  for (const [error, code] of cases) {
    assert.deepEqual(classifyUpstreamError(error), { status: 503, code });
  }
});

test('请求拒绝和未知错误映射为有限 502 且不包含原始错误体', async () => {
  const rejected = new UpstreamHttpError(400);
  assert.deepEqual(classifyUpstreamError(rejected), {
    status: 502,
    code: 'upstream_request_rejected',
  });

  const raw = 'supplier body contains TestSecretCredential123';
  const unknown = new Error(raw);
  assert.deepEqual(classifyUpstreamError(unknown), {
    status: 502,
    code: 'upstream_error',
  });

  const response = upstreamErrorResponse(unknown);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes(raw), false);
  assert.equal(body.includes('TestSecretCredential123'), false);
  assert.deepEqual(JSON.parse(body), { error: { code: 'upstream_error' } });

  const event = upstreamErrorEvent(unknown);
  assert.deepEqual(event, { code: 'upstream_error' });
  assert.equal(JSON.stringify(event).includes(raw), false);
});

test('模型请求序列化字节预算超限时在上游调用前返回安全 413', async () => {
  assert.doesNotThrow(() =>
    assertModelInputByteBudget({
      messages: [{ role: 'user', content: 'normal input' }],
    }),
  );
  assert.throws(
    () =>
      assertModelInputByteBudget({
        messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }],
      }),
    ModelInputBudgetError,
  );
  const response = upstreamErrorResponse(new ModelInputBudgetError());
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: { code: 'model_input_too_large' },
  });
});

test('DeepSeek 和 Voyage 使用固定超时且不隐藏额外计费重试', async () => {
  assert.deepEqual(DEEPSEEK_CLIENT_POLICY, {
    timeout: 60_000,
    maxRetries: 0,
  });
  assert.equal(VOYAGE_REQUEST_TIMEOUT_MS, 30_000);

  await withSupplierEnvironment(async () => {
    const client = getClient();
    assert.equal(client.timeout, DEEPSEEK_CLIENT_POLICY.timeout);
    assert.equal(client.maxRetries, DEEPSEEK_CLIENT_POLICY.maxRetries);
  });
});

test('运行时配置与能力故障沿用安全 503 码', () => {
  for (const code of [
    'runtime_config_invalid',
    'deepseek_unavailable',
    'voyage_unavailable',
  ] as const) {
    const error = new RuntimeConfigFault(code);
    assert.deepEqual(classifyUpstreamError(error), { status: 503, code });
    assert.deepEqual(upstreamErrorEvent(error), { code });
  }
});

test('上游错误对象不保存供应商响应体', () => {
  const error = new UpstreamHttpError(402);
  assert.equal(error.message, 'upstream request failed');
  assert.equal(JSON.stringify(error).includes('balance'), false);
  assert.equal('provider' in error, false);
  assert.equal(error.status, 402);
});

test('Voyage embedding/rerank 不透传上游错误体并使用显式端点与模型', async () => {
  await withSupplierEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      url: string;
      body: unknown;
      signal: AbortSignal | null | undefined;
    }> = [];
    const rawBody = 'supplier raw body TestCredentialValue789';
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        signal: init?.signal,
      });
      const status = requests.length === 1 ? 402 : 429;
      return new Response(rawBody, { status });
    }) as typeof fetch;

    try {
      let embeddingError: unknown;
      try {
        await embed(['Pod image'], 'query');
      } catch (error) {
        embeddingError = error;
      }
      assert.deepEqual(classifyUpstreamError(embeddingError), {
        status: 503,
        code: 'upstream_balance_exhausted',
      });
      assert.equal(String(embeddingError).includes(rawBody), false);

      let rerankError: unknown;
      try {
        await rerank('Pod image', ['container image field'], 1);
      } catch (error) {
        rerankError = error;
      }
      assert.deepEqual(classifyUpstreamError(rerankError), {
        status: 503,
        code: 'upstream_quota_exceeded',
      });
      assert.equal(String(rerankError).includes(rawBody), false);

      assert.deepEqual(requests, [
        {
          url: SUPPLIER_ENV.VOYAGE_EMBEDDING_URL,
          body: {
            input: ['Pod image'],
            model: 'voyage-3',
            input_type: 'query',
          },
          signal: requests[0]!.signal,
        },
        {
          url: SUPPLIER_ENV.VOYAGE_RERANK_URL,
          body: {
            query: 'Pod image',
            documents: ['container image field'],
            model: 'rerank-2.5',
            top_k: 1,
          },
          signal: requests[1]!.signal,
        },
      ]);
      for (const request of requests) {
        assert.ok(request.signal instanceof AbortSignal);
        assert.equal(request.signal.aborted, false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

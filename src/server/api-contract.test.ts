import assert from 'node:assert/strict';
import test from 'node:test';
import { POST as checkPost } from '../../app/api/check/route';
import { readApiRequest } from './api-contract';
import { GLOBAL_MAX_BODY_BYTES } from './request-body';

type ApiRoute =
  | 'adminExperience'
  | 'ask'
  | 'check'
  | 'feedback'
  | 'generate'
  | 'fix';

const VALID_REQUESTS = {
  adminExperience: { mode: 'interview', durationHours: 4 },
  ask: {
    question: '解释 spec.replicas',
    mode: 'explain_field',
    context: {
      yaml: 'apiVersion: apps/v1\nkind: Deployment',
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      selectedText: 'replicas: 2',
      cursorPath: 'spec.replicas',
      errors: [{ path: 'spec.replicas', message: '类型应为 integer' }],
    },
  },
  check: { yaml: 'apiVersion: v1\nkind: Pod' },
  feedback: {
    requestId: '11111111-1111-4111-8111-111111111111',
    rating: 'good',
  },
  generate: { requirement: '创建一个 nginx Deployment' },
  fix: {
    yaml: 'apiVersion: v1\nkind: Pod',
    errors: [{ path: 'spec.containers', message: 'containers 必填' }],
  },
} as const;

async function decodeOutcome(
  route: ApiRoute,
  input: unknown,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; body: unknown }
> {
  const result = await readApiRequest(
    new Request(`http://localhost/api/${route}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    route,
  );
  if (result.ok) return result;
  return {
    ok: false,
    status: result.response.status,
    body: await result.response.json(),
  };
}

test('业务与管理路由接受严格合法输入且补齐显式默认值', async () => {
  assert.deepEqual(await decodeOutcome('ask', { question: ' Pod 是什么？ ' }), {
    ok: true,
    value: { question: 'Pod 是什么？', mode: 'free' },
  });
  assert.deepEqual(
    await decodeOutcome('fix', { yaml: ' apiVersion: v1\nkind: Pod ' }),
    {
      ok: true,
      value: { yaml: ' apiVersion: v1\nkind: Pod ', errors: [] },
    },
  );

  for (const route of Object.keys(VALID_REQUESTS) as ApiRoute[]) {
    assert.equal((await decodeOutcome(route, VALID_REQUESTS[route])).ok, true);
  }
  assert.deepEqual(
    await decodeOutcome('feedback', {
      requestId: '11111111-1111-4111-8111-111111111111',
      rating: 'bad',
      reason: 'insufficient_evidence',
    }),
    {
      ok: true,
      value: {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'bad',
        reason: 'insufficient_evidence',
      },
    },
  );
  assert.equal(
    (
      await decodeOutcome('feedback', {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: null,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await decodeOutcome('feedback', {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'bad',
        reason: 'unintended_changes',
      })
    ).ok,
    true,
  );
});

test('顶层和嵌套 unknown field 均被拒绝', async () => {
  for (const route of Object.keys(VALID_REQUESTS) as ApiRoute[]) {
    const result = await decodeOutcome(route, {
      ...VALID_REQUESTS[route],
      unexpected: 'TestUnknownFieldSecret123',
    });
    assert.deepEqual(result, {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    });
    assert.equal(JSON.stringify(result).includes('TestUnknownFieldSecret123'), false);
  }

  assert.deepEqual(
    await decodeOutcome('ask', {
      question: '解释字段',
      context: { yaml: 'kind: Pod', injected: true },
    }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
  assert.deepEqual(
    await decodeOutcome('fix', {
      yaml: 'kind: Pod',
      errors: [{ path: 'spec', message: 'invalid', detail: 'raw YAML' }],
    }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
});

test('错误类型、空白必填值、非法 mode/context/errors 被拒绝', async () => {
  const cases: Array<[ApiRoute, unknown]> = [
    ['ask', { question: 1 }],
    ['ask', { question: '   ' }],
    ['ask', { question: '解释', mode: 'EXPLAIN_FIELD' }],
    ['ask', { question: '解释', context: [] }],
    ['ask', { question: '解释', context: { kind: '  ' } }],
    ['check', { yaml: false }],
    ['check', { yaml: ' \n\t ' }],
    ['generate', { requirement: [] }],
    ['generate', { requirement: '\n' }],
    ['fix', { yaml: null }],
    ['fix', { yaml: 'kind: Pod', errors: 'invalid' }],
    ['fix', { yaml: 'kind: Pod', errors: [{ path: 1, message: 'x' }] }],
    ['fix', { yaml: 'kind: Pod', errors: [{ path: '', message: '   ' }] }],
    ['feedback', { requestId: 'not-a-uuid', rating: 'good' }],
    [
      'feedback',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'useful',
      },
    ],
    [
      'feedback',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'bad',
      },
    ],
    [
      'feedback',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'good',
        reason: 'incorrect_or_incomplete',
      },
    ],
    [
      'feedback',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: null,
        reason: 'other',
      },
    ],
    [
      'feedback',
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        rating: 'bad',
        reason: 'raw_text',
      },
    ],
    ['adminExperience', { mode: 'interview', durationHours: 2 }],
    ['adminExperience', { mode: 'sleep', durationHours: 4 }],
  ];

  for (const [route, value] of cases) {
    assert.deepEqual(await decodeOutcome(route, value), {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    });
  }
});

test('字符串和数组资源预算在解码边界生效', async () => {
  assert.deepEqual(
    await decodeOutcome('ask', { question: '问'.repeat(16 * 1024 + 1) }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
  assert.deepEqual(
    await decodeOutcome('check', { yaml: 'a'.repeat(128 * 1024 + 1) }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
  assert.deepEqual(
    await decodeOutcome('generate', {
      requirement: '需'.repeat(16 * 1024 + 1),
    }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
  assert.deepEqual(
    await decodeOutcome('fix', {
      yaml: 'kind: Pod',
      errors: Array.from({ length: 257 }, () => ({
        path: 'spec',
        message: 'invalid',
      })),
    }),
    {
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_request' } },
    },
  );
});

test('每条路由字节预算均为正整数且不超过全局 256 KiB', async () => {
  const limits: Record<ApiRoute, number> = {
    adminExperience: 1024,
    ask: 256 * 1024,
    check: 144 * 1024,
    feedback: 1024,
    generate: 72 * 1024,
    fix: 256 * 1024,
  };
  for (const [route, limit] of Object.entries(limits) as Array<
    [ApiRoute, number]
  >) {
    assert.equal(Number.isSafeInteger(limit), true, route);
    assert.ok(limit > 0, route);
    assert.ok(limit <= GLOBAL_MAX_BODY_BYTES, route);
    const result = await readApiRequest(
      new Request(`http://localhost/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Length': String(limit + 1) },
        body: '{}',
      }),
      route,
    );
    if (result.ok) assert.fail(`${route} accepted an oversized request`);
    assert.equal(result.response.status, 413, route);
  }
});

test('路由返回不回显请求内容的稳定 400/413 错误', async () => {
  const sensitiveValue = 'TestRouteBodyValue123';
  const invalidRequest = new Request('http://localhost/api/check', {
    method: 'POST',
    body: JSON.stringify({ yaml: 'kind: Pod', unexpected: sensitiveValue }),
  });
  const invalidResponse = await checkPost(invalidRequest);
  assert.equal(invalidResponse.status, 400);
  const invalidText = await invalidResponse.text();
  assert.deepEqual(JSON.parse(invalidText), {
    error: { code: 'invalid_request' },
  });
  assert.equal(invalidText.includes(sensitiveValue), false);

  const oversizedResponse = await checkPost(
    new Request('http://localhost/api/check', {
      method: 'POST',
      headers: {
        'Content-Length': String(144 * 1024 + 1),
      },
      body: JSON.stringify({ yaml: 'kind: Pod' }),
    }),
  );
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: { code: 'payload_too_large' },
  });

  const malformedResponse = await checkPost(
    new Request('http://localhost/api/check', {
      method: 'POST',
      body: '{"yaml":"TestMalformedSecret123"',
    }),
  );
  assert.equal(malformedResponse.status, 400);
  const malformedText = await malformedResponse.text();
  assert.deepEqual(JSON.parse(malformedText), {
    error: { code: 'invalid_json' },
  });
  assert.equal(malformedText.includes('TestMalformedSecret123'), false);
});

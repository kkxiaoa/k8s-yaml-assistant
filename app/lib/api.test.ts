import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiRequestError,
  askStream,
  checkYaml,
  fixYaml,
  generateYaml,
  getAdminExperience,
  getExperience,
  getGithubSignInUrl,
  setAdminExperience,
  submitResponseFeedback,
} from './api';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

test('browser API requests use the fixed application base path', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let githubSignInBody: URLSearchParams | null = null;
  let feedbackBody: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({
      url,
      method:
        init?.method ??
        (input instanceof Request ? input.method : 'GET'),
    });
    if (url.endsWith('/api/ask')) {
      return new Response(
        `event: sources\ndata: []\n\nevent: done\ndata: {"requestId":"${REQUEST_ID}"}\n\n`,
      );
    }
    if (url.endsWith('/api/check')) {
      return Response.json({ errors: [] });
    }
    if (url.endsWith('/api/auth/csrf')) {
      return Response.json({ csrfToken: 'csrf-token' });
    }
    if (url.endsWith('/api/auth/signin/github')) {
      if (init?.body instanceof URLSearchParams) {
        githubSignInBody = init.body;
      }
      return Response.json({
        url: 'https://github.com/login/oauth/authorize?client_id=test',
      });
    }
    if (url.endsWith('/api/admin/experience')) {
      return Response.json({
        mode: 'sleep',
        interviewExpiresAt: null,
        feedback: {
          retentionDays: 35,
          total: { good: 0, bad: 0 },
          routes: {
            ask: { good: 0, bad: 0 },
            generate: { good: 0, bad: 0 },
            fix: { good: 0, bad: 0 },
          },
          badReasons: {
            incorrect_or_incomplete: 0,
            not_what_i_asked: 0,
            insufficient_evidence: 0,
            unintended_changes: 0,
            unusable_result: 0,
            slow_or_buggy: 0,
            other: 0,
          },
        },
      });
    }
    if (url.endsWith('/api/experience')) {
      return Response.json({
        authenticated: false,
        user: null,
        mode: 'sleep',
        quota: null,
        model: {
          ask: { enabled: false, reason: 'sleep_mode' },
          generate: { enabled: false, reason: 'sleep_mode' },
          fix: { enabled: false, reason: 'sleep_mode' },
        },
      });
    }
    if (url.endsWith('/api/feedback')) {
      feedbackBody = String(init?.body);
      return Response.json({ rating: 'good' });
    }
    return Response.json({
      yaml: 'apiVersion: v1\nkind: ConfigMap',
      rounds: 0,
      requestId: REQUEST_ID,
    });
  }) as typeof fetch;

  try {
    await checkYaml('apiVersion: v1');
    await askStream(
      'what is this',
      'free',
      { yaml: 'apiVersion: v1' },
      { onSources() {}, onDelta() {} },
    );
    await generateYaml('create a ConfigMap');
    await fixYaml('apiVersion: v1', []);
    await getExperience();
    await getAdminExperience();
    await setAdminExperience({ mode: 'sleep' });
    await submitResponseFeedback(REQUEST_ID, { rating: 'good' });
    assert.equal(
      await getGithubSignInUrl('/k8s-yaml-assistant/admin'),
      'https://github.com/login/oauth/authorize?client_id=test',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    { url: '/k8s-yaml-assistant/api/check', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/ask', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/generate', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/fix', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/experience', method: 'GET' },
    { url: '/k8s-yaml-assistant/api/admin/experience', method: 'GET' },
    { url: '/k8s-yaml-assistant/api/admin/experience', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/feedback', method: 'POST' },
    { url: '/k8s-yaml-assistant/api/auth/csrf', method: 'GET' },
    {
      url: '/k8s-yaml-assistant/api/auth/signin/github',
      method: 'POST',
    },
  ]);
  assert.ok(githubSignInBody);
  assert.deepEqual(
    Object.fromEntries(githubSignInBody),
    {
      csrfToken: 'csrf-token',
      callbackUrl: '/k8s-yaml-assistant/admin',
      json: 'true',
    },
  );
  assert.deepEqual(JSON.parse(feedbackBody ?? ''), {
    requestId: REQUEST_ID,
    rating: 'good',
  });
});

test('feedback client preserves good, explained bad, and cancellation selections', async () => {
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const { requestId: _requestId, ...selection } = body;
    return Response.json(selection);
  }) as typeof fetch;

  try {
    assert.deepEqual(
      await submitResponseFeedback(REQUEST_ID, { rating: 'good' }),
      { rating: 'good' },
    );
    assert.deepEqual(
      await submitResponseFeedback(REQUEST_ID, {
        rating: 'bad',
        reason: 'not_what_i_asked',
      }),
      { rating: 'bad', reason: 'not_what_i_asked' },
    );
    assert.deepEqual(
      await submitResponseFeedback(REQUEST_ID, { rating: null }),
      { rating: null },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(bodies, [
    { requestId: REQUEST_ID, rating: 'good' },
    {
      requestId: REQUEST_ID,
      rating: 'bad',
      reason: 'not_what_i_asked',
    },
    { requestId: REQUEST_ID, rating: null },
  ]);
});

test('feedback client rejects a response that drifts from the submitted selection', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      rating: 'bad',
      reason: 'other',
    })) as typeof fetch;
  try {
    await assert.rejects(
      submitResponseFeedback(REQUEST_ID, {
        rating: 'bad',
        reason: 'not_what_i_asked',
      }),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API failures expose stable user-safe errors instead of silent results', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      Response.json(
        { error: { code: 'model_access_disabled' } },
        { status: 503 },
      )) as typeof fetch;
    await assert.rejects(
      generateYaml('create a ConfigMap'),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.code === 'model_access_disabled' &&
        error.message.includes('模型功能当前已关闭'),
    );

    globalThis.fetch = (async () =>
      new Response('<html>upstream denied the request</html>', {
        status: 403,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
    await assert.rejects(
      fixYaml('apiVersion: v1', []),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.code === 'access_denied' &&
        !error.message.includes('upstream denied'),
    );

    globalThis.fetch = (async () =>
      new Response(
        'event: error\ndata: {"code":"upstream_quota_exceeded"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    await assert.rejects(
      askStream(
        'what is this',
        'free',
        { yaml: 'apiVersion: v1' },
        { onSources() {}, onDelta() {} },
      ),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.code === 'upstream_quota_exceeded',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('成功结果只接受服务端请求编号，未生成合法 YAML 时没有反馈目标', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response('event: sources\ndata: []\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    await assert.rejects(
      askStream(
        'what is this',
        'free',
        { yaml: 'apiVersion: v1' },
        { onSources() {}, onDelta() {} },
      ),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );

    globalThis.fetch = (async () =>
      Response.json({ yaml: 'kind: Pod', rounds: 0, requestId: 'invalid' })) as typeof fetch;
    await assert.rejects(
      generateYaml('create a Pod'),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );

    globalThis.fetch = (async () =>
      Response.json({ yaml: 'kind: Pod', rounds: 0, requestId: null })) as typeof fetch;
    await assert.rejects(
      generateYaml('create a Pod'),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );

    globalThis.fetch = (async () =>
      Response.json({ yaml: null, rounds: 0, requestId: REQUEST_ID })) as typeof fetch;
    await assert.rejects(
      fixYaml('kind: Pod', []),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );

    globalThis.fetch = (async () =>
      Response.json({
        yaml: 'kind: Pod',
        rounds: -1,
        requestId: REQUEST_ID,
      })) as typeof fetch;
    await assert.rejects(
      generateYaml('create a Pod'),
      (error: unknown) =>
        error instanceof ApiRequestError && error.code === 'empty_response',
    );

    globalThis.fetch = (async () =>
      Response.json({ yaml: null, rounds: 2, requestId: null })) as typeof fetch;
    assert.deepEqual(await fixYaml('kind: Pod', []), {
      yaml: null,
      rounds: 2,
      requestId: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

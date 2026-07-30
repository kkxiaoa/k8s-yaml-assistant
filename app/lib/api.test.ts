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
} from './api';

test('browser API requests use the fixed application base path', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let githubSignInBody: URLSearchParams | null = null;
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
      return new Response('event: sources\ndata: []\n\n');
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
      return Response.json({ mode: 'sleep', interviewExpiresAt: null });
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
    return Response.json({ yaml: null, rounds: 0 });
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

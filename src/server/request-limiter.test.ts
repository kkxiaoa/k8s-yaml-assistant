import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitApiRequest,
  createRequestLimiter,
  modelAccessGate,
} from './request-limiter';

test('候选 token bucket 速率和突发值按路由独立生效', () => {
  let now = 0;
  const limiter = createRequestLimiter(() => now);

  for (let index = 0; index < 20; index += 1) {
    const permit = limiter.tryAcquire('check', 'kkxiaoa');
    assert.equal(permit.ok, true);
    if (permit.ok) permit.release();
  }
  assert.deepEqual(limiter.tryAcquire('check', 'kkxiaoa'), {
    ok: false,
    reason: 'rate',
    retryAfterSeconds: 1,
  });

  now += 1_000;
  const refilled = limiter.tryAcquire('check', 'kkxiaoa');
  assert.equal(refilled.ok, true);
  if (refilled.ok) refilled.release();

  const askOne = limiter.tryAcquire('ask', 'kkxiaoa');
  const askTwo = limiter.tryAcquire('ask', 'kkxiaoa');
  assert.equal(askOne.ok, true);
  assert.equal(askTwo.ok, false);
  if (!askTwo.ok) {
    assert.equal(askTwo.reason, 'concurrency');
  }
  if (askOne.ok) askOne.release();

  const askAfterRelease = limiter.tryAcquire('ask', 'kkxiaoa');
  assert.equal(askAfterRelease.ok, true);
  if (askAfterRelease.ok) askAfterRelease.release();
  assert.deepEqual(limiter.tryAcquire('ask', 'kkxiaoa'), {
    ok: false,
    reason: 'rate',
    retryAfterSeconds: 10,
  });

  const generate = limiter.tryAcquire('generate', 'kkxiaoa');
  assert.equal(generate.ok, true);
  if (generate.ok) generate.release();
  assert.deepEqual(limiter.tryAcquire('generate', 'kkxiaoa'), {
    ok: false,
    reason: 'rate',
    retryAfterSeconds: 30,
  });

  const fix = limiter.tryAcquire('fix', 'kkxiaoa');
  assert.equal(fix.ok, true);
  if (fix.ok) fix.release();
  assert.deepEqual(limiter.tryAcquire('fix', 'kkxiaoa'), {
    ok: false,
    reason: 'rate',
    retryAfterSeconds: 20,
  });
});

test('模型路由共享全局并发且每个主体最多一个请求', () => {
  const limiter = createRequestLimiter(() => 0);
  const first = limiter.tryAcquire('ask', 'subject-a');
  assert.equal(first.ok, true);

  assert.deepEqual(limiter.tryAcquire('fix', 'subject-a'), {
    ok: false,
    reason: 'concurrency',
    retryAfterSeconds: 1,
  });

  const second = limiter.tryAcquire('generate', 'subject-b');
  assert.equal(second.ok, true);
  assert.deepEqual(limiter.tryAcquire('ask', 'subject-c'), {
    ok: false,
    reason: 'concurrency',
    retryAfterSeconds: 1,
  });

  if (first.ok) {
    first.release();
    first.release();
  }
  const replacement = limiter.tryAcquire('ask', 'subject-c');
  assert.equal(replacement.ok, true);

  if (second.ok) second.release();
  if (replacement.ok) replacement.release();
});

test('check 使用独立并发池且匿名键固定', () => {
  const limiter = createRequestLimiter(() => 0);
  const permits = Array.from({ length: 4 }, () =>
    limiter.tryAcquire('check', null),
  );
  assert.equal(permits.every((permit) => permit.ok), true);
  assert.deepEqual(limiter.tryAcquire('check', null), {
    ok: false,
    reason: 'concurrency',
    retryAfterSeconds: 1,
  });
  for (const permit of permits) {
    if (permit.ok) permit.release();
  }
});

test('模型紧急开关只有精确 true 才放行且不泄露配置', async () => {
  assert.equal(modelAccessGate({ MODEL_ACCESS_ENABLED: 'true' }), null);
  for (const value of [undefined, '', 'TRUE', '1', 'false']) {
    const response = modelAccessGate({ MODEL_ACCESS_ENABLED: value });
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: { code: 'model_access_disabled' },
    });
  }
});

test('应用入口把速率和并发拒绝映射为不回显主体的 429', async () => {
  const rateSubject = 'rate-response-subject';
  const first = admitApiRequest('generate', rateSubject);
  assert.equal(first.ok, true);
  if (first.ok) first.release();
  const rateLimited = admitApiRequest('generate', rateSubject);
  assert.equal(rateLimited.ok, false);
  if (rateLimited.ok) return;
  assert.equal(rateLimited.response.status, 429);
  assert.equal(rateLimited.response.headers.get('Retry-After'), '30');
  const rateText = await rateLimited.response.text();
  assert.deepEqual(JSON.parse(rateText), {
    error: { code: 'rate_limited' },
  });
  assert.equal(rateText.includes(rateSubject), false);

  const concurrencySubject = 'concurrency-response-subject';
  const active = admitApiRequest('ask', concurrencySubject);
  assert.equal(active.ok, true);
  const concurrencyLimited = admitApiRequest('fix', concurrencySubject);
  assert.equal(concurrencyLimited.ok, false);
  if (!concurrencyLimited.ok) {
    assert.equal(concurrencyLimited.response.status, 429);
    assert.equal(
      concurrencyLimited.response.headers.get('Retry-After'),
      '1',
    );
    assert.deepEqual(await concurrencyLimited.response.json(), {
      error: { code: 'concurrency_limited' },
    });
  }
  if (active.ok) active.release();
});

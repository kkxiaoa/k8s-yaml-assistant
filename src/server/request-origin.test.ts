import assert from 'node:assert/strict';
import test from 'node:test';
import { hasValidApplicationOrigin } from './request-origin';

function request(origin: string | null): Request {
  return new Request('https://example.test/api/feedback', {
    headers: origin === null ? undefined : { Origin: origin },
  });
}

test('生产写入只接受精确 HTTPS 应用来源', () => {
  const environment = {
    NODE_ENV: 'production',
    APP_PUBLIC_ORIGIN: 'https://example.test',
  };
  assert.equal(
    hasValidApplicationOrigin(request('https://example.test'), environment),
    true,
  );
  assert.equal(
    hasValidApplicationOrigin(request('https://attacker.test'), environment),
    false,
  );
  assert.equal(hasValidApplicationOrigin(request(null), environment), false);
});

test('开发环境只额外允许显式回环 HTTP 来源', () => {
  assert.equal(
    hasValidApplicationOrigin(request('http://localhost:3000'), {
      NODE_ENV: 'development',
      APP_PUBLIC_ORIGIN: 'http://localhost:3000',
    }),
    true,
  );
  assert.equal(
    hasValidApplicationOrigin(request('http://dev.example.test'), {
      NODE_ENV: 'development',
      APP_PUBLIC_ORIGIN: 'http://dev.example.test',
    }),
    false,
  );
});

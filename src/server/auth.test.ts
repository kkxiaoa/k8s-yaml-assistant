import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from 'next-auth';
import {
  createAuthOptions,
  identityFromSession,
  isAdminGithubId,
} from './auth';

const AUTH_ENV = {
  GITHUB_ID: 'client-id',
  GITHUB_SECRET: 'client-secret',
  NEXTAUTH_SECRET: 'session-secret',
  ADMIN_GITHUB_ID: '12345',
} as const;

test('GitHub 登录只请求 read:user 并只读取稳定用户身份接口', async () => {
  const requests: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({
      id: 12345,
      login: 'kkxiaoa',
      name: null,
      email: null,
      avatar_url: 'https://avatars.githubusercontent.com/u/12345',
    });
  }) as typeof fetch;
  const options = createAuthOptions(AUTH_ENV, fakeFetch);
  const provider = options.providers[0] as unknown as {
    options: {
      authorization: { params: { scope: string } };
      httpOptions: { timeout: number };
      userinfo: {
        request: (context: {
          tokens: { access_token: string };
        }) => Promise<unknown>;
      };
    };
  };

  assert.equal(provider.options.authorization.params.scope, 'read:user');
  assert.equal(provider.options.httpOptions.timeout, 15_000);
  const profile = await provider.options.userinfo.request({
    tokens: { access_token: 'test-access-token' },
  });
  assert.deepEqual(requests, ['https://api.github.com/user']);
  assert.deepEqual(profile, {
    id: 12345,
    login: 'kkxiaoa',
    name: 'kkxiaoa',
    email: '',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  });
});

test('JWT 只保留稳定身份，会话单独派生管理员事实', async () => {
  const options = createAuthOptions(AUTH_ENV);
  const jwt = options.callbacks?.jwt;
  const session = options.callbacks?.session;
  assert.ok(jwt);
  assert.ok(session);

  const token = await jwt({
    token: {},
    account: { provider: 'github' },
    profile: { id: 12345, login: 'kkxiaoa' },
  } as never);
  assert.deepEqual(token, {
    githubId: '12345',
    login: 'kkxiaoa',
  });

  const value = await session({
    session: { expires: '2099-01-01T00:00:00.000Z' },
    token,
  } as never);
  assert.deepEqual(value, {
    expires: '2099-01-01T00:00:00.000Z',
    user: {
      githubId: '12345',
      login: 'kkxiaoa',
      admin: true,
    },
  });
  assert.equal(JSON.stringify(value).includes('test-access-token'), false);
});

test('管理员只按稳定数字编号判断，畸形会话不产生身份', () => {
  assert.equal(isAdminGithubId('12345', AUTH_ENV), true);
  assert.equal(isAdminGithubId('12346', AUTH_ENV), false);
  assert.equal(
    isAdminGithubId('12345', {
      ...AUTH_ENV,
      ADMIN_GITHUB_ID: 'kkxiaoa',
    }),
    false,
  );
  assert.equal(
    identityFromSession({
      expires: '2099-01-01T00:00:00.000Z',
      user: {
        githubId: '12345',
        login: 'invalid_login',
        admin: true,
      },
    } as Session),
    null,
  );
});

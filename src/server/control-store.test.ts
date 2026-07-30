import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import Database from 'better-sqlite3';
import {
  ControlStore,
  ReservationRejected,
} from './control-store';
import { MODEL_ROUTE_LEASE_MS } from './experience-control';

const NOW = Date.parse('2026-07-29T04:00:00.000Z');
const directories: string[] = [];

function controlStore(): { directory: string; store: ControlStore } {
  const directory = mkdtempSync(join(tmpdir(), 'kya-control-test-'));
  directories.push(directory);
  return {
    directory,
    store: new ControlStore(
      join(directory, 'control.sqlite3'),
      Buffer.alloc(32, 7),
    ),
  };
}

function makeAvailable(store: ControlStore, now = NOW): void {
  store.setAdminState({ mode: 'normal' }, now);
}

const USER_SUBJECT = {
  kind: 'authenticated',
  id: '12345',
  admin: false,
} as const;
const ADMIN_SUBJECT = {
  kind: 'authenticated',
  id: '999',
  admin: true,
} as const;

function rejectionCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    assert.ok(error instanceof ReservationRejected);
    return error.code;
  }
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

test('新库从休眠开始且休眠关闭模型', () => {
  const { store } = controlStore();
  assert.deepEqual(store.getAdminState(NOW), {
    mode: 'sleep',
    interviewExpiresAt: null,
  });
  assert.equal(store.experienceAccess(USER_SUBJECT, NOW).mode, 'sleep');
  assert.equal(
    store.experienceAccess(USER_SUBJECT, NOW).reason,
    'sleep_mode',
  );
  store.setAdminState({ mode: 'normal' }, NOW);
  assert.equal(store.experienceAccess(USER_SUBJECT, NOW).mode, 'normal');
  assert.equal(store.experienceAccess(USER_SUBJECT, NOW).reason, null);
  store.close();
});

test('普通与开放展示额度共享当日累计，管理员只绕过个人点数', () => {
  const { store } = controlStore();
  makeAvailable(store);
  for (let index = 0; index < 10; index += 1) {
    const reservation = store.reserve(
      {
        requestId: `normal-${index}`,
        subject: USER_SUBJECT,
        route: 'ask',
      },
      NOW,
    );
    store.settle(reservation, 0, NOW);
  }
  assert.equal(
    rejectionCode(() =>
      store.reserve(
        {
          requestId: 'normal-over',
          subject: USER_SUBJECT,
          route: 'ask',
        },
        NOW,
      ),
    ),
    'quota_exhausted',
  );

  store.setAdminState(
    { mode: 'interview', durationHours: 4 },
    NOW,
  );
  for (let index = 0; index < 40; index += 1) {
    const reservation = store.reserve(
      {
        requestId: `interview-${index}`,
        subject: USER_SUBJECT,
        route: 'ask',
      },
      NOW,
    );
    store.settle(reservation, 0, NOW);
  }
  assert.equal(
    rejectionCode(() =>
      store.reserve(
        {
          requestId: 'interview-over',
          subject: USER_SUBJECT,
          route: 'ask',
        },
        NOW,
      ),
    ),
    'quota_exhausted',
  );
  assert.equal(store.getAdminState(NOW + 4 * 60 * 60_000 + 1).mode, 'normal');
  store.close();
});

test('匿名体验包跨自然日共用七点且与登录额度隔离', () => {
  const { store } = controlStore();
  makeAvailable(store);
  const anonymous = {
    kind: 'anonymous',
    id: USER_SUBJECT.id,
    admin: false,
  } as const;
  assert.deepEqual(store.experienceAccess(anonymous, NOW).quota, {
    limited: true,
    limit: 7,
    remaining: 7,
    resetsAt: null,
  });

  for (const [route, credits] of [
    ['generate', 3],
    ['fix', 3],
    ['ask', 1],
  ] as const) {
    const reservation = store.reserve(
      {
        requestId: `anonymous-${route}`,
        subject: anonymous,
        route,
      },
      NOW,
    );
    store.settle(reservation, credits, NOW);
  }
  assert.deepEqual(
    store.experienceAccess(
      anonymous,
      NOW + 24 * 60 * 60_000,
    ).quota,
    {
      limited: true,
      limit: 7,
      remaining: 0,
      resetsAt: null,
    },
  );
  store.setAdminState({ mode: 'interview', durationHours: 4 }, NOW);
  assert.deepEqual(store.experienceAccess(anonymous, NOW).quota, {
    limited: true,
    limit: 7,
    remaining: 0,
    resetsAt: null,
  });
  assert.deepEqual(store.experienceAccess(USER_SUBJECT, NOW).quota, {
    limited: true,
    limit: 50,
    remaining: 50,
    resetsAt: '2026-07-29T16:00:00.000Z',
  });
  store.close();
});

test('全局费用预留、租约失败关闭和休眠对管理员同样生效', () => {
  const { store } = controlStore();
  makeAvailable(store);
  const expired = store.reserve(
    {
      requestId: 'expired',
      subject: ADMIN_SUBJECT,
      route: 'ask',
    },
    NOW,
  );
  assert.equal(
    store.experienceAccess(
      ADMIN_SUBJECT,
      NOW + MODEL_ROUTE_LEASE_MS.ask + 1,
    ).reason,
    null,
  );

  for (let index = 0; index < 9; index += 1) {
    const reservation = store.reserve(
      {
        requestId: `budget-${index}`,
        subject: ADMIN_SUBJECT,
        route: 'ask',
      },
      NOW + MODEL_ROUTE_LEASE_MS.ask + 1,
    );
    store.chargeMax(reservation, NOW + MODEL_ROUTE_LEASE_MS.ask + 1);
  }
  assert.equal(
    rejectionCode(() =>
      store.reserve(
        {
          requestId: 'budget-over',
          subject: ADMIN_SUBJECT,
          route: 'ask',
        },
        NOW + MODEL_ROUTE_LEASE_MS.ask + 1,
      ),
    ),
    'global_budget_exhausted',
  );

  store.setAdminState(
    { mode: 'sleep' },
    NOW + MODEL_ROUTE_LEASE_MS.ask + 1,
  );
  assert.equal(
    rejectionCode(() =>
      store.reserve(
        {
          requestId: 'admin-sleep',
          subject: ADMIN_SUBJECT,
          route: 'ask',
        },
        NOW + MODEL_ROUTE_LEASE_MS.ask + 1,
      ),
    ),
    'sleep_mode',
  );
  assert.ok(expired.requestId);
  store.close();
});

test('账本不保存原始 GitHub 身份并清理超过 35 天的已完成项', () => {
  const { directory, store } = controlStore();
  const oldNow = NOW - 36 * 24 * 60 * 60_000;
  store.setAdminState({ mode: 'normal' }, oldNow);
  const reservation = store.reserve(
    {
      requestId: 'privacy-request',
      subject: {
        kind: 'authenticated',
        id: '987654321012345678',
        admin: false,
      },
      route: 'ask',
    },
    oldNow,
  );
  store.settle(reservation, 0, oldNow);
  store.experienceAccess(USER_SUBJECT, NOW);
  store.close();

  const databasePath = join(directory, 'control.sqlite3');
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM request_ledger')
      .get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    database.close();
  }
  const bytes = readdirSync(directory)
    .map((name) => readFileSync(join(directory, name)))
    .map((value) => value.toString('utf8'))
    .join('');
  assert.equal(bytes.includes('987654321012345678'), false);
});

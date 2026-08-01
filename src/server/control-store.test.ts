import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import Database from 'better-sqlite3';
import {
  ControlStateFault,
  ControlStore,
  ReservationRejected,
} from './control-store';
import {
  MODEL_ROUTE_LEASE_MS,
  RESPONSE_FEEDBACK_REASONS,
} from './experience-control';

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

function createVersionOneDatabase(path: string): void {
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE experience_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('normal', 'interview', 'sleep')),
        interview_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO experience_state (
        id, mode, interview_expires_at, updated_at
      ) VALUES (1, 'normal', NULL, ${NOW});

      CREATE TABLE request_ledger (
        request_id TEXT PRIMARY KEY,
        subject_hash TEXT NOT NULL,
        quota_day TEXT NOT NULL,
        route TEXT NOT NULL CHECK (route IN ('ask', 'generate', 'fix')),
        credits INTEGER NOT NULL CHECK (credits >= 0),
        state TEXT NOT NULL CHECK (
          state IN ('reserved', 'settled', 'charged_max')
        ),
        reserved_cost_microusd INTEGER NOT NULL CHECK (
          reserved_cost_microusd >= 0
        ),
        settled_cost_microusd INTEGER NOT NULL CHECK (
          settled_cost_microusd >= 0
        ),
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX request_ledger_subject_day
        ON request_ledger (subject_hash, quota_day, state);
      CREATE INDEX request_ledger_day
        ON request_ledger (quota_day, state);
      INSERT INTO request_ledger (
        request_id, subject_hash, quota_day, route, credits, state,
        reserved_cost_microusd, settled_cost_microusd,
        lease_expires_at, created_at, completed_at
      ) VALUES (
        'existing-v1-request', 'existing-subject-hash', '2026-07-29',
        'ask', 1, 'settled', 100000, 10, ${NOW}, ${NOW}, ${NOW}
      );
      PRAGMA user_version = 1;
    `);
  } finally {
    database.close();
  }
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

test('版本初始化后半段失败时回滚此前创建的 schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kya-control-test-'));
  directories.push(directory);
  const path = join(directory, 'control.sqlite3');
  const existing = new Database(path);
  try {
    existing.exec('CREATE TABLE request_ledger (marker TEXT)');
  } finally {
    existing.close();
  }

  assert.throws(() => new ControlStore(path, Buffer.alloc(32, 7)));

  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables, [{ name: 'request_ledger' }]);
    assert.equal(database.pragma('user_version', { simple: true }), 0);
  } finally {
    database.close();
  }
});

test('v1 到 v2 事务迁移保留既有状态与账本', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kya-control-test-'));
  directories.push(directory);
  const path = join(directory, 'control.sqlite3');
  createVersionOneDatabase(path);

  const store = new ControlStore(path, Buffer.alloc(32, 7));
  assert.deepEqual(store.getAdminState(NOW), {
    mode: 'normal',
    interviewExpiresAt: null,
  });
  store.close();

  const database = new Database(path, { fileMustExist: true });
  try {
    assert.equal(database.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(
      database
        .prepare(
          `SELECT request_id, route, state
           FROM request_ledger WHERE request_id = 'existing-v1-request'`,
        )
        .get(),
      {
        request_id: 'existing-v1-request',
        route: 'ask',
        state: 'settled',
      },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'response_feedback'`,
        )
        .get(),
      { name: 'response_feedback' },
    );
    for (const reason of RESPONSE_FEEDBACK_REASONS) {
      database
        .prepare(
          `INSERT INTO response_feedback (request_id, rating, reason)
           VALUES ('existing-v1-request', 'bad', ?)`,
        )
        .run(reason);
      database
        .prepare(
          `DELETE FROM response_feedback
           WHERE request_id = 'existing-v1-request'`,
        )
        .run();
    }
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO response_feedback (request_id, rating, reason)
           VALUES ('existing-v1-request', 'bad', NULL)`,
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO response_feedback (request_id, rating, reason)
           VALUES (
             'existing-v1-request', 'good', 'incorrect_or_incomplete'
           )`,
        )
        .run(),
    );
  } finally {
    database.close();
  }
});

test('v1 到 v2 迁移冲突时版本与既有数据不前移', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kya-control-test-'));
  directories.push(directory);
  const path = join(directory, 'control.sqlite3');
  createVersionOneDatabase(path);
  const existing = new Database(path);
  try {
    existing.exec('CREATE TABLE response_feedback (marker TEXT)');
  } finally {
    existing.close();
  }

  assert.throws(() => new ControlStore(path, Buffer.alloc(32, 7)));

  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(database.pragma('user_version', { simple: true }), 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT request_id FROM request_ledger
           WHERE request_id = 'existing-v1-request'`,
        )
        .get(),
      { request_id: 'existing-v1-request' },
    );
  } finally {
    database.close();
  }
});

test('管理员状态行缺失时更新失败关闭', () => {
  const { directory, store } = controlStore();
  const path = join(directory, 'control.sqlite3');
  store.close();

  const database = new Database(path);
  try {
    assert.equal(
      database.prepare('DELETE FROM experience_state WHERE id = 1').run()
        .changes,
      1,
    );
  } finally {
    database.close();
  }

  const reopened = new ControlStore(path, Buffer.alloc(32, 7));
  try {
    assert.throws(
      () => reopened.setAdminState({ mode: 'normal' }, NOW),
      ControlStateFault,
    );
  } finally {
    reopened.close();
  }
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

test('反馈只关联当前主体的完成请求且选择可切换或取消', () => {
  const { store } = controlStore();
  makeAvailable(store);
  const ask = store.reserve(
    { requestId: 'feedback-ask', subject: USER_SUBJECT, route: 'ask' },
    NOW,
  );
  assert.equal(
    store.setResponseFeedback({
      requestId: ask.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'good' },
    }, NOW),
    'target_not_found',
  );
  store.settle(ask, 0, NOW);
  assert.equal(
    store.setResponseFeedback({
      requestId: ask.requestId,
      subject: { ...USER_SUBJECT, id: '54321' },
      selection: { rating: 'good' },
    }, NOW),
    'target_not_found',
  );
  assert.equal(
    store.setResponseFeedback({
      requestId: ask.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'good' },
    }, NOW),
    'saved',
  );
  const generate = store.reserve(
    {
      requestId: 'feedback-generate',
      subject: USER_SUBJECT,
      route: 'generate',
    },
    NOW,
  );
  store.settle(generate, 0, NOW);
  assert.equal(
    store.setResponseFeedback({
      requestId: generate.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'bad', reason: 'insufficient_evidence' },
    }, NOW),
    'invalid_selection',
  );
  assert.equal(
    store.setResponseFeedback({
      requestId: generate.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'good' },
    }, NOW),
    'saved',
  );
  const fix = store.reserve(
    { requestId: 'feedback-fix', subject: USER_SUBJECT, route: 'fix' },
    NOW,
  );
  store.settle(fix, 0, NOW);
  assert.equal(
    store.setResponseFeedback({
      requestId: fix.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'bad', reason: 'insufficient_evidence' },
    }, NOW),
    'invalid_selection',
  );
  assert.equal(
    store.setResponseFeedback({
      requestId: fix.requestId,
      subject: USER_SUBJECT,
      selection: {
        rating: 'bad',
        reason: 'unintended_changes',
      },
    }, NOW),
    'saved',
  );
  assert.deepEqual(store.getAdminOverview(NOW).feedback, {
    retentionDays: 35,
    total: { good: 2, bad: 1 },
    routes: {
      ask: { good: 1, bad: 0 },
      generate: { good: 1, bad: 0 },
      fix: { good: 0, bad: 1 },
    },
    badReasons: {
      incorrect_or_incomplete: 0,
      not_what_i_asked: 0,
      insufficient_evidence: 0,
      unintended_changes: 1,
      unusable_result: 0,
      slow_or_buggy: 0,
      other: 0,
    },
  });

  assert.equal(
    store.setResponseFeedback({
      requestId: ask.requestId,
      subject: USER_SUBJECT,
      selection: { rating: 'bad', reason: 'insufficient_evidence' },
    }, NOW),
    'saved',
  );
  assert.deepEqual(store.getAdminOverview(NOW).feedback.total, {
    good: 1,
    bad: 2,
  });
  assert.deepEqual(store.getAdminOverview(NOW).feedback.badReasons, {
    incorrect_or_incomplete: 0,
    not_what_i_asked: 0,
    insufficient_evidence: 1,
    unintended_changes: 1,
    unusable_result: 0,
    slow_or_buggy: 0,
    other: 0,
  });
  assert.equal(
    store.setResponseFeedback({
      requestId: ask.requestId,
      subject: USER_SUBJECT,
      selection: { rating: null },
    }, NOW),
    'saved',
  );
  assert.deepEqual(store.getAdminOverview(NOW).feedback.total, {
    good: 1,
    bad: 1,
  });
  assert.equal(
    store.getAdminOverview(NOW).feedback.badReasons.insufficient_evidence,
    0,
  );
  store.close();
});

test('反馈汇总累加同一路由的不同负反馈原因', () => {
  const { store } = controlStore();
  makeAvailable(store);
  for (const [requestId, reason] of [
    ['feedback-ask-one', 'incorrect_or_incomplete'],
    ['feedback-ask-two', 'insufficient_evidence'],
  ] as const) {
    const reservation = store.reserve(
      { requestId, subject: USER_SUBJECT, route: 'ask' },
      NOW,
    );
    store.settle(reservation, 0, NOW);
    if (requestId === 'feedback-ask-one') {
      assert.equal(
        store.setResponseFeedback({
          requestId,
          subject: USER_SUBJECT,
          selection: { rating: 'bad', reason: 'unintended_changes' },
        }, NOW),
        'invalid_selection',
      );
    }
    assert.equal(
      store.setResponseFeedback({
        requestId,
        subject: USER_SUBJECT,
        selection: { rating: 'bad', reason },
      }, NOW),
      'saved',
    );
  }

  const feedback = store.getAdminOverview(NOW).feedback;
  assert.deepEqual(feedback.total, { good: 0, bad: 2 });
  assert.deepEqual(feedback.routes.ask, { good: 0, bad: 2 });
  assert.equal(feedback.badReasons.incorrect_or_incomplete, 1);
  assert.equal(feedback.badReasons.insufficient_evidence, 1);
  store.close();
});

test('账本保留期清理会级联删除反馈', () => {
  const { directory, store } = controlStore();
  const oldNow = NOW - 36 * 24 * 60 * 60_000;
  makeAvailable(store, oldNow);
  const reservation = store.reserve(
    {
      requestId: 'expired-feedback',
      subject: USER_SUBJECT,
      route: 'fix',
    },
    oldNow,
  );
  store.settle(reservation, 0, oldNow);
  assert.equal(
    store.setResponseFeedback(
      {
        requestId: reservation.requestId,
        subject: USER_SUBJECT,
        selection: { rating: 'bad', reason: 'unusable_result' },
      },
      oldNow,
    ),
    'saved',
  );
  assert.deepEqual(store.getAdminOverview(NOW).feedback.total, {
    good: 0,
    bad: 0,
  });
  store.close();

  const database = new Database(join(directory, 'control.sqlite3'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual(
      database.prepare('SELECT COUNT(*) AS count FROM request_ledger').get(),
      { count: 0 },
    );
    assert.deepEqual(
      database.prepare('SELECT COUNT(*) AS count FROM response_feedback').get(),
      { count: 0 },
    );
  } finally {
    database.close();
  }
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

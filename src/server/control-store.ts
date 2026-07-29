import { createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  ANONYMOUS_TRIAL_CREDITS,
  GLOBAL_DAILY_BUDGET_MICROUSD,
  GLOBAL_MONTHLY_BUDGET_MICROUSD,
  INTERVIEW_DAILY_CREDITS,
  MODEL_ROUTE_CREDITS,
  MODEL_ROUTE_LEASE_MS,
  MODEL_ROUTE_RESERVE_MICROUSD,
  NORMAL_DAILY_CREDITS,
  type AdminExperienceRequest,
  type AdminExperienceResponse,
  type ExperienceMode,
  type ModelRoute,
  type ModelUnavailableReason,
} from './experience-control';
import { decodeBase64Key } from './secret-key';

type ControlEnvironment = Readonly<Record<string, string | undefined>>;
type LedgerState = 'reserved' | 'settled' | 'charged_max';
const LEDGER_RETENTION_MS = 35 * 24 * 60 * 60_000;

interface ExperienceRow {
  mode: ExperienceMode;
  interview_expires_at: number | null;
}

interface SumRow {
  total: number;
}

export class ControlStateFault extends Error {
  constructor() {
    super('control state unavailable');
    this.name = 'ControlStateFault';
  }
}

export class ReservationRejected extends Error {
  readonly code: Extract<
    ModelUnavailableReason,
    'sleep_mode' | 'global_budget_exhausted' | 'quota_exhausted'
  >;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ReservationRejected['code'],
    retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ReservationRejected';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ModelReservation {
  requestId: string;
  reservedCostMicrousd: number;
}

export type QuotaSubject =
  | { kind: 'authenticated'; id: string; admin: boolean }
  | { kind: 'anonymous'; id: string; admin: false };

export type PersonalQuotaSnapshot =
  | { limited: false }
  | {
      limited: true;
      limit: number;
      remaining: number;
      resetsAt: string | null;
    };

export interface ExperienceAccessSnapshot {
  mode: ExperienceMode;
  reason: Extract<
    ModelUnavailableReason,
    'sleep_mode' | 'global_budget_exhausted'
  > | null;
  quota: PersonalQuotaSnapshot;
}

function shanghaiParts(now: number): {
  year: number;
  month: number;
  day: number;
  date: string;
  monthKey: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new ControlStateFault();
    return Number(value);
  };
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const date = `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return { year, month, day, date, monthKey: date.slice(0, 7) };
}

function shanghaiDayResetAt(now: number): number {
  const { year, month, day } = shanghaiParts(now);
  return Date.UTC(year, month - 1, day + 1, -8);
}

function secondsUntilShanghaiDayReset(now: number): number {
  return Math.max(
    1,
    Math.ceil((shanghaiDayResetAt(now) - now) / 1_000),
  );
}

function secondsUntilShanghaiMonthReset(now: number): number {
  const { year, month } = shanghaiParts(now);
  const reset = Date.UTC(year, month, 1, -8);
  return Math.max(1, Math.ceil((reset - now) / 1_000));
}

function ensureControlDirectory(databasePath: string): void {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statSync(directory);
  if (!stat.isDirectory()) throw new ControlStateFault();
  chmodSync(directory, 0o700);
}

function databasePath(environment: ControlEnvironment): string {
  const configured = environment.CONTROL_DB_PATH;
  return configured && configured.trim() === configured
    ? configured
    : resolve(process.cwd(), 'data/control/control.sqlite3');
}

function initializeDatabase(path: string): Database.Database {
  ensureControlDirectory(path);
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true });
  if (version !== 0 && version !== 1) {
    db.close();
    throw new ControlStateFault();
  }
  if (version === 0) {
    db.exec(`
      CREATE TABLE experience_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('normal', 'interview', 'sleep')),
        interview_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO experience_state (id, mode, interview_expires_at, updated_at)
      VALUES (1, 'sleep', NULL, 0);

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

      PRAGMA user_version = 1;
    `);
  }
  return db;
}

function effectiveState(
  db: Database.Database,
  now: number,
): ExperienceRow {
  const row = db
    .prepare<[], ExperienceRow>(
      'SELECT mode, interview_expires_at FROM experience_state WHERE id = 1',
    )
    .get();
  if (!row) throw new ControlStateFault();
  if (
    row.mode === 'interview' &&
    (row.interview_expires_at === null || row.interview_expires_at <= now)
  ) {
    db.prepare(
      `UPDATE experience_state
       SET mode = 'normal', interview_expires_at = NULL, updated_at = ?
       WHERE id = 1`,
    ).run(now);
    return { mode: 'normal', interview_expires_at: null };
  }
  return row;
}

function expireReservations(db: Database.Database, now: number): void {
  db.prepare(
    `UPDATE request_ledger
     SET state = 'charged_max',
         settled_cost_microusd = reserved_cost_microusd,
         completed_at = ?
     WHERE state = 'reserved' AND lease_expires_at <= ?`,
  ).run(now, now);
  db.prepare(
    `DELETE FROM request_ledger
     WHERE state != 'reserved'
       AND completed_at IS NOT NULL
       AND completed_at < ?`,
  ).run(now - LEDGER_RETENTION_MS);
}

function chargedAmountExpression(): string {
  return `CASE
    WHEN state = 'settled' THEN settled_cost_microusd
    WHEN state IN ('reserved', 'charged_max') THEN reserved_cost_microusd
    ELSE 0
  END`;
}

function chargedSum(
  db: Database.Database,
  where: string,
  value: string,
): number {
  const row = db
    .prepare<[string], SumRow>(
      `SELECT COALESCE(SUM(${chargedAmountExpression()}), 0) AS total
       FROM request_ledger WHERE ${where}`,
    )
    .get(value);
  return row?.total ?? 0;
}

function quotaSubjectHash(key: Buffer, subject: QuotaSubject): string {
  return createHmac('sha256', key)
    .update(`${subject.kind}\0${subject.id}`, 'utf8')
    .digest('hex');
}

function usedCredits(
  db: Database.Database,
  subjectHash: string,
  date: string | null,
): number {
  const query =
    date === null
      ? {
          sql: `SELECT COALESCE(SUM(credits), 0) AS total
                FROM request_ledger WHERE subject_hash = ?`,
          values: [subjectHash] as [string],
        }
      : {
          sql: `SELECT COALESCE(SUM(credits), 0) AS total
                FROM request_ledger
                WHERE subject_hash = ? AND quota_day = ?`,
          values: [subjectHash, date] as [string, string],
        };
  return (
    db.prepare(query.sql).get(...query.values) as SumRow | undefined
  )?.total ?? 0;
}

function quotaLimit(
  subject: QuotaSubject,
  mode: ExperienceMode,
): number {
  if (subject.kind === 'anonymous') return ANONYMOUS_TRIAL_CREDITS;
  return mode === 'interview'
    ? INTERVIEW_DAILY_CREDITS
    : NORMAL_DAILY_CREDITS;
}

export class ControlStore {
  private readonly db: Database.Database;
  private readonly subjectKey: Buffer;

  constructor(
    path: string,
    subjectKey: Buffer,
  ) {
    this.subjectKey = subjectKey;
    this.db = initializeDatabase(path);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  getAdminState(now = Date.now()): AdminExperienceResponse {
    try {
      const transaction = this.db.transaction(() => effectiveState(this.db, now));
      const row = transaction.immediate();
      return {
        mode: row.mode,
        interviewExpiresAt:
          row.interview_expires_at === null
            ? null
            : new Date(row.interview_expires_at).toISOString(),
      };
    } catch (error) {
      if (error instanceof ControlStateFault) throw error;
      throw new ControlStateFault();
    }
  }

  setAdminState(
    request: AdminExperienceRequest,
    now = Date.now(),
  ): AdminExperienceResponse {
    try {
      const expiresAt =
        request.mode === 'interview'
          ? now + request.durationHours * 60 * 60_000
          : null;
      const transaction = this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE experience_state
             SET mode = ?, interview_expires_at = ?, updated_at = ?
             WHERE id = 1`,
          )
          .run(request.mode, expiresAt, now);
      });
      transaction.immediate();
      return {
        mode: request.mode,
        interviewExpiresAt:
          expiresAt === null ? null : new Date(expiresAt).toISOString(),
      };
    } catch {
      throw new ControlStateFault();
    }
  }

  experienceAccess(
    subject: QuotaSubject,
    now = Date.now(),
  ): ExperienceAccessSnapshot {
    try {
      const transaction = this.db.transaction(() => {
        expireReservations(this.db, now);
        const state = effectiveState(this.db, now);
        const { date, monthKey } = shanghaiParts(now);
        let reason: ExperienceAccessSnapshot['reason'] = null;
        if (state.mode === 'sleep') {
          reason = 'sleep_mode';
        } else {
          const daily = chargedSum(this.db, 'quota_day = ?', date);
          const monthly = chargedSum(
            this.db,
            "substr(quota_day, 1, 7) = ?",
            monthKey,
          );
          if (
            daily >= GLOBAL_DAILY_BUDGET_MICROUSD ||
            monthly >= GLOBAL_MONTHLY_BUDGET_MICROUSD
          ) {
            reason = 'global_budget_exhausted';
          }
        }
        let quota: PersonalQuotaSnapshot = { limited: false };
        if (!subject.admin) {
          const limit = quotaLimit(subject, state.mode);
          const used = usedCredits(
            this.db,
            quotaSubjectHash(this.subjectKey, subject),
            subject.kind === 'anonymous' ? null : date,
          );
          quota = {
            limited: true,
            limit,
            remaining: Math.max(0, limit - used),
            resetsAt:
              subject.kind === 'anonymous'
                ? null
                : new Date(shanghaiDayResetAt(now)).toISOString(),
          };
        }
        return {
          mode: state.mode,
          reason,
          quota,
        };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof ControlStateFault) throw error;
      throw new ControlStateFault();
    }
  }

  reserve(
    input: {
      requestId: string;
      subject: QuotaSubject;
      route: ModelRoute;
    },
    now = Date.now(),
  ): ModelReservation {
    try {
      const transaction = this.db.transaction(() => {
        expireReservations(this.db, now);
        const state = effectiveState(this.db, now);
        if (state.mode === 'sleep') {
          throw new ReservationRejected('sleep_mode');
        }

        const { date, monthKey } = shanghaiParts(now);
        const reserveCost = MODEL_ROUTE_RESERVE_MICROUSD[input.route];
        const daily = chargedSum(this.db, 'quota_day = ?', date);
        const monthly = chargedSum(
          this.db,
          "substr(quota_day, 1, 7) = ?",
          monthKey,
        );
        if (daily + reserveCost > GLOBAL_DAILY_BUDGET_MICROUSD) {
          throw new ReservationRejected(
            'global_budget_exhausted',
            secondsUntilShanghaiDayReset(now),
          );
        }
        if (monthly + reserveCost > GLOBAL_MONTHLY_BUDGET_MICROUSD) {
          throw new ReservationRejected(
            'global_budget_exhausted',
            secondsUntilShanghaiMonthReset(now),
          );
        }

        const subjectHash = quotaSubjectHash(this.subjectKey, input.subject);
        const credits = input.subject.admin
          ? 0
          : MODEL_ROUTE_CREDITS[input.route];
        if (!input.subject.admin) {
          const used = usedCredits(
            this.db,
            subjectHash,
            input.subject.kind === 'anonymous' ? null : date,
          );
          const limit = quotaLimit(input.subject, state.mode);
          if (used + credits > limit) {
            throw new ReservationRejected(
              'quota_exhausted',
              input.subject.kind === 'authenticated'
                ? secondsUntilShanghaiDayReset(now)
                : undefined,
            );
          }
        }

        this.db
          .prepare(
            `INSERT INTO request_ledger (
               request_id, subject_hash, quota_day, route, credits, state,
               reserved_cost_microusd, settled_cost_microusd,
               lease_expires_at, created_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, 0, ?, ?, NULL)`,
          )
          .run(
            input.requestId,
            subjectHash,
            date,
            input.route,
            credits,
            reserveCost,
            now + MODEL_ROUTE_LEASE_MS[input.route],
            now,
          );
        return {
          requestId: input.requestId,
          reservedCostMicrousd: reserveCost,
        };
      });
      return transaction.immediate();
    } catch (error) {
      if (
        error instanceof ReservationRejected ||
        error instanceof ControlStateFault
      ) {
        throw error;
      }
      throw new ControlStateFault();
    }
  }

  settle(
    reservation: ModelReservation,
    costMicrousd: number,
    now = Date.now(),
  ): void {
    if (
      !Number.isSafeInteger(costMicrousd) ||
      costMicrousd < 0 ||
      costMicrousd > reservation.reservedCostMicrousd
    ) {
      this.chargeMax(reservation, now);
      return;
    }
    this.complete(
      reservation,
      'settled',
      costMicrousd,
      now,
    );
  }

  chargeMax(reservation: ModelReservation, now = Date.now()): void {
    this.complete(
      reservation,
      'charged_max',
      reservation.reservedCostMicrousd,
      now,
    );
  }

  refund(reservation: ModelReservation): void {
    try {
      const result = this.db
        .prepare(
          `DELETE FROM request_ledger
           WHERE request_id = ? AND state = 'reserved'`,
        )
        .run(reservation.requestId);
      if (result.changes !== 1) throw new ControlStateFault();
    } catch (error) {
      if (error instanceof ControlStateFault) throw error;
      throw new ControlStateFault();
    }
  }

  private complete(
    reservation: ModelReservation,
    state: Exclude<LedgerState, 'reserved'>,
    costMicrousd: number,
    now: number,
  ): void {
    try {
      const result = this.db
        .prepare(
          `UPDATE request_ledger
           SET state = ?, settled_cost_microusd = ?, completed_at = ?
           WHERE request_id = ? AND state = 'reserved'`,
        )
        .run(state, costMicrousd, now, reservation.requestId);
      if (result.changes !== 1) throw new ControlStateFault();
    } catch (error) {
      if (error instanceof ControlStateFault) throw error;
      throw new ControlStateFault();
    }
  }
}

function createControlStore(
  environment: ControlEnvironment = process.env,
): ControlStore {
  try {
    return new ControlStore(
      databasePath(environment),
      decodeBase64Key(environment.CONTROL_SUBJECT_HMAC_KEY),
    );
  } catch (error) {
    if (error instanceof ControlStateFault) throw error;
    throw new ControlStateFault();
  }
}

let sharedStore: ControlStore | null = null;

export function getControlStore(): ControlStore {
  sharedStore ??= createControlStore();
  return sharedStore;
}

import { performance } from 'node:perf_hooks';
import {
  resolveModelAccessEnabled,
  type RuntimeEnvironment,
} from './runtime-config';

type ApiRoute = 'ask' | 'check' | 'generate' | 'fix';
type ConcurrencyGroup = 'check' | 'model';

interface RateLimit {
  perMinute: number;
  burst: number;
}

interface Bucket {
  tokens: number;
  refilledAt: number;
  lastSeenAt: number;
}

interface SubjectConcurrency {
  active: number;
}

type LimiterRejectionReason = 'concurrency' | 'rate';

type LimiterDecision =
  | { ok: true; release: () => void }
  | {
      ok: false;
      reason: LimiterRejectionReason;
      retryAfterSeconds: number;
    };

const minuteMs = 60_000;
const bucketTtlMs = 10 * minuteMs;
const maxBuckets = 2_048;

const routeLimits: Readonly<Record<ApiRoute, RateLimit>> = {
  check: { perMinute: 60, burst: 20 },
  ask: { perMinute: 6, burst: 2 },
  generate: { perMinute: 2, burst: 1 },
  fix: { perMinute: 3, burst: 1 },
};

const concurrencyLimits = {
  check: { global: 8, subject: 4 },
  model: { global: 2, subject: 1 },
} as const satisfies Readonly<
  Record<ConcurrencyGroup, { global: number; subject: number }>
>;

function concurrencyGroup(route: ApiRoute): ConcurrencyGroup {
  return route === 'check' ? 'check' : 'model';
}

function subjectKey(subject: string | null): string {
  return subject ?? 'anonymous';
}

export function createRequestLimiter(
  now: () => number = () => performance.now(),
) {
  const buckets = new Map<string, Bucket>();
  const subjectConcurrency = new Map<string, SubjectConcurrency>();
  const activeByGroup: Record<ConcurrencyGroup, number> = {
    check: 0,
    model: 0,
  };
  let acquisitions = 0;

  function bucketIsActive(key: string): boolean {
    const separator = key.indexOf(':');
    const route = key.slice(0, separator) as ApiRoute;
    const subject = key.slice(separator + 1);
    return (
      (subjectConcurrency.get(`${concurrencyGroup(route)}:${subject}`)?.active ??
        0) > 0
    );
  }

  function pruneBuckets(currentTime: number): void {
    for (const [key, bucket] of buckets) {
      if (
        currentTime - bucket.lastSeenAt >= bucketTtlMs &&
        !bucketIsActive(key)
      ) {
        buckets.delete(key);
      }
    }
    if (buckets.size <= maxBuckets) return;
    const inactive = [...buckets.entries()]
      .filter(([key]) => !bucketIsActive(key))
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
    for (const [key] of inactive) {
      if (buckets.size <= maxBuckets) break;
      buckets.delete(key);
    }
  }

  function tryAcquire(route: ApiRoute, subject: string | null): LimiterDecision {
    const currentTime = now();
    acquisitions += 1;
    if (acquisitions % 64 === 0 || buckets.size >= maxBuckets) {
      pruneBuckets(currentTime);
    }

    const group = concurrencyGroup(route);
    const normalizedSubject = subjectKey(subject);
    const bucketKey = `${route}:${normalizedSubject}`;
    const concurrencyKey = `${group}:${normalizedSubject}`;

    const limit = routeLimits[route];
    const bucket = buckets.get(bucketKey) ?? {
      tokens: limit.burst,
      refilledAt: currentTime,
      lastSeenAt: currentTime,
    };
    const elapsed = Math.max(0, currentTime - bucket.refilledAt);
    bucket.tokens = Math.min(
      limit.burst,
      bucket.tokens + (elapsed * limit.perMinute) / minuteMs,
    );
    bucket.refilledAt = currentTime;
    bucket.lastSeenAt = currentTime;
    buckets.set(bucketKey, bucket);
    if (buckets.size > maxBuckets) pruneBuckets(currentTime);

    if (bucket.tokens < 1) {
      const waitMs =
        ((1 - bucket.tokens) * minuteMs) / limit.perMinute;
      return {
        ok: false,
        reason: 'rate',
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
      };
    }

    const groupLimit = concurrencyLimits[group];
    const concurrency = subjectConcurrency.get(concurrencyKey) ?? {
      active: 0,
    };
    if (
      activeByGroup[group] >= groupLimit.global ||
      concurrency.active >= groupLimit.subject
    ) {
      return {
        ok: false,
        reason: 'concurrency',
        retryAfterSeconds: 1,
      };
    }

    subjectConcurrency.set(concurrencyKey, concurrency);
    bucket.tokens -= 1;
    activeByGroup[group] += 1;
    concurrency.active += 1;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        activeByGroup[group] -= 1;
        concurrency.active -= 1;
        if (concurrency.active === 0) {
          subjectConcurrency.delete(concurrencyKey);
        }
      },
    };
  }

  return { tryAcquire };
}

const requestLimiter = createRequestLimiter();

function rejectionResponse(
  code: 'concurrency_limited' | 'rate_limited',
  retryAfterSeconds: number,
): Response {
  return Response.json(
    { error: { code } },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
      },
    },
  );
}

export function modelAccessGate(
  environment: RuntimeEnvironment = process.env,
): Response | null {
  if (resolveModelAccessEnabled(environment)) return null;
  return Response.json(
    { error: { code: 'model_access_disabled' } },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

export function admitApiRequest(
  route: ApiRoute,
  subject: string | null,
):
  | { ok: true; release: () => void }
  | { ok: false; response: Response } {
  const decision = requestLimiter.tryAcquire(route, subject);
  if (decision.ok) return decision;
  return {
    ok: false,
    response: rejectionResponse(
      decision.reason === 'concurrency'
        ? 'concurrency_limited'
        : 'rate_limited',
      decision.retryAfterSeconds,
    ),
  };
}

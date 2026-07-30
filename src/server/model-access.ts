import { randomUUID } from 'node:crypto';
import {
  ControlStateFault,
  getControlStore,
  ReservationRejected,
  type ControlStore,
  type ModelReservation,
  type QuotaSubject,
} from './control-store';
import {
  getAnonymousIdentity,
  type AnonymousIdentity,
} from './anonymous-identity';
import type { AuthenticatedIdentity } from './auth';
import { getAuthenticatedIdentity } from './auth';
import type { ModelRoute } from './experience-control';
import type { ModelUsageCollector } from './provider-usage';

export type ModelActor =
  | { kind: 'authenticated'; identity: AuthenticatedIdentity }
  | { kind: 'anonymous'; identity: AnonymousIdentity };

export function actorQuotaSubject(actor: ModelActor): QuotaSubject {
  return actor.kind === 'authenticated'
    ? {
        kind: 'authenticated',
        id: actor.identity.githubId,
        admin: actor.identity.admin,
      }
    : { kind: 'anonymous', id: actor.identity.id, admin: false };
}

export function actorLimiterSubject(actor: ModelActor): string {
  return actor.kind === 'authenticated'
    ? `authenticated:${actor.identity.githubId}`
    : `anonymous:${actor.identity.id}`;
}

export async function resolveModelActor(): Promise<
  | { ok: true; actor: ModelActor }
  | { ok: false; response: Response }
> {
  try {
    const identity = await getAuthenticatedIdentity();
    if (identity !== null) {
      return { ok: true, actor: { kind: 'authenticated', identity } };
    }
  } catch {
    // Anonymous use remains available when the optional login path is unavailable.
  }
  try {
    return {
      ok: true,
      actor: { kind: 'anonymous', identity: await getAnonymousIdentity() },
    };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'control_state_unavailable' } },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    };
  }
}

function errorResponse(
  code:
    | 'control_state_unavailable'
    | 'sleep_mode'
    | 'global_budget_exhausted'
    | 'quota_exhausted',
  status: 429 | 503,
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(retryAfterSeconds);
  }
  return Response.json({ error: { code } }, { status, headers });
}

export function reserveModelRequest(
  route: ModelRoute,
  actor: ModelActor,
): { ok: true; store: ControlStore; reservation: ModelReservation } | {
  ok: false;
  response: Response;
} {
  try {
    const store = getControlStore();
    return {
      ok: true,
      store,
      reservation: store.reserve({
        requestId: randomUUID(),
        subject: actorQuotaSubject(actor),
        route,
      }),
    };
  } catch (error) {
    if (error instanceof ReservationRejected) {
      return {
        ok: false,
        response: errorResponse(
          error.code,
          error.code === 'quota_exhausted' ? 429 : 503,
          error.retryAfterSeconds,
        ),
      };
    }
    return {
      ok: false,
      response: errorResponse('control_state_unavailable', 503),
    };
  }
}

export function finishModelRequest(
  store: ControlStore,
  reservation: ModelReservation,
  usage: ModelUsageCollector,
  outcome: 'success' | 'failure',
): void {
  try {
    if (outcome === 'failure') {
      if (usage.hasStartedRequest()) store.chargeMax(reservation);
      else store.refund(reservation);
      return;
    }
    const cost = usage.settledCostMicrousd();
    if (cost === null) store.chargeMax(reservation);
    else store.settle(reservation, cost);
  } catch (error) {
    if (!(error instanceof ControlStateFault)) throw error;
    try {
      console.error('[model-accounting] code=finalization_failed');
    } catch {
      // Accounting recovery is driven by the persisted reservation lease.
    }
  }
}

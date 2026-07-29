import { getAuthenticatedIdentity } from '@/server/auth';
import {
  ControlStateFault,
  getControlStore,
  type PersonalQuotaSnapshot,
} from '@/server/control-store';
import { getAnonymousIdentity } from '@/server/anonymous-identity';
import type {
  ExperienceQuota,
  ExperienceMode,
  ExperienceResponse,
  ModelUnavailableReason,
} from '@/server/experience-control';
import { resolveModelRouteAvailability } from '@/server/experience-control';
import {
  actorQuotaSubject,
  type ModelActor,
} from '@/server/model-access';
import {
  getDeepSeekRuntimeStatus,
  getRetrievalRuntimeStatus,
  resolveModelAccessEnabled,
} from '@/server/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function response(body: ExperienceResponse): Response {
  return Response.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

function unavailable(): Response {
  return Response.json(
    { error: { code: 'control_state_unavailable' } },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

function unavailableModels(
  reason: ModelUnavailableReason,
): ExperienceResponse['model'] {
  return resolveModelRouteAvailability(reason, null, {
    deepseek: false,
    retrieval: false,
  });
}

function experienceQuota(
  actor: ModelActor,
  snapshot: PersonalQuotaSnapshot,
): ExperienceQuota {
  if (!snapshot.limited) return { kind: 'unlimited' };
  if (actor.kind === 'anonymous') {
    return {
      kind: 'anonymous_trial',
      limit: snapshot.limit,
      remaining: snapshot.remaining,
      expiresAt: new Date(actor.identity.expiresAt).toISOString(),
    };
  }
  if (snapshot.resetsAt === null) throw new ControlStateFault();
  return {
    kind: 'daily',
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    resetsAt: snapshot.resetsAt,
  };
}

export async function GET(): Promise<Response> {
  let identity = null;
  try {
    identity = await getAuthenticatedIdentity();
  } catch {
    identity = null;
  }

  const authenticated = identity !== null;
  const user =
    identity === null
      ? null
      : { login: identity.login, admin: identity.admin };

  if (!resolveModelAccessEnabled()) {
    let mode: ExperienceMode = 'sleep';
    try {
      mode = getControlStore().getAdminState().mode;
    } catch {
      // The emergency gate remains the authoritative user-facing reason.
    }
    return response({
      authenticated,
      user,
      mode,
      quota: null,
      model: unavailableModels('model_access_disabled'),
    });
  }

  try {
    const store = getControlStore();
    const actor: ModelActor =
      identity === null
        ? {
            kind: 'anonymous',
            identity: await getAnonymousIdentity(),
          }
        : { kind: 'authenticated', identity };
    const access = store.experienceAccess(actorQuotaSubject(actor));
    const deepSeekAvailable = getDeepSeekRuntimeStatus().ok;
    const retrievalAvailable =
      deepSeekAvailable && getRetrievalRuntimeStatus().ok;
    const remainingCredits = access.quota.limited
      ? access.quota.remaining
      : null;
    return response({
      authenticated,
      user,
      mode: access.mode,
      quota: experienceQuota(actor, access.quota),
      model: resolveModelRouteAvailability(
        access.reason,
        remainingCredits,
        {
          deepseek: deepSeekAvailable,
          retrieval: retrievalAvailable,
        },
      ),
    });
  } catch (error) {
    if (error instanceof ControlStateFault) return unavailable();
    return unavailable();
  }
}

import { NextResponse } from 'next/server';
import { readApiRequest } from '@/server/api-contract';
import { getClient } from '@/server/pipeline';
import { fixResource } from '@/server/agent';
import {
  requireDeepSeekRuntimeAccess,
  type DeepSeekRuntimeAccess,
} from '@/server/runtime-config';
import {
  admitApiRequest,
  modelAccessGate,
} from '@/server/request-limiter';
import { upstreamErrorResponse } from '@/server/upstream-error';
import {
  actorLimiterSubject,
  finishModelRequest,
  resolveModelActor,
  reserveModelRequest,
} from '@/server/model-access';
import { ModelUsageCollector } from '@/server/provider-usage';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const modelAccess = modelAccessGate();
  if (modelAccess) return modelAccess;

  let runtimeAccess: DeepSeekRuntimeAccess;
  try {
    runtimeAccess = requireDeepSeekRuntimeAccess();
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const actor = await resolveModelActor();
  if (!actor.ok) return actor.response;
  const body = await readApiRequest(req, 'fix');
  if (!body.ok) return body.response;
  const admission = admitApiRequest(
    'fix',
    actorLimiterSubject(actor.actor),
  );
  if (!admission.ok) return admission.response;
  const reserved = reserveModelRequest('fix', actor.actor);
  if (!reserved.ok) {
    admission.release();
    return reserved.response;
  }
  const usage = new ModelUsageCollector();

  try {
    const result = await fixResource(
      getClient(runtimeAccess),
      body.value.yaml,
      body.value.errors,
      usage,
    );
    finishModelRequest(
      reserved.store,
      reserved.reservation,
      usage,
      'success',
    );
    return NextResponse.json(result);
  } catch (error) {
    finishModelRequest(
      reserved.store,
      reserved.reservation,
      usage,
      'failure',
    );
    return upstreamErrorResponse(error);
  } finally {
    admission.release();
  }
}

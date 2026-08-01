import { readApiRequest } from '@/server/api-contract';
import { getControlStore } from '@/server/control-store';
import {
  actorQuotaSubject,
  resolveFeedbackActor,
} from '@/server/model-access';
import { hasValidApplicationOrigin } from '@/server/request-origin';
import type { ResponseFeedbackSelection } from '@/server/experience-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(
  code:
    | 'invalid_origin'
    | 'invalid_content_type'
    | 'invalid_request'
    | 'feedback_target_not_found'
    | 'control_state_unavailable',
  status: 400 | 403 | 404 | 503,
): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!hasValidApplicationOrigin(request)) {
    return errorResponse('invalid_origin', 403);
  }
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
    'application/json'
  ) {
    return errorResponse('invalid_content_type', 400);
  }

  const body = await readApiRequest(request, 'feedback');
  if (!body.ok) return body.response;
  const actor = await resolveFeedbackActor();
  if (!actor.ok) return actor.response;
  const selection: ResponseFeedbackSelection =
    body.value.rating === 'bad'
      ? { rating: 'bad', reason: body.value.reason }
      : { rating: body.value.rating };

  try {
    const result = getControlStore().setResponseFeedback({
      requestId: body.value.requestId,
      subject: actorQuotaSubject(actor.actor),
      selection,
    });
    if (result === 'target_not_found') {
      return errorResponse('feedback_target_not_found', 404);
    }
    if (result === 'invalid_selection') {
      return errorResponse('invalid_request', 400);
    }
    return Response.json(selection, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return errorResponse('control_state_unavailable', 503);
  }
}

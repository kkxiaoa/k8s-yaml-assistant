import { getAuthenticatedIdentity } from '@/server/auth';
import {
  ControlStateFault,
  getControlStore,
} from '@/server/control-store';
import { readApiRequest } from '@/server/api-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(
  code:
    | 'authentication_required'
    | 'access_denied'
    | 'invalid_origin'
    | 'invalid_content_type'
    | 'control_state_unavailable',
  status: 400 | 401 | 403 | 503,
): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function requireAdmin(): Promise<
  { ok: true } | { ok: false; response: Response }
> {
  const identity = await getAuthenticatedIdentity();
  if (identity === null) {
    return {
      ok: false,
      response: errorResponse('authentication_required', 401),
    };
  }
  if (!identity.admin) {
    return { ok: false, response: errorResponse('access_denied', 403) };
  }
  return { ok: true };
}

function hasValidOrigin(request: Request): boolean {
  const configured = process.env.APP_PUBLIC_ORIGIN;
  if (configured === undefined) return false;
  try {
    const url = new URL(configured);
    const developmentLoopback =
      process.env.NODE_ENV === 'development' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== configured ||
      (url.protocol !== 'https:' && !developmentLoopback) ||
      url.username ||
      url.password
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return request.headers.get('origin') === configured;
}

export async function GET(): Promise<Response> {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    return Response.json(getControlStore().getAdminState(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return errorResponse('control_state_unavailable', 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    if (!hasValidOrigin(request)) {
      return errorResponse('invalid_origin', 403);
    }
    if (
      request.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
      'application/json'
    ) {
      return errorResponse('invalid_content_type', 400);
    }
    const body = await readApiRequest(request, 'adminExperience');
    if (!body.ok) return body.response;
    return Response.json(getControlStore().setAdminState(body.value), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof ControlStateFault) {
      return errorResponse('control_state_unavailable', 503);
    }
    return errorResponse('control_state_unavailable', 503);
  }
}

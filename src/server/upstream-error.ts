import { RuntimeConfigFault } from './runtime-config';

export type SafeUpstreamErrorCode =
  | 'runtime_config_invalid'
  | 'deepseek_unavailable'
  | 'voyage_unavailable'
  | 'upstream_timeout'
  | 'upstream_authentication_failed'
  | 'upstream_balance_exhausted'
  | 'upstream_quota_exceeded'
  | 'upstream_unavailable'
  | 'upstream_request_rejected'
  | 'upstream_error';

export interface SafeUpstreamFailure {
  status: 502 | 503;
  code: SafeUpstreamErrorCode;
}

export class UpstreamHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('upstream request failed');
    this.name = 'UpstreamHttpError';
    this.status = status;
  }
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name === 'Error' ? error.constructor.name : error.name;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'name') === 'string'
  ) {
    return Reflect.get(error, 'name') as string;
  }
  return undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof UpstreamHttpError) return error.status;
  if (typeof error !== 'object' || error === null) return undefined;
  const status = Reflect.get(error, 'status');
  return typeof status === 'number' && Number.isInteger(status)
    ? status
    : undefined;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

export function classifyUpstreamError(error: unknown): SafeUpstreamFailure {
  if (error instanceof RuntimeConfigFault) {
    return { status: 503, code: error.code };
  }

  const name = errorName(error);
  if (
    name === 'APIConnectionTimeoutError' ||
    name === 'TimeoutError' ||
    errorCode(error) === 'ETIMEDOUT'
  ) {
    return { status: 503, code: 'upstream_timeout' };
  }

  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return { status: 503, code: 'upstream_authentication_failed' };
  }
  if (status === 402) {
    return { status: 503, code: 'upstream_balance_exhausted' };
  }
  if (status === 429) {
    return { status: 503, code: 'upstream_quota_exceeded' };
  }
  if (status !== undefined && status >= 500) {
    return { status: 503, code: 'upstream_unavailable' };
  }
  if (status !== undefined && status >= 400) {
    return { status: 502, code: 'upstream_request_rejected' };
  }
  if (name === 'APIConnectionError' || name === 'TypeError') {
    return { status: 503, code: 'upstream_unavailable' };
  }
  return { status: 502, code: 'upstream_error' };
}

export function upstreamErrorEvent(
  error: unknown,
): { code: SafeUpstreamErrorCode } {
  return { code: classifyUpstreamError(error).code };
}

export function upstreamErrorResponse(error: unknown): Response {
  const failure = classifyUpstreamError(error);
  return Response.json(
    { error: { code: failure.code } },
    {
      status: failure.status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

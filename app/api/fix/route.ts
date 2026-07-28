import { NextResponse } from 'next/server';
import { readApiRequest } from '@/server/api-contract';
import { getClient } from '@/server/pipeline';
import { fixResource } from '@/server/agent';
import { requireRuntimeCapability } from '@/server/runtime-config';
import { upstreamErrorResponse } from '@/server/upstream-error';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    requireRuntimeCapability('deepseek');
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const body = await readApiRequest(req, 'fix');
  if (!body.ok) return body.response;

  try {
    const result = await fixResource(
      getClient(),
      body.value.yaml,
      body.value.errors,
    );
    return NextResponse.json(result);
  } catch (error) {
    return upstreamErrorResponse(error);
  }
}

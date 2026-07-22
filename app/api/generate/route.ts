import { NextResponse } from 'next/server';
import { getClient } from '@/server/pipeline';
import { generateResource } from '@/server/agent';
import { requireRuntimeCapability } from '@/server/runtime-config';
import { upstreamErrorResponse } from '@/server/upstream-error';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    requireRuntimeCapability('deepseek');
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const body = (await req.json()) as { requirement?: unknown };
  const requirement = String(body.requirement ?? '').trim();
  if (!requirement) return NextResponse.json({ error: '需求为空' }, { status: 400 });
  try {
    const { yaml, rounds, diagnostics } = await generateResource(getClient(), {
      requirement,
    });
    return NextResponse.json({ yaml, rounds, diagnostics });
  } catch (error) {
    return upstreamErrorResponse(error);
  }
}

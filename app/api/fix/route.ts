import { NextResponse } from 'next/server';
import { getClient } from '@/server/pipeline';
import { fixResource } from '@/server/agent';
import type { ValidationError } from '@/validation/validate';
import { requireRuntimeCapability } from '@/server/runtime-config';
import { upstreamErrorResponse } from '@/server/upstream-error';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    requireRuntimeCapability('deepseek');
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const body = (await req.json()) as { yaml?: unknown; errors?: unknown };
  const yaml = String(body.yaml ?? '');
  const errors = Array.isArray(body.errors)
    ? (body.errors as ValidationError[])
    : [];

  if (!yaml.trim())
    return NextResponse.json({ error: 'YAML 为空' }, { status: 400 });

  try {
    const result = await fixResource(getClient(), yaml, errors);
    return NextResponse.json(result);
  } catch (error) {
    return upstreamErrorResponse(error);
  }
}

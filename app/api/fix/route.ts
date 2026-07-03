import { NextResponse } from 'next/server';
import { getClient } from '@/server/pipeline';
import { fixResource } from '@/server/agent';
import type { ValidationError } from '@/validation/validate';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { yaml?: unknown; errors?: unknown };
  const yaml = String(body.yaml ?? '');
  const errors = Array.isArray(body.errors)
    ? (body.errors as ValidationError[])
    : [];

  if (!yaml.trim())
    return NextResponse.json({ error: 'YAML 为空' }, { status: 400 });

  if (!process.env.DEEPSEEK_API_KEY)
    return NextResponse.json(
      { error: 'DEEPSEEK_API_KEY 未设置' },
      { status: 500 },
    );

  const result = await fixResource(getClient(), yaml, errors);

  return NextResponse.json(result);
}

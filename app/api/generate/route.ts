import { NextResponse } from 'next/server';
import { getClient } from '@/server/pipeline';
import { generateResource } from '@/server/agent';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { requirement?: unknown };
  const requirement = String(body.requirement ?? '').trim();
  if (!requirement) return NextResponse.json({ error: '需求为空' }, { status: 400 });
  if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: 'DEEPSEEK_API_KEY 未设置' }, { status: 500 });

  const { yaml, rounds } = await generateResource(getClient(), requirement);
  return NextResponse.json({ yaml, rounds });
}

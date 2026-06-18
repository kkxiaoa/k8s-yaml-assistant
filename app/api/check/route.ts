import { NextResponse } from 'next/server';
import { validateYamlText } from '@/server/pipeline';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { yaml?: unknown };
  const errors = validateYamlText(String(body.yaml ?? ''));
  return NextResponse.json({ errors });
}

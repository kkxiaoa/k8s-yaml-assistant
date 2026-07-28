import { NextResponse } from 'next/server';
import { readApiRequest } from '@/server/api-contract';
import { validateYamlText } from '@/server/pipeline';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = await readApiRequest(req, 'check');
  if (!body.ok) return body.response;
  const errors = validateYamlText(body.value.yaml);
  return NextResponse.json({ errors });
}

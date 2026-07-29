import { NextResponse } from 'next/server';
import { readApiRequest } from '@/server/api-contract';
import { validateYamlText } from '@/server/pipeline';
import { admitApiRequest } from '@/server/request-limiter';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = await readApiRequest(req, 'check');
  if (!body.ok) return body.response;
  const admission = admitApiRequest('check', null);
  if (!admission.ok) return admission.response;
  try {
    const errors = validateYamlText(body.value.yaml);
    return NextResponse.json({ errors });
  } finally {
    admission.release();
  }
}

import { getReadiness } from '@/server/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const readiness = await getReadiness();
  return Response.json(readiness, {
    status: readiness.status === 'ready' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

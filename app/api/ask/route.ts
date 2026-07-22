import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { decodeServingObservationConfig } from '@/observability/config';
import { createLocalObservationSink } from '@/observability/local-sink';
import {
  createServingObservationRecorder,
  type ServingObservationRecorder,
  type ServingObservationRecordResult,
} from '@/observability/recorder';
import { getReadiness } from '@/server/health';
import type {
  AskMode,
  EditorContext,
  RetrieveContextOptions,
} from '@/server/pipeline';

export const runtime = 'nodejs'; // 需要 Node:Anthropic SDK、dotenv、fetch 向量/rerank

type ServingObservationRuntime =
  | { mode: 'off' }
  | { mode: 'local'; recorder: ServingObservationRecorder };

const reportedServingObservationFailures = new Set<string>();

function reportServingObservationFailureOnce(
  stage: 'config' | 'runtime' | 'sink' | 'record',
  code: string,
): void {
  const key = `${stage}:${code}`;
  if (reportedServingObservationFailures.has(key)) return;
  reportedServingObservationFailures.add(key);
  try {
    console.error(`[serving-observation] stage=${stage} code=${code}`);
  } catch {
    // Observation diagnostics cannot become an Ask availability dependency.
  }
}

function initializeServingObservation(): ServingObservationRuntime {
  try {
    const decoded = decodeServingObservationConfig(process.env);
    if (!decoded.ok) {
      reportServingObservationFailureOnce('config', decoded.error.code);
      return { mode: 'off' };
    }
    if (decoded.config.mode === 'off') return { mode: 'off' };

    const sinkResult = createLocalObservationSink({
      rootDir: resolve(process.cwd(), 'data/observability'),
      maxFileBytes: decoded.config.maxFileBytes,
      maxTotalBytes: decoded.config.maxTotalBytes,
      retentionDays: decoded.config.retentionDays,
    });
    if (!sinkResult.ok) {
      reportServingObservationFailureOnce('sink', sinkResult.error.code);
      return { mode: 'off' };
    }

    return {
      mode: 'local',
      recorder: createServingObservationRecorder(decoded.config, {
        sink: sinkResult.sink,
      }),
    };
  } catch {
    reportServingObservationFailureOnce('runtime', 'initialization_failed');
    return { mode: 'off' };
  }
}

const servingObservation = initializeServingObservation();

function reportServingObservationResult(
  result: ServingObservationRecordResult,
): void {
  if (!('errorCode' in result)) return;
  reportServingObservationFailureOnce(
    'record',
    `${result.status}.${result.errorCode}`,
  );
}

function servingObservationRetrievalOptions(
  requestId: string,
): RetrieveContextOptions | undefined {
  if (servingObservation.mode === 'off') return undefined;
  return {
    traceSink: servingObservation.recorder.traceSink(
      requestId,
      reportServingObservationResult,
    ),
  };
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function POST(req: Request): Promise<Response> {
  const readiness = await getReadiness();
  if (readiness.status !== 'ready') {
    return Response.json(readiness, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const body = (await req.json()) as {
    question?: unknown;
    mode?: unknown;
    context?: EditorContext;
  };
  const question = String(body.question ?? '').trim();
  if (!question) return new Response('empty question', { status: 400 });

  if (!process.env.DEEPSEEK_API_KEY)
    return new Response('DEEPSEEK_API_KEY 未设置', { status: 500 });

  const editorContext = body.context;
  const mode: AskMode =
    body.mode === 'explain_field' || body.mode === 'explain_error'
      ? body.mode
      : 'free';
  const { getClient, prepareAsk } = await import('@/server/pipeline');
  const requestId = randomUUID();
  const { hits, sources, request } = await prepareAsk({
    question,
    editorContext,
    mode,
    retrievalOptions: servingObservationRetrievalOptions(requestId),
  });
  // 合并引用编号和 formatSources 规范化后的 provenance。
  const cited = hits.map((h, i) => ({
    ...h,
    n: sources[i]?.n ?? i + 1,
    provenance: sources[i]?.provenance ?? h.provenance,
  }));
  const client = getClient();

  const stream = client.messages.stream(request);

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sse('sources', cited));
        stream.on('text', (t) => controller.enqueue(sse('delta', t)));
        await stream.finalMessage();
        controller.enqueue(sse('done', {}));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

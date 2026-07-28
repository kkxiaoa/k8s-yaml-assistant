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
import {
  getRuntimeConfig,
  requireRuntimeCapability,
} from '@/server/runtime-config';
import {
  upstreamErrorEvent,
  upstreamErrorResponse,
} from '@/server/upstream-error';
import { readApiRequest } from '@/server/api-contract';
import type { RetrieveContextOptions } from '@/server/pipeline';

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
      rootDir: resolve(process.cwd(), 'data/observability/segments'),
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
  let runtimeConfig;
  try {
    runtimeConfig = getRuntimeConfig();
    requireRuntimeCapability('deepseek');
    requireRuntimeCapability('voyage');
  } catch (error) {
    return upstreamErrorResponse(error);
  }

  const readiness = await getReadiness();
  if (readiness.status !== 'ready') {
    return Response.json(readiness, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const body = await readApiRequest(req, 'ask');
  if (!body.ok) return body.response;
  const {
    question,
    context: editorContext,
    mode,
  } = body.value;
  let prepared;
  let stream;
  try {
    const { getClient, prepareAsk } = await import('@/server/pipeline');
    const requestId = randomUUID();
    prepared = await prepareAsk({
      question,
      editorContext,
      mode,
      retrievalOptions: {
        ...servingObservationRetrievalOptions(requestId),
        queryExpansion: runtimeConfig.queryExpansionEnabled,
      },
    });
    stream = getClient().messages.stream(prepared.request);
  } catch (error) {
    return upstreamErrorResponse(error);
  }
  const { hits, sources } = prepared;
  // 合并引用编号和 formatSources 规范化后的 provenance。
  const cited = hits.map((h, i) => ({
    ...h,
    n: sources[i]?.n ?? i + 1,
    provenance: sources[i]?.provenance ?? h.provenance,
  }));
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      try {
        controller.enqueue(sse('sources', cited));
        stream.on('text', (text) => {
          if (!closed) controller.enqueue(sse('delta', text));
        });
        await stream.finalMessage();
        controller.enqueue(sse('done', {}));
        closed = true;
        controller.close();
      } catch (error) {
        if (closed) return;
        controller.enqueue(sse('error', upstreamErrorEvent(error)));
        closed = true;
        controller.close();
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

import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { decodeServingObservationConfig } from '@/observability/config';
import { createLocalObservationSink } from '@/observability/local-sink';
import {
  createServingObservationRecorder,
  type ServingObservationRecorder,
  type ServingObservationRecordResult,
} from '@/observability/recorder';
import { getReadiness } from '@/server/health';
import {
  requireAskRuntimeAccess,
  type AskRuntimeAccess,
} from '@/server/runtime-config';
import {
  upstreamErrorEvent,
  upstreamErrorResponse,
} from '@/server/upstream-error';
import { readApiRequest } from '@/server/api-contract';
import {
  admitApiRequest,
  modelAccessGate,
} from '@/server/request-limiter';
import {
  actorLimiterSubject,
  finishModelRequest,
  resolveModelActor,
  reserveModelRequest,
} from '@/server/model-access';
import { ModelUsageCollector } from '@/server/provider-usage';
import {
  modelTextResponse,
  requireModelText,
} from '@/server/model-response';
import type {
  RetrieveContextOptions,
  prepareAsk as prepareAskFunction,
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
  const modelAccess = modelAccessGate();
  if (modelAccess) return modelAccess;

  let runtimeAccess: AskRuntimeAccess;
  try {
    runtimeAccess = requireAskRuntimeAccess();
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

  const actor = await resolveModelActor();
  if (!actor.ok) return actor.response;
  const body = await readApiRequest(req, 'ask');
  if (!body.ok) return body.response;
  const {
    question,
    context: editorContext,
    mode,
  } = body.value;
  const admission = admitApiRequest(
    'ask',
    actorLimiterSubject(actor.actor),
  );
  if (!admission.ok) return admission.response;
  const reserved = reserveModelRequest('ask', actor.actor);
  if (!reserved.ok) {
    admission.release();
    return reserved.response;
  }
  const requestId = reserved.reservation.requestId;
  const usage = new ModelUsageCollector();
  let accountingFinished = false;
  const finishAccounting = (outcome: 'success' | 'failure'): void => {
    if (accountingFinished) return;
    accountingFinished = true;
    finishModelRequest(
      reserved.store,
      reserved.reservation,
      usage,
      outcome,
    );
  };
  let streamOwnsAdmission = false;
  let prepared: Awaited<ReturnType<typeof prepareAskFunction>>;
  let stream: ReturnType<Anthropic['messages']['stream']>;
  try {
    try {
      const { getClient, prepareAsk } = await import('@/server/pipeline');
      prepared = await prepareAsk({
        question,
        editorContext,
        mode,
        retrievalOptions: {
          ...servingObservationRetrievalOptions(requestId),
          queryExpansion:
            runtimeAccess.retrieval.config.queryExpansionEnabled,
          runtimeAccess: runtimeAccess.retrieval,
          requestObserver: usage,
        },
      });
      usage.requestStarted('deepseek');
      stream = getClient(runtimeAccess.deepseek).messages.stream(
        prepared.request,
      );
    } catch (error) {
      finishAccounting('failure');
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
          stream.on('text', (text: string) => {
            if (!closed) controller.enqueue(sse('delta', text));
          });
          const finalMessage = await stream.finalMessage();
          usage.deepSeekUsage(
            prepared.request.model,
            finalMessage.usage?.input_tokens,
            finalMessage.usage?.output_tokens,
            finalMessage.usage?.cache_creation_input_tokens,
            finalMessage.usage?.cache_read_input_tokens,
          );
          requireModelText(modelTextResponse(finalMessage));
          finishAccounting('success');
          controller.enqueue(
            sse('done', { requestId }),
          );
          closed = true;
          controller.close();
        } catch (error) {
          if (closed) return;
          finishAccounting('failure');
          controller.enqueue(sse('error', upstreamErrorEvent(error)));
          closed = true;
          controller.close();
        } finally {
          admission.release();
        }
      },
      cancel() {
        stream.abort();
        finishAccounting('failure');
        admission.release();
      },
    });

    const response = new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
    streamOwnsAdmission = true;
    return response;
  } finally {
    if (!streamOwnsAdmission) {
      finishAccounting('failure');
      admission.release();
    }
  }
}

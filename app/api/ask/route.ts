import {
  getClient,
  prepareAsk,
  type AskMode,
  type EditorContext,
} from '@/server/pipeline';
import { appendServingTrace } from '@/retrieval/trace';

export const runtime = 'nodejs'; // 需要 Node:Anthropic SDK、dotenv、fetch 向量/rerank

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function POST(req: Request): Promise<Response> {
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
  const { hits, sources, request } = await prepareAsk({
    question,
    editorContext,
    mode,
    retrievalOptions: { traceSink: appendServingTrace },
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

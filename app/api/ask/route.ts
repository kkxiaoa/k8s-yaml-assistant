import {
  getClient,
  retrieveContext,
  ASK_SYSTEM,
  ANSWER_MODEL,
  formatEditorContext,
  type AskMode,
  type EditorContext,
} from '@/server/pipeline';

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
  const { context, hits } = await retrieveContext(
    question,
    3,
    editorContext,
    mode,
  );
  const client = getClient();

  const stream = client.messages.stream({
    model: ANSWER_MODEL,
    max_tokens: 2048,
    system: ASK_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `参考以下上下文和 K8s 字段文档片段回答问题。\n\n<ask_mode>\n${mode}\n</ask_mode>\n\n${formatEditorContext(editorContext)}\n\n<current_yaml>\n${editorContext?.yaml ?? '无'}\n</current_yaml>\n\n<docs>\n${context}\n</docs>\n\n问题:${question}`,
      },
    ],
  });

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sse('sources', hits));
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

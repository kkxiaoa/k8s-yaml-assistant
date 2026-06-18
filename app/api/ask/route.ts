import { getClient, retrieveContext, ASK_SYSTEM, ANSWER_MODEL } from '@/server/pipeline';

export const runtime = 'nodejs'; // 需要 Node:Anthropic SDK、dotenv、fetch 向量/rerank

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { question?: unknown };
  const question = String(body.question ?? '').trim();
  if (!question) return new Response('empty question', { status: 400 });
  if (!process.env.DEEPSEEK_API_KEY) return new Response('DEEPSEEK_API_KEY 未设置', { status: 500 });

  const { context } = await retrieveContext(question, 3);
  const client = getClient();

  const stream = client.messages.stream({
    model: ANSWER_MODEL,
    max_tokens: 2048,
    system: ASK_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `参考以下 K8s 字段文档片段回答问题。\n\n<docs>\n${context}\n</docs>\n\n问题:${question}`,
      },
    ],
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        stream.on('text', (t) => controller.enqueue(encoder.encode(t)));
        await stream.finalMessage();
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

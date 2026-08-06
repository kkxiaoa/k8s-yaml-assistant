import { config } from 'dotenv';
config({ override: true }); // 用 .env 覆盖继承的同名环境变量
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildAskRequest,
  retrieveContext,
} from '../server/pipeline';
import {
  modelTextResponse,
  requireModelText,
} from '../server/model-response';

type AskRetrievalResult = Awaited<ReturnType<typeof retrieveContext>>;

export type AskRetriever = (
  question: string,
  k: number,
) => Promise<AskRetrievalResult>;

export function retrieveAskDocuments(
  question: string,
  retriever: AskRetriever = retrieveContext,
): Promise<AskRetrievalResult> {
  return retriever(question, 3);
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('用法: npm run ask -- "你的问题"');
    console.error(
      '示例: npm run ask -- "reclaimPolicy 能填哪些值?默认是什么?"',
    );
    process.exit(1);
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(
      'DEEPSEEK_API_KEY 未设置。在 .env 里填入,申请地址 https://platform.deepseek.com/',
    );
    process.exit(1);
  }

  const client = new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  console.error('[1/2] 共享检索：校验持久化索引 → 粗召回 → 重排...');
  const { context, hits, trace } = await retrieveAskDocuments(question);
  const indexCache = trace.cache?.index;
  let indexState = '状态未知';
  if (indexCache?.status === 'hit') indexState = '命中';
  if (indexCache?.status === 'rebuilt') {
    indexState = `已重建（${indexCache.reason}）`;
  }
  if (indexCache?.status === 'not_used') indexState = '未使用';
  console.error(
    `      索引：${indexState}；路由：${trace.resourceHint ?? '未识别'}；路径：${trace.path === 'exact' ? '精确字段' : '语义检索'}`,
  );
  for (const h of hits) {
    console.error(
      `      · ${h.title}${h.score === undefined ? '' : `  （分数 ${h.score.toFixed(3)}）`}`,
    );
  }

  console.error('\n[2/2] 通过 DeepSeek 兼容端点流式作答：\n');
  const stream = client.messages.stream(
    buildAskRequest({ question, context, mode: 'free' }),
  );

  stream.on('text', (delta) => process.stdout.write(delta));
  const final = await stream.finalMessage();
  requireModelText(modelTextResponse(final));
  process.stdout.write('\n\n');

  const u = final.usage;
  console.error(`[usage] input=${u.input_tokens} output=${u.output_tokens}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((e: unknown) => {
    console.error('\n错误:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

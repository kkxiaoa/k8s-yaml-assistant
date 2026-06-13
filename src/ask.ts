// 迭代0 主流程:检索 → 拼上下文 → 流式作答。
// 跑通它,你就同时摸到了 RAG 的四个点:切片(corpus)/ 向量库(retrieve)/ 检索(cosine)/ 流式(下面)。
//
// 用 Anthropic SDK,但 baseURL 指向 DeepSeek 的 Anthropic 兼容端点(便宜)。
// 好处:代码保持 Anthropic 形态,以后换回真 Claude 只需改 baseURL + 模型名。
// embedding 仍用 Voyage(DeepSeek 没有 embedding 接口)。
//
// 用法: npm run ask -- "reclaimPolicy 能填哪些值?默认是什么?"

import { config } from 'dotenv';
config({ override: true }); // 用 .env 覆盖继承的同名环境变量
import Anthropic from '@anthropic-ai/sdk';
import { buildIndex, retrieve } from './retrieve';
import { inferResource } from './router';
import { rerank, COARSE_N } from './rerank';

const SYSTEM_PROMPT = `你是一位精通 Kubernetes 资源模型的助手,服务于一个容器云平台控制台。
你的任务是基于给定的 K8s 字段文档片段,准确回答用户关于资源配置的问题。

规则:
- 只依据提供的 <docs> 片段作答,不要编造文档里没有的字段或取值。
- 如果片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 回答简洁、准确,涉及枚举值时把合法取值列全。
- 用中文回答。`;

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

  // 用 Anthropic SDK 接 DeepSeek:只换 baseURL + key。
  // 以后换回真 Claude:baseURL 删掉(走官方),apiKey 换 ANTHROPIC_API_KEY,模型名照常即可。
  const client = new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  console.error('[1/3] 构建向量索引(embedding 语料)...');
  const index = await buildIndex();

  // ② 路由+软加权做粗召回;④ rerank 精排
  const routed = inferResource(question);
  console.error(
    `[2/3] 路由 → ${routed ?? '(未识别)'};粗召回 top-${COARSE_N} → rerank 精排 top-3...`,
  );
  const coarse = await retrieve(question, index, COARSE_N, routed ?? undefined);
  const reranked = await rerank(question, coarse.map((h) => h.chunk.text), 3);
  const hits = reranked.map((r) => ({ chunk: coarse[r.index]!.chunk, score: r.score }));
  for (const h of hits) {
    console.error(`      · ${h.chunk.title}  (rerank ${h.score.toFixed(3)})`);
  }

  const context = hits
    .map((h) => `## ${h.chunk.title}\n${h.chunk.text}`)
    .join('\n\n');

  console.error('\n[3/3] 流式作答(DeepSeek via Anthropic 兼容端点):\n');
  const stream = client.messages.stream({
    // claude-sonnet* → DeepSeek 映射到 deepseek-v4-flash(便宜);要更强可用 claude-opus-4-8 → deepseek-v4-pro
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    // 注意:DeepSeek 兼容端点不支持 cache_control,所以这里不加(换回真 Claude 时再加上以省钱)
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `参考以下 K8s 字段文档片段回答问题。\n\n<docs>\n${context}\n</docs>\n\n问题:${question}`,
      },
    ],
  });

  stream.on('text', (delta) => process.stdout.write(delta));
  const final = await stream.finalMessage();
  process.stdout.write('\n\n');

  const u = final.usage;
  console.error(`[usage] input=${u.input_tokens} output=${u.output_tokens}`);
}

main().catch((e: unknown) => {
  console.error('\n错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

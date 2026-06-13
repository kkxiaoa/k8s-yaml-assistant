// 服务端可复用管线:把 CLI 里的检索/校验逻辑抽成函数,供 Next.js API 路由调用。
// 检索流水线(向量 → 软路由 → rerank)与 CLI 完全一致,只是这里被 Web 复用。

import { config } from 'dotenv';
config({ override: true });
import Anthropic from '@anthropic-ai/sdk';
import { load } from 'js-yaml';
import { buildIndex, retrieve, type IndexedChunk } from './retrieve';
import { inferResource } from './router';
import { rerank, COARSE_N } from './rerank';
import { validateStorageClass, type ValidationError } from './validate';

export const ANSWER_MODEL = 'claude-sonnet-4-6'; // DeepSeek 映射 deepseek-v4-flash

export const ASK_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手,服务于一个容器云平台控制台。
基于给定的 <docs> 片段准确回答用户关于资源配置的问题。
规则:
- 只依据 <docs> 作答,不要编造文档里没有的字段或取值。
- 若片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 简洁准确,涉及枚举值时列全。用中文回答。`;

export function getClient(): Anthropic {
  return new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
}

// 索引构建要 embedding 整个语料,较贵 → 进程内缓存,只建一次。
let indexPromise: Promise<IndexedChunk[]> | null = null;
function getIndex(): Promise<IndexedChunk[]> {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
}

export interface Hit {
  title: string;
  text: string;
}

/** 完整检索流水线:软路由 → 粗召回 → rerank 精排 → 拼上下文。 */
export async function retrieveContext(question: string, k = 3): Promise<{ context: string; hits: Hit[] }> {
  const index = await getIndex();
  const routed = inferResource(question);
  const coarse = await retrieve(question, index, COARSE_N, routed ?? undefined);
  const rr = await rerank(question, coarse.map((h) => h.chunk.text), k);
  const hits = rr.map((r) => coarse[r.index]!.chunk);
  const context = hits.map((c) => `## ${c.title}\n${c.text}`).join('\n\n');
  return { context, hits: hits.map((c) => ({ title: c.title, text: c.text })) };
}

/** 校验一段 StorageClass YAML 文本(解析 + 规则校验)。供 /api/check 调用。 */
export function validateYamlText(yamlText: string): ValidationError[] {
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (e) {
    return [{ path: '', message: 'YAML 解析失败: ' + (e instanceof Error ? e.message : String(e)) }];
  }
  return validateStorageClass(parsed);
}

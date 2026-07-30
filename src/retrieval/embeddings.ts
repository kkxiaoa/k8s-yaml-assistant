// 远程 embedding API 客户端。迭代0 用 Voyage AI(Anthropic 官方推荐的 embedding 提供商)。
// 故意只暴露一个 embed() 函数,方便迭代3 换成别的提供商或本地模型而不动其他代码。

import {
  getRetrievalRuntimeConfig,
  requireRetrievalRuntimeAccess,
  type RetrievalRuntimeAccess,
} from '../server/runtime-config';
import { UpstreamHttpError } from '../server/upstream-error';
import { voyageRequestSignal } from '../server/model-request-policy';
import type { ProviderRequestObserver } from '../server/provider-usage';

/** 读取已经显式解码的 embedding 模型身份。 */
export function resolveEmbeddingModel(): string {
  return getRetrievalRuntimeConfig().voyage.embeddingModel;
}
const MAX_BATCH_SIZE = 1000;

interface VoyageResponse {
  data: { embedding: number[] }[];
  usage?: { total_tokens?: unknown };
}

/**
 * 把一批文本转成向量。
 * @param texts 待编码的文本数组
 * @param inputType "document"(入库的语料)或 "query"(用户问题)——Voyage 会据此微调编码,提升检索质量
 */
export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
  model?: string,
  runtimeAccess: RetrievalRuntimeAccess = requireRetrievalRuntimeAccess(),
  observer?: ProviderRequestObserver,
): Promise<number[][]> {
  const config = runtimeAccess.config;
  const key = runtimeAccess.apiKey();
  const resolvedModel = model ?? config.voyage.embeddingModel;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    observer?.requestStarted('voyage');
    const res = await fetch(config.voyage.embeddingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        input: batch,
        model: resolvedModel,
        input_type: inputType,
      }),
      signal: voyageRequestSignal(),
    });

    if (!res.ok) {
      throw new UpstreamHttpError(res.status);
    }

    const json = (await res.json()) as VoyageResponse;
    if (!Array.isArray(json.data) || json.data.length !== batch.length) {
      throw new Error('invalid upstream embedding response');
    }
    const embeddings = json.data.map((item) => item.embedding);
    if (
      embeddings.some(
        (embedding) =>
          !Array.isArray(embedding) ||
          embedding.length === 0 ||
          embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error('invalid upstream embedding response');
    }
    observer?.voyageEmbeddingUsage(
      resolvedModel,
      json.usage?.total_tokens,
    );
    out.push(...embeddings);
  }
  return out;
}

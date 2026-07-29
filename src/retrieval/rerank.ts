// ④ Rerank:用 Voyage 的专用 cross-encoder 对粗召回结果精排。
// cross-encoder 会"同时读 query 和 doc"再打分,比向量(各自编码再算余弦)更懂细粒度相关性,
// 所以能把"语义弱匹配但确实相关"的 chunk(如 'provisioner 必填' 对 'StorageClass 必填字段')提上来。
//
// 关键:rerank 只能重排"粗召回已经捞到的"候选。COARSE_N 给小了,正确 chunk 没进候选,精排也救不回。

import {
  requireRetrievalRuntimeAccess,
  type RetrievalRuntimeAccess,
  VOYAGE_RERANK_MODEL,
} from '../server/runtime-config';
import { UpstreamHttpError } from '../server/upstream-error';
import { voyageRequestSignal } from '../server/model-request-policy';
import type { ProviderRequestObserver } from '../server/provider-usage';

/** 当前 rerank 模型名。记入 eval run / baseline 元数据。 */
export const RERANK_MODEL = VOYAGE_RERANK_MODEL;

/** 粗召回候选数:向量先取这么多,再交给 rerank 精排。*/
export const COARSE_N = 10;

interface VoyageRerankResult {
  index: number; // 在输入 documents 数组里的下标
  relevance_score: number;
}

/**
 * 对一批文档按与 query 的相关性重排。
 * @returns 按相关性降序的 { index(指向输入 documents), score }
 */
export async function rerank(
  query: string,
  documents: string[],
  topK: number,
  runtimeAccess: RetrievalRuntimeAccess = requireRetrievalRuntimeAccess(),
  observer?: ProviderRequestObserver,
): Promise<Array<{ index: number; score: number }>> {
  const config = runtimeAccess.config;
  const key = runtimeAccess.apiKey();
  if (documents.length === 0) return [];

  observer?.requestStarted('voyage');
  const res = await fetch(config.voyage.rerankUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: config.voyage.rerankModel,
      top_k: topK,
    }),
    signal: voyageRequestSignal(),
  });
  if (!res.ok) {
    throw new UpstreamHttpError(res.status);
  }
  const json = (await res.json()) as {
    data: VoyageRerankResult[];
    usage?: { total_tokens?: unknown };
  };
  if (
    !Array.isArray(json.data) ||
    json.data.some(
      (result) =>
        !Number.isInteger(result.index) ||
        result.index < 0 ||
        result.index >= documents.length ||
        !Number.isFinite(result.relevance_score),
    )
  ) {
    throw new Error('invalid upstream rerank response');
  }
  observer?.voyageRerankUsage(
    config.voyage.rerankModel,
    json.usage?.total_tokens,
  );
  return json.data.map((r) => ({ index: r.index, score: r.relevance_score }));
}

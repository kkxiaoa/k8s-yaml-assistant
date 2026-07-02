// ④ Rerank:用 Voyage 的专用 cross-encoder 对粗召回结果精排。
// cross-encoder 会"同时读 query 和 doc"再打分,比向量(各自编码再算余弦)更懂细粒度相关性,
// 所以能把"语义弱匹配但确实相关"的 chunk(如 'provisioner 必填' 对 'StorageClass 必填字段')提上来。
//
// 关键:rerank 只能重排"粗召回已经捞到的"候选。COARSE_N 给小了,正确 chunk 没进候选,精排也救不回。

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
/** 当前 rerank 模型名。记入 eval run / baseline 元数据。 */
export const RERANK_MODEL = 'rerank-2.5';

/** 粗召回候选数:向量先取这么多,再交给 rerank 精排。语料 22 段,取 10 给精排足够的空间。 */
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
): Promise<Array<{ index: number; score: number }>> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY 未设置');
  if (documents.length === 0) return [];

  const res = await fetch(VOYAGE_RERANK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, documents, model: RERANK_MODEL, top_k: topK }),
  });
  if (!res.ok) {
    throw new Error(`Voyage rerank ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: VoyageRerankResult[] };
  return json.data.map((r) => ({ index: r.index, score: r.relevance_score }));
}

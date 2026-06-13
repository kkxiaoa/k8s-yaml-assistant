// 内存向量索引 + 余弦相似度检索。迭代0 用内存即可(语料就几段);
// 语料变大时(迭代3)再换成真正的向量库(pgvector / Chroma 等)。

import { embed } from './embeddings';
import { CORPUS, type Chunk } from '../knowledge/corpus';
import { RESOURCE_BOOST } from './router';

export interface IndexedChunk extends Chunk {
  embedding: number[];
}

/** 余弦相似度:衡量两个向量方向的接近程度,范围 [-1, 1],越大越相关。 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 把整个语料编码成带向量的索引(内存)。启动时跑一次。 */
export async function buildIndex(): Promise<IndexedChunk[]> {
  const embeddings = await embed(
    CORPUS.map((c) => c.text),
    'document',
  );
  return CORPUS.map((c, i) => ({ ...c, embedding: embeddings[i] ?? [] }));
}

/**
 * 用问题向量在索引里找 top-k 最相关的片段。
 * @param boostResource 若提供,命中该资源的 chunk 在相似度上 +RESOURCE_BOOST(软加权,不删除其它资源)
 */
export async function retrieve(
  query: string,
  index: IndexedChunk[],
  k = 3,
  boostResource?: string,
): Promise<Array<{ chunk: Chunk; score: number }>> {
  const [queryEmbedding] = await embed([query], 'query');
  if (!queryEmbedding) return [];
  return index
    .map((c) => ({
      chunk: c as Chunk,
      // 软加权:命中路由资源的 chunk 加分,但保留所有 chunk(误路由也不会删掉正确答案)
      score:
        cosineSimilarity(queryEmbedding, c.embedding) +
        (boostResource && c.resource === boostResource ? RESOURCE_BOOST : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

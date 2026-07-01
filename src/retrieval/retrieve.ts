// 内存向量索引 + 余弦相似度检索。迭代0 用内存即可(语料就几段);
// 语料变大时(迭代3)再换成真正的向量库(pgvector / Chroma 等)。

import { embed, EMBEDDING_MODEL } from './embeddings';
import { CORPUS, type Chunk } from '../knowledge/corpus';
import { RESOURCE_BOOST } from './router';
import { rerank, COARSE_N } from './rerank';
import { readIndex, computeCorpusHash, computeIndexHash } from './index-store';

const FIELD_PATH_BOOST = 0.08;

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

/** 把语料编码成带向量的索引。调用方应按资源缩小 chunks,避免全量集群 schema 冷启动。 */
export async function buildIndex(chunks: Chunk[] = CORPUS): Promise<IndexedChunk[]> {
  const embeddings = await embed(
    chunks.map((c) => c.text),
    'document',
  );
  return chunks.map((c, i) => ({ ...c, embedding: embeddings[i] ?? [] }));
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
  boostPath?: string,
): Promise<Array<{ chunk: Chunk; score: number }>> {
  const [queryEmbedding] = await embed([query], 'query');
  if (!queryEmbedding) return [];
  const normalizedPath = boostPath?.toLowerCase();
  return index
    .map((c) => ({
      chunk: c as Chunk,
      // 软加权:命中路由资源的 chunk 加分,但保留所有 chunk(误路由也不会删掉正确答案)
      score:
        cosineSimilarity(queryEmbedding, c.embedding) +
        (boostResource && c.resource === boostResource ? RESOURCE_BOOST : 0) +
        (normalizedPath && c.path.toLowerCase().endsWith(normalizedPath) ? FIELD_PATH_BOOST : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ── 共享检索入口(eval == serving)─────────────────────────────────────────
// 单一全量索引:整个 CORPUS 嵌入一次,模块级缓存。CLI / Web / eval 共用同一份,
// 同一段「软加权粗召回 → rerank 精排」代码,保证 eval 数字预测线上行为。

let corpusIndexPromise: Promise<IndexedChunk[]> | null = null;

/**
 * 优先读持久化索引(data/index):indexHash 与当前 CORPUS+模型匹配才用,
 * 否则(缺失/语料或模型变了)回落到实时嵌入重建。这样 eval/serving 冷启动不必每次重嵌全量。
 */
async function loadOrBuildCorpusIndex(): Promise<IndexedChunk[]> {
  const persisted = readIndex();
  if (persisted) {
    const wantHash = computeIndexHash(computeCorpusHash(CORPUS), EMBEDDING_MODEL);
    if (persisted.manifest.indexHash === wantHash) return persisted.chunks;
  }
  return buildIndex(CORPUS);
}

/** 取(惰性构建/读盘)全量 CORPUS 索引。无硬过滤——路由只影响软加权,不删候选。 */
export function getCorpusIndex(): Promise<IndexedChunk[]> {
  if (!corpusIndexPromise) corpusIndexPromise = loadOrBuildCorpusIndex();
  return corpusIndexPromise;
}

export interface SearchOptions {
  /** 软加权:命中该资源的 chunk 加分(不删其它资源,误路由也不丢答案)。 */
  boostResource?: string;
  /** 软加权:命中该字段路径的 chunk 加分。 */
  boostPath?: string;
  /** 粗召回候选数,默认 COARSE_N。 */
  coarseN?: number;
}

/**
 * 共享检索:全量软加权粗召回 → rerank 精排。返回 rerank 后的完整候选排序
 * (长度 = 粗召回候选数),调用方自行 slice 到 k。serving 取 top-k,eval 据此算 Recall@k / MRR。
 */
export async function searchCorpus(
  queryText: string,
  options: SearchOptions = {},
): Promise<Array<{ chunk: Chunk; score: number }>> {
  const { boostResource, boostPath, coarseN = COARSE_N } = options;
  const index = await getCorpusIndex();
  const coarse = await retrieve(queryText, index, coarseN, boostResource, boostPath);
  if (coarse.length === 0) return [];
  const rr = await rerank(
    queryText,
    coarse.map((h) => h.chunk.text),
    coarse.length,
  );
  return rr.map((r) => ({ chunk: coarse[r.index]!.chunk, score: r.score }));
}

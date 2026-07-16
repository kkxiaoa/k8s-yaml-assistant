// 持久化向量索引读入内存后执行余弦检索;索引不匹配时才全量重建。

import { performance } from 'node:perf_hooks';
import { embed, resolveEmbeddingModel } from './embeddings';
import { buildCorpusManifest, CORPUS, type Chunk } from '../knowledge/corpus';
import { RESOURCE_BOOST } from './router';
import { policyBoost } from './boost';
import { rerank, COARSE_N } from './rerank';
import { readIndex, type IndexReadResult } from './index-store';
import { toTraceHit, type IndexCacheTrace, type RetrievalTrace } from './trace';
import {
  getCachedAliasRegistry,
  prepareQueryExpansion,
  resolveQueryExpansionEnabled,
} from './query-expansion-runtime';

const FIELD_PATH_BOOST = 0.08;

export interface IndexedChunk extends Chunk {
  embedding: number[];
}

export type RetrievalPipelineStage =
  | 'index'
  | 'embedding'
  | 'retrieval'
  | 'rerank';

export class RetrievalPipelineError extends Error {
  readonly stage: RetrievalPipelineStage;
  readonly originalError: unknown;

  constructor(stage: RetrievalPipelineStage, error: unknown) {
    super(
      error instanceof Error
        ? error.message
        : `retrieval pipeline failed at ${stage}`,
      { cause: error },
    );
    this.name = 'RetrievalPipelineError';
    this.stage = stage;
    this.originalError = error;
  }
}

async function executeRetrievalStage<T>(
  stage: RetrievalPipelineStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RetrievalPipelineError) throw error;
    throw new RetrievalPipelineError(stage, error);
  }
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

/** 把给定语料编码成带向量的索引。 */
export async function buildIndex(
  chunks: Chunk[] = CORPUS,
): Promise<IndexedChunk[]> {
  const embeddings = await embed(
    chunks.map((c) => c.text),
    'document',
  );
  return chunks.map((c, i) => ({ ...c, embedding: embeddings[i] ?? [] }));
}

/**
 * 纯向量打分(同步,无网络):对已嵌入的 query 在索引上算余弦 + 软加权,取 top-k。
 * 拆出来是为了 trace 能单独对「dense 打分」这一档计时(embed 在外层单独计时)。
 */
export function denseSearch(
  queryEmbedding: number[],
  index: IndexedChunk[],
  k: number,
  boostResource?: string,
  boostPath?: string,
  boostApiVersion?: string,
): Array<{ chunk: Chunk; score: number }> {
  const normalizedPath = boostPath?.toLowerCase();
  const matchesTarget = (chunk: Chunk, path: string | undefined): boolean =>
    chunk.targets.some(
      (target) =>
        (!boostResource || target.kind === boostResource) &&
        (!boostApiVersion ||
          !target.apiVersion ||
          target.apiVersion === boostApiVersion) &&
        (!path || target.path?.toLowerCase().endsWith(path)),
    );

  return index
    .map((c) => ({
      chunk: c as Chunk,
      // 软加权:命中路由资源的 chunk 加分,但保留所有 chunk(误路由也不会删掉正确答案)
      score:
        cosineSimilarity(queryEmbedding, c.embedding) +
        (boostResource && matchesTarget(c, undefined) ? RESOURCE_BOOST : 0) +
        (normalizedPath && matchesTarget(c, normalizedPath)
          ? FIELD_PATH_BOOST
          : 0) +
        policyBoost(c as Chunk, boostResource, normalizedPath, boostApiVersion),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
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
  boostApiVersion?: string,
): Promise<Array<{ chunk: Chunk; score: number }>> {
  const [queryEmbedding] = await embed([query], 'query');
  if (!queryEmbedding) return [];
  return denseSearch(
    queryEmbedding,
    index,
    k,
    boostResource,
    boostPath,
    boostApiVersion,
  );
}

// ── 共享检索入口(eval == serving)─────────────────────────────────────────
// 单一全量索引:整个 CORPUS 嵌入一次,模块级缓存。CLI / Web / eval 共用同一份,
// 同一段「软加权粗召回 → rerank 精排」代码,保证 eval 数字预测线上行为。

let corpusIndexPromise: Promise<IndexedChunk[]> | null = null;
let corpusIndexCache: IndexCacheTrace | null = null;

export async function resolveCorpusIndex(
  persisted: IndexReadResult,
  rebuild: () => Promise<IndexedChunk[]>,
): Promise<{ chunks: IndexedChunk[]; cache: IndexCacheTrace }> {
  if (persisted.status === 'hit') {
    return { chunks: persisted.chunks, cache: { status: 'hit' } };
  }
  return {
    chunks: await rebuild(),
    cache: { status: 'rebuilt', reason: persisted.reason },
  };
}

/**
 * 持久化索引只有在 format、corpus 双 identity 与模型全部匹配时才使用；
 * 其余情况都基于当前 CORPUS 实时重建，并保留结构化 miss reason。
 */
async function loadOrBuildCorpusIndex(): Promise<IndexedChunk[]> {
  const expectation = {
    corpusManifest: buildCorpusManifest(),
    corpusChunks: CORPUS,
    embeddingModel: resolveEmbeddingModel(),
  };
  const resolved = await resolveCorpusIndex(readIndex(expectation), () =>
    buildIndex(CORPUS),
  );
  corpusIndexCache = resolved.cache;
  return resolved.chunks;
}

/** 取(惰性构建/读盘)全量 CORPUS 索引。无硬过滤——路由只影响软加权,不删候选。 */
export function getCorpusIndex(): Promise<IndexedChunk[]> {
  if (!corpusIndexPromise) corpusIndexPromise = loadOrBuildCorpusIndex();
  return corpusIndexPromise;
}

/** 当前模块级 index cache 的命中或重建状态。 */
export function getCorpusIndexCache(): IndexCacheTrace | null {
  return corpusIndexCache;
}

export interface SearchOptions {
  /** 软加权:命中该资源的 chunk 加分(不删其它资源,误路由也不丢答案)。 */
  boostResource?: string;
  /** 软加权:命中该字段路径的 chunk 加分。 */
  boostPath?: string;
  /** 当前 YAML 的 apiVersion；有值时不提升同 Kind 的其他 schema 版本。 */
  boostApiVersion?: string;
  /** 粗召回候选数,默认 COARSE_N。 */
  coarseN?: number;
  /** 显式覆盖 query expansion feature flag,供 A/B 和回退验证。 */
  queryExpansion?: boolean;
}

/** searchCorpusTraced 返回:命中 + 检索过程 trace(不含 question/mode/hint,由上层补) */
export type SearchTrace = Pick<
  RetrievalTrace,
  | 'queryText'
  | 'queryExpansion'
  | 'coarseHits'
  | 'rerankHits'
  | 'latencyMs'
  | 'cache'
>;

/**
 * 共享检索(带 trace):全量软加权粗召回 → rerank 精排。分档计时 embed / dense / rerank,
 * 记录粗召回、rerank 命中及 index hit/rebuild 原因。返回 rerank 后完整候选(长度=coarseN),调用方 slice 到 k。
 */
export async function searchCorpusTraced(
  queryText: string,
  options: SearchOptions = {},
): Promise<{
  hits: Array<{ chunk: Chunk; score: number }>;
  trace: SearchTrace;
}> {
  const {
    boostResource,
    boostPath,
    boostApiVersion,
    coarseN = COARSE_N,
    queryExpansion,
  } = options;
  const t0 = performance.now();
  const prepared = await executeRetrievalStage('retrieval', () => {
    const expansionEnabled = resolveQueryExpansionEnabled(queryExpansion);
    return prepareQueryExpansion(
      queryText,
      boostResource,
      expansionEnabled,
      expansionEnabled ? getCachedAliasRegistry() : undefined,
    );
  });
  const effectiveQueryText = prepared.queryText;
  const effectiveBoostResource = prepared.boostResource;
  const index = await executeRetrievalStage('index', () => getCorpusIndex());
  const indexCache = getCorpusIndexCache();
  if (!indexCache) {
    throw new RetrievalPipelineError(
      'index',
      new Error('corpus index cache state missing after index resolution'),
    );
  }

  const tEmbed = performance.now();
  const [queryEmbedding] = await executeRetrievalStage('embedding', () =>
    embed([effectiveQueryText], 'query'),
  );
  const embedMs = performance.now() - tEmbed;
  const emptyTrace = (): SearchTrace => ({
    queryText: effectiveQueryText,
    queryExpansion: prepared.trace,
    coarseHits: [],
    rerankHits: [],
    latencyMs: { embed: embedMs, total: performance.now() - t0 },
    cache: { index: indexCache, embeddingHit: false },
  });
  if (!queryEmbedding) return { hits: [], trace: emptyTrace() };

  const tDense = performance.now();
  const coarse = await executeRetrievalStage('retrieval', () =>
    denseSearch(
      queryEmbedding,
      index,
      coarseN,
      effectiveBoostResource,
      boostPath,
      boostApiVersion,
    ),
  );
  const denseMs = performance.now() - tDense;
  if (coarse.length === 0) return { hits: [], trace: emptyTrace() };

  const tRerank = performance.now();
  const rr = await executeRetrievalStage('rerank', () =>
    rerank(
      effectiveQueryText,
      coarse.map((h) => h.chunk.text),
      coarse.length,
    ),
  );
  const rerankMs = performance.now() - tRerank;
  const hits = await executeRetrievalStage('rerank', () =>
    rr.map((r) => {
      const hit = coarse[r.index];
      if (!hit) throw new Error(`rerank returned invalid index ${r.index}`);
      return { chunk: hit.chunk, score: r.score };
    }),
  );

  return {
    hits,
    trace: {
      queryText: effectiveQueryText,
      queryExpansion: prepared.trace,
      coarseHits: coarse.map((h) => toTraceHit(h.chunk, h.score)),
      rerankHits: hits.map((h) => toTraceHit(h.chunk, h.score)),
      latencyMs: {
        embed: embedMs,
        dense: denseMs,
        rerank: rerankMs,
        total: performance.now() - t0,
      },
      cache: { index: indexCache, embeddingHit: false },
    },
  };
}

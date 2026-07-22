// 持久化向量索引读入内存后执行余弦检索；索引不匹配时在线路径封闭失败。

import { performance } from 'node:perf_hooks';
import { embed, resolveEmbeddingModel } from './embeddings';
import { buildCorpusManifest, CORPUS, type Chunk } from '../knowledge/corpus';
import { RESOURCE_BOOST } from './router';
import { policyBoost } from './boost';
import { rerank, COARSE_N } from './rerank';
import {
  readIndex,
  type IndexedChunk,
  type IndexMissReason,
  type IndexReadResult,
} from './index-store';
import { toTraceHit, type IndexCacheTrace, type RetrievalTrace } from './trace';
import {
  getCachedAliasRegistry,
  prepareQueryExpansion,
  resolveQueryExpansionEnabled,
} from './query-expansion-runtime';

const FIELD_PATH_BOOST = 0.08;

export type { IndexedChunk } from './index-store';

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
function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
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

/**
 * 纯向量打分(同步,无网络):对已嵌入的 query 在索引上算余弦 + 软加权,取 top-k。
 * 拆出来是为了 trace 能单独对「dense 打分」这一档计时(embed 在外层单独计时)。
 */
export function denseSearch(
  queryEmbedding: number[],
  index: readonly IndexedChunk[],
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
  index: readonly IndexedChunk[],
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
// 单一全量索引在模块级缓存。CLI / Web / eval 共用同一份,
// 同一段「软加权粗召回 → rerank 精排」代码,保证 eval 数字预测线上行为。

export class CorpusIndexUnavailableError extends Error {
  readonly code = 'corpus_index_unavailable' as const;
  readonly reason: IndexMissReason;

  constructor(reason: IndexMissReason) {
    super('corpus index unavailable');
    this.name = 'CorpusIndexUnavailableError';
    this.reason = reason;
  }
}

export async function resolveCorpusIndex(
  persisted: IndexReadResult,
): Promise<{ chunks: IndexedChunk[]; cache: IndexCacheTrace }> {
  if (persisted.status === 'hit') {
    return { chunks: persisted.chunks, cache: { status: 'hit' } };
  }
  throw new CorpusIndexUnavailableError(persisted.reason);
}

export interface CorpusIndexLoader {
  load(): Promise<IndexedChunk[]>;
  cache(): IndexCacheTrace | null;
}

export function createCorpusIndexLoader(
  readPersisted: () => IndexReadResult,
): CorpusIndexLoader {
  let loadPromise: Promise<IndexedChunk[]> | null = null;
  let cacheState: IndexCacheTrace | null = null;

  const load = (): Promise<IndexedChunk[]> => {
    loadPromise ??= Promise.resolve()
      .then(readPersisted)
      .then(resolveCorpusIndex)
      .then((resolved) => {
        cacheState = resolved.cache;
        return resolved.chunks;
      });
    return loadPromise;
  };

  return {
    load,
    cache: () => cacheState,
  };
}

const corpusIndexLoader = createCorpusIndexLoader(() =>
  readIndex({
    corpusManifest: buildCorpusManifest(),
    corpusChunks: CORPUS,
    embeddingModel: resolveEmbeddingModel(),
  }),
);

/** 读取并缓存全量 CORPUS 索引。无硬过滤——路由只影响软加权,不删候选。 */
export function getCorpusIndex(): Promise<IndexedChunk[]> {
  return corpusIndexLoader.load();
}

/** 当前模块级 index cache 的命中状态。 */
export function getCorpusIndexCache(): IndexCacheTrace | null {
  return corpusIndexLoader.cache();
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
 * 记录粗召回、rerank 命中及 index hit。返回 rerank 后完整候选(长度=coarseN),调用方 slice 到 k。
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

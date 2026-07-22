// Retrieval trace records hit lists, latency buckets and optional usage for eval/serving diagnostics.

import type { KnowledgeChunk } from '../knowledge/chunk';
import type { IndexMissReason } from './index-store';
import type { QueryExpansionTrace } from './query-expansion-runtime';

export type IndexCacheTrace =
  | { status: 'hit' }
  | { status: 'rebuilt'; reason: IndexMissReason }
  | { status: 'not_used' };

export type TraceHit = Pick<
  KnowledgeChunk,
  'id' | 'title' | 'sourceType' | 'provenance' | 'targets'
> & {
  score?: number;
};

export interface RetrievalTrace {
  question: string;
  mode: string;
  resourceHint?: string;
  apiVersionHint?: string;
  fieldPathHint?: string;
  queryText: string;
  queryExpansion?: QueryExpansionTrace;
  /** 走哪条路:exact=精确字段短路;search=向量粗召回+rerank */
  path: 'exact' | 'search';
  coarseHits: TraceHit[];
  rerankHits: TraceHit[];
  finalHits: TraceHit[];
  latencyMs: {
    embed?: number;
    dense?: number;
    sparse?: number;
    rerank?: number;
    llm?: number;
    total: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  cache?: {
    embeddingHit?: boolean;
    index: IndexCacheTrace;
  };
  createdAt: string;
}

export function toTraceHit(
  chunk: Pick<
    KnowledgeChunk,
    | 'id'
    | 'title'
    | 'sourceType'
    | 'provenance'
    | 'targets'
  >,
  score?: number,
): TraceHit {
  return {
    id: chunk.id,
    title: chunk.title,
    sourceType: chunk.sourceType,
    provenance: chunk.provenance,
    targets: chunk.targets,
    score,
  };
}

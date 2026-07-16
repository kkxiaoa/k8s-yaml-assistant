// Retrieval trace records hit lists, latency buckets and optional usage for eval/serving diagnostics.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export function servingTracePath(root = process.cwd()): string {
  return join(root, 'data', 'observability', 'serving-traces.jsonl');
}

export const SERVING_TRACES_PATH = servingTracePath();

export function appendTraceToPath(path: string, trace: RetrievalTrace): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(trace)}\n`);
}

export function appendServingTrace(
  trace: RetrievalTrace,
  path = SERVING_TRACES_PATH,
): boolean {
  try {
    appendTraceToPath(path, trace);
    return true;
  } catch (error) {
    console.error(
      `serving retrieval trace write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function readRetrievalTraces(
  path = SERVING_TRACES_PATH,
): RetrievalTrace[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RetrievalTrace);
}

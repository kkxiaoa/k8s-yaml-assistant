// §4.4 Retrieval Trace:同时记录质量(coarse/rerank/final 命中)、延迟(分档)和成本(usage)。
// 结构对齐方案 §4.4。当前 latency + cache + hits 做实;usage(token/成本)留待把 Voyage
// usage 串过 embed/rerank 后补全(那三个消费方改返回值,列为后续硬化)。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { QueryExpansionTrace } from './query-expansion-runtime';

export interface TraceHit {
  id: string;
  resource: string;
  path?: string;
  score?: number;
}

export interface RetrievalTrace {
  question: string;
  mode: string;
  resourceHint?: string;
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
    indexHit?: boolean;
  };
  createdAt: string;
}

export function toTraceHit(
  chunk: { id: string; resource: string; path?: string },
  score?: number,
): TraceHit {
  return { id: chunk.id, resource: chunk.resource, path: chunk.path, score };
}

export const TRACES_PATH = join(process.cwd(), 'data', 'eval', 'traces.jsonl');

/** 追加一条 trace 到 NDJSON(仅在开启观测时调用,避免正常请求写盘)。 */
export function appendTrace(trace: RetrievalTrace): void {
  mkdirSync(dirname(TRACES_PATH), { recursive: true });
  appendFileSync(TRACES_PATH, `${JSON.stringify(trace)}\n`);
}

export function readTraces(): RetrievalTrace[] {
  if (!existsSync(TRACES_PATH)) return [];
  return readFileSync(TRACES_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RetrievalTrace);
}

// Retrieval trace records hit lists, latency buckets and optional usage for eval/serving diagnostics.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  chunkPaths,
  chunkResources,
  primaryPath,
  primaryResource,
  type KnowledgeChunk,
  type SourceType,
} from '../knowledge/chunk';
import type { QueryExpansionTrace } from './query-expansion-runtime';

export interface TraceHit {
  id: string;
  title?: string;
  sourceType: SourceType;
  resources?: string[];
  paths?: string[];
  resource?: string;
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
  chunk: Pick<
    KnowledgeChunk,
    | 'id'
    | 'title'
    | 'sourceType'
    | 'resource'
    | 'path'
    | 'resources'
    | 'paths'
    | 'appliesTo'
  >,
  score?: number,
): TraceHit {
  const resources = chunkResources(chunk);
  const paths = chunkPaths(chunk);
  return {
    id: chunk.id,
    title: chunk.title,
    sourceType: chunk.sourceType,
    resources: resources.length ? resources : undefined,
    paths: paths.length ? paths : undefined,
    resource: primaryResource(chunk),
    path: primaryPath(chunk),
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
): void {
  appendTraceToPath(path, trace);
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

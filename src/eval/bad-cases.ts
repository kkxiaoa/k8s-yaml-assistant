// §4.5 轻量反馈闭环(离线版)。失败用例沉淀成 data/eval/bad-cases.jsonl。
// 用一个跨任务的 superset 结构:Stage 2 先填检索/解释类字段,Stage 4 再补生成/修复类。
// eval 每次自动 upsert serving 未命中用例;按 id 去重,保留已 triage 的状态,不重复覆盖人工标注。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BadCase {
  id: string;
  createdAt: string;
  taskType:
    | 'explain_field'
    | 'explain_error'
    | 'ask_free'
    | 'generate'
    | 'fix'
    | 'refusal';
  input: {
    question?: string;
    requirement?: string;
    yaml?: string;
    context?: {
      kind?: string;
      apiVersion?: string;
      cursorPath?: string;
      selectedText?: string;
      validationErrors?: Array<{ path: string; message: string }>;
    };
  };
  expected?: {
    answerSummary?: string;
    sourceIds?: string[];
    expectedKinds?: string[];
    mustHavePaths?: string[];
    consistencyChecks?: Array<
      'selector_label_match' | 'service_target_port_match' | 'ingress_service_match'
    >;
  };
  actual: {
    answer?: string;
    yaml?: string;
    sourceIds?: string[];
    traceId?: string;
    diagnostics?: Array<{ stage: string; message: string }>;
  };
  failure: {
    layer:
      | 'retrieval'
      | 'rerank'
      | 'chunking'
      | 'knowledge'
      | 'context'
      | 'prompt'
      | 'generation'
      | 'validation'
      | 'judge'
      | 'ui'
      | 'unknown';
    type:
      | 'retrieval_miss'
      | 'rerank_error'
      | 'chunk_gap'
      | 'knowledge_missing'
      | 'context_missing'
      | 'prompt_error'
      | 'hallucination'
      | 'schema_gap'
      | 'parse_error'
      | 'validation_error'
      | 'consistency_error'
      | 'refusal_error'
      | 'judge_error'
      | 'ui_misleading'
      | 'unknown';
    note?: string;
  };
  severity: 'low' | 'medium' | 'high';
  status: 'new' | 'triaged' | 'converted_to_eval' | 'fixed' | 'wont_fix';
  convertedEvalId?: string;
}

export const BAD_CASES_PATH = join(process.cwd(), 'data', 'eval', 'bad-cases.jsonl');

/** 稳定 id:同一失败(任务+问题+期望来源)跨 run 生成同一 id,保证去重。 */
export function badCaseId(
  taskType: BadCase['taskType'],
  question: string,
  sourceIds: string[],
): string {
  return createHash('sha1')
    .update(`${taskType}\n${question}\n${[...sourceIds].sort().join(',')}`)
    .digest('hex')
    .slice(0, 12);
}

export function readBadCases(): BadCase[] {
  if (!existsSync(BAD_CASES_PATH)) return [];
  return readFileSync(BAD_CASES_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BadCase);
}

/**
 * 合并新捕获的失败用例:已存在的 id 保留原记录(不覆盖人工 triage/status),只追加新 id。
 * @returns 本次新增数量
 */
export function upsertBadCases(incoming: BadCase[]): number {
  const existing = readBadCases();
  const seen = new Set(existing.map((c) => c.id));
  const added = incoming.filter((c) => !seen.has(c.id));
  if (added.length === 0) return 0;

  const all = [...existing, ...added];
  mkdirSync(dirname(BAD_CASES_PATH), { recursive: true });
  writeFileSync(BAD_CASES_PATH, all.map((c) => JSON.stringify(c)).join('\n') + '\n');
  return added.length;
}

/** 把一条 serving 检索未命中转成 BadCase(Stage 2 最小可填版本)。 */
export function retrievalMiss(params: {
  question: string;
  resource: string;
  expectedChunkIds: string[];
  actualTopIds: string[];
  rank: number; // 0=未进粗召回候选;>k=召回但未进 top-k
  k: number;
}): BadCase {
  const { question, resource, expectedChunkIds, actualTopIds, rank, k } = params;
  // rank===0:粗召回就没捞到 → 召回层缺口;rank>k:召回到了但 rerank 没排进 top-k。
  const coarseMiss = rank === 0;
  return {
    id: badCaseId('explain_field', question, expectedChunkIds),
    createdAt: new Date().toISOString(),
    taskType: 'explain_field',
    input: { question, context: { kind: resource } },
    expected: { sourceIds: expectedChunkIds },
    actual: { sourceIds: actualTopIds },
    failure: {
      layer: coarseMiss ? 'retrieval' : 'rerank',
      type: 'retrieval_miss',
      note: coarseMiss
        ? '正确 chunk 未进粗召回候选(coarseN)——召回层缺口'
        : `召回到了但 rerank 后排在 top-${k} 之外(rank=${rank})`,
    },
    severity: coarseMiss ? 'high' : 'medium',
    status: 'new',
  };
}

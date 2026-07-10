// §4.5 轻量反馈闭环(离线版)。失败用例沉淀成 data/eval/bad-cases.jsonl。
// 用一个跨任务的 superset 结构:Stage 2 先填检索/解释类字段,Stage 4 再补生成/修复类。
// eval 每次自动 upsert serving 未命中用例;按 id 去重,保留已 triage 的状态,不重复覆盖人工标注。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FaithOutcome } from './faith-store';

export interface BadCaseOrigin {
  evalCaseId: string;
  source: 'retrieval_eval' | 'faith_eval';
  firstSeenAt: string;
  lastSeenAt: string;
  firstSeenRunId?: string;
  lastSeenRunId?: string;
  observedRunIds: string[];
  occurrenceCount: number;
  scope?: 'full' | 'policy' | 'smoke';
  models?: {
    embedding?: string;
    rerank?: string;
    answer?: string;
    judge?: string;
  };
}

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
      | 'selector_label_match'
      | 'service_target_port_match'
      | 'ingress_service_match'
    >;
  };
  actual: {
    answer?: string;
    yaml?: string;
    sourceIds?: string[];
    traceId?: string;
    diagnostics?: Array<{ stage: string; message: string }>;
    evaluation?: {
      runId: string;
      scope: 'full' | 'policy' | 'smoke';
      outcome: FaithOutcome;
      unsupportedClaims: string[];
      judgeReason?: string;
    };
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
      | 'rerank_miss'
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
  origin?: BadCaseOrigin;
  relatedBadCaseIds?: string[];
}

export const BAD_CASES_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'bad-cases.jsonl',
);

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

export function canonicalBadCaseId(params: {
  evalCaseId: string;
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
}): string {
  const { evalCaseId, layer, type } = params;
  if (!evalCaseId) throw new Error('canonicalBadCaseId requires evalCaseId');
  return createHash('sha1')
    .update(`${evalCaseId}\n${layer}\n${type}`)
    .digest('hex')
    .slice(0, 12);
}

export interface EvalSetBadCaseRef {
  id: string;
  question: string;
  expectedChunkIds: string[];
}

export function migrateBadCasesToCanonical(params: {
  cases: BadCase[];
  evalSet: EvalSetBadCaseRef[];
  manualMap?: Record<string, string>;
  now?: string;
  onDuplicate?: 'throw' | 'merge';
}): { cases: BadCase[]; warnings: string[] } {
  const { cases, evalSet, manualMap = {}, onDuplicate = 'throw' } = params;
  const migrated: BadCase[] = [];
  const warnings: string[] = [];

  for (const badCase of cases) {
    if (badCase.origin?.evalCaseId) {
      migrated.push({ ...badCase });
      continue;
    }

    const manualEvalCaseId = manualMap[badCase.id];
    const matches = manualEvalCaseId
      ? evalSet.filter((c) => c.id === manualEvalCaseId)
      : evalSet.filter((c) => c.question === badCase.input.question);

    if (matches.length !== 1) {
      const sourceIds = badCase.expected?.sourceIds ?? [];
      throw new Error(
        [
          `bad case migration failed: id=${badCase.id}`,
          `question=${badCase.input.question ?? ''}`,
          `expectedSourceIds=${sourceIds.join(',')}`,
          `matches=${matches.length}`,
        ].join(' '),
      );
    }

    const evalCase = matches[0]!;
    const id = canonicalBadCaseId({
      evalCaseId: evalCase.id,
      layer: badCase.failure.layer,
      type: badCase.failure.type,
    });

    migrated.push({
      ...badCase,
      id,
      convertedEvalId: evalCase.id,
      origin: {
        evalCaseId: evalCase.id,
        source: 'retrieval_eval',
        firstSeenAt: badCase.createdAt,
        lastSeenAt: badCase.createdAt,
        observedRunIds: [],
        occurrenceCount: 1,
      },
    });
  }

  const deduped = new Map<string, BadCase>();
  for (const badCase of migrated) {
    const existing = deduped.get(badCase.id);
    if (!existing) {
      deduped.set(badCase.id, badCase);
      continue;
    }
    if (onDuplicate === 'throw') {
      throw new Error(
        `bad case migration produced duplicate id: ${badCase.id}`,
      );
    }
    deduped.set(badCase.id, mergeDuplicateBadCase(existing, badCase));
    warnings.push(`merged duplicate bad case: ${badCase.id}`);
  }

  return { cases: [...deduped.values()], warnings };
}

function hasHumanState(badCase: BadCase): boolean {
  return badCase.status !== 'new';
}

function earlierIso(a: string, b: string): string {
  return a <= b ? a : b;
}

function laterIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function mergeOrigins(primary: BadCaseOrigin, secondary: BadCaseOrigin): BadCaseOrigin {
  const observedRunIds = Array.from(
    new Set([...primary.observedRunIds, ...secondary.observedRunIds]),
  );
  return {
    ...primary,
    firstSeenAt: earlierIso(primary.firstSeenAt, secondary.firstSeenAt),
    lastSeenAt: laterIso(primary.lastSeenAt, secondary.lastSeenAt),
    firstSeenRunId: primary.firstSeenRunId ?? secondary.firstSeenRunId,
    lastSeenRunId: secondary.lastSeenRunId ?? primary.lastSeenRunId,
    observedRunIds,
    occurrenceCount: Math.max(
      primary.occurrenceCount,
      secondary.occurrenceCount,
      observedRunIds.length,
      1,
    ),
    scope: primary.scope ?? secondary.scope,
    models: {
      ...secondary.models,
      ...primary.models,
    },
  };
}

function mergeDuplicateBadCase(a: BadCase, b: BadCase): BadCase {
  const primary = hasHumanState(a) || !hasHumanState(b) ? a : b;
  const secondary = primary === a ? b : a;
  return {
    ...primary,
    createdAt: earlierIso(primary.createdAt, secondary.createdAt),
    origin:
      primary.origin && secondary.origin
        ? mergeOrigins(primary.origin, secondary.origin)
        : (primary.origin ?? secondary.origin),
    relatedBadCaseIds:
      primary.relatedBadCaseIds || secondary.relatedBadCaseIds
        ? Array.from(
            new Set([
              ...(primary.relatedBadCaseIds ?? []),
              ...(secondary.relatedBadCaseIds ?? []),
            ]),
          )
        : undefined,
  };
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
  writeFileSync(
    BAD_CASES_PATH,
    all.map((c) => JSON.stringify(c)).join('\n') + '\n',
  );
  return added.length;
}

/** 把一条 serving 检索未命中转成 BadCase(Stage 2 最小可填版本)。 */
export function retrievalMiss(params: {
  evalCaseId: string;
  question: string;
  resource: string;
  expectedChunkIds: string[];
  actualTopIds: string[];
  rankedIds: string[];
  k: number;
}): BadCase {
  const {
    evalCaseId,
    question,
    resource,
    expectedChunkIds,
    actualTopIds,
    rankedIds,
    k,
  } = params;
  if (!evalCaseId) throw new Error('retrievalMiss requires evalCaseId');
  const topHitCount = expectedChunkIds.filter((id) =>
    actualTopIds.includes(id),
  ).length;
  const ranks = expectedChunkIds.map((id) => {
    const index = rankedIds.indexOf(id);
    return { id, rank: index >= 0 ? index + 1 : 0 };
  });
  const missingFromCandidates = ranks.filter((r) => r.rank === 0);
  const outsideTopK = ranks.filter((r) => r.rank > k);
  // 只要有 expected chunk 没进候选,就表示 retrieval 阶段漏召回。
  const layer: BadCase['failure']['layer'] =
    missingFromCandidates.length > 0 ? 'retrieval' : 'rerank';
  const failureType: BadCase['failure']['type'] =
    layer === 'retrieval' ? 'retrieval_miss' : 'rerank_miss';
  const missingNote =
    missingFromCandidates.length > 0
      ? `未进候选: ${missingFromCandidates.map((r) => r.id).join(', ')}`
      : '';
  const rerankNote =
    outsideTopK.length > 0
      ? `候选中但排在 top-${k} 外: ${outsideTopK
          .map((r) => `${r.id}(rank=${r.rank})`)
          .join(', ')}`
      : '';
  const note = [
    `top-${k} 命中 ${topHitCount}/${expectedChunkIds.length}`,
    missingNote,
    rerankNote,
  ]
    .filter(Boolean)
    .join('; ');
  const createdAt = new Date().toISOString();

  return {
    id: canonicalBadCaseId({
      evalCaseId,
      layer,
      type: failureType,
    }),
    createdAt,
    taskType: 'explain_field',
    input: { question, context: { kind: resource } },
    expected: { sourceIds: expectedChunkIds },
    actual: { sourceIds: actualTopIds },
    failure: {
      layer,
      type: failureType,
      note,
    },
    severity: layer === 'retrieval' ? 'high' : 'medium',
    status: 'new',
    convertedEvalId: evalCaseId,
    origin: {
      evalCaseId,
      source: 'retrieval_eval',
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      observedRunIds: [],
      occurrenceCount: 1,
    },
  };
}

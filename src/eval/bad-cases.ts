// 失败用例沉淀为 canonical bad case: evalCaseId + failure.layer + failure.type。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FaithOutcome } from './faith-store';

export interface BadCaseTracking {
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
  tracking: BadCaseTracking;
  relatedBadCaseIds?: string[];
}

export const BAD_CASES_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'bad-cases.jsonl',
);

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

function hasHumanState(badCase: BadCase): boolean {
  return badCase.status !== 'new';
}

function earlierIso(a: string, b: string): string {
  return a <= b ? a : b;
}

function laterIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function mergeTracking(
  primary: BadCaseTracking,
  secondary: BadCaseTracking,
): BadCaseTracking {
  const primaryRunIds = new Set(primary.observedRunIds);
  const newRunIds = secondary.observedRunIds.filter(
    (runId) => !primaryRunIds.has(runId),
  );
  const observedRunIds = Array.from(
    new Set([...primary.observedRunIds, ...secondary.observedRunIds]),
  );
  const occurrenceCount = Math.max(
    primary.occurrenceCount + newRunIds.length,
    observedRunIds.length,
  );
  const firstSeenRunId =
    primary.firstSeenAt <= secondary.firstSeenAt
      ? primary.firstSeenRunId
      : secondary.firstSeenRunId;
  const lastSeenRunId =
    secondary.lastSeenAt >= primary.lastSeenAt
      ? (secondary.lastSeenRunId ?? primary.lastSeenRunId)
      : (primary.lastSeenRunId ?? secondary.lastSeenRunId);
  return {
    ...primary,
    firstSeenAt: earlierIso(primary.firstSeenAt, secondary.firstSeenAt),
    lastSeenAt: laterIso(primary.lastSeenAt, secondary.lastSeenAt),
    firstSeenRunId,
    lastSeenRunId,
    observedRunIds,
    occurrenceCount,
    scope: primary.scope ?? secondary.scope,
    models: {
      ...secondary.models,
      ...primary.models,
    },
  };
}

export function mergeCanonicalObservations(a: BadCase, b: BadCase): BadCase {
  if (a.id !== b.id) {
    throw new Error(`cannot merge different bad cases: ${a.id} !== ${b.id}`);
  }
  const primary = hasHumanState(a) || !hasHumanState(b) ? a : b;
  const secondary = primary === a ? b : a;
  return {
    ...primary,
    createdAt: earlierIso(primary.createdAt, secondary.createdAt),
    actual: secondary.actual,
    tracking: mergeTracking(primary.tracking, secondary.tracking),
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

export function assertCanonicalBadCase(badCase: BadCase): void {
  const tracking = (badCase as Partial<BadCase>).tracking;
  if (!tracking || !tracking.evalCaseId) {
    throw new Error(`bad case ${badCase.id} missing tracking.evalCaseId`);
  }
  const expectedId = canonicalBadCaseId({
    evalCaseId: tracking.evalCaseId,
    layer: badCase.failure.layer,
    type: badCase.failure.type,
  });
  if (badCase.id !== expectedId) {
    throw new Error(
      `bad case ${badCase.id} id mismatch, expected canonical id ${expectedId}`,
    );
  }
}

export function normalizeCanonicalBadCases(cases: BadCase[]): BadCase[] {
  const byId = new Map<string, BadCase>();
  for (const badCase of cases) {
    assertCanonicalBadCase(badCase);
    const existing = byId.get(badCase.id);
    byId.set(
      badCase.id,
      existing ? mergeCanonicalObservations(existing, badCase) : badCase,
    );
  }
  return [...byId.values()];
}

export function readBadCases(): BadCase[] {
  if (!existsSync(BAD_CASES_PATH)) return [];
  const cases = readFileSync(BAD_CASES_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BadCase);
  return normalizeCanonicalBadCases(cases);
}

export function writeBadCases(cases: BadCase[]): void {
  const merged = normalizeCanonicalBadCases(cases);
  mkdirSync(dirname(BAD_CASES_PATH), { recursive: true });
  writeFileSync(
    BAD_CASES_PATH,
    merged.map((c) => JSON.stringify(c)).join('\n') + '\n',
  );
}

/** 合并新捕获的失败用例,保留人工状态并更新最新观测。 */
export function upsertBadCases(incoming: BadCase[]): number {
  const existing = readBadCases();
  const seen = new Set(existing.map((c) => c.id));
  writeBadCases([...existing, ...incoming]);
  return incoming.filter((c) => !seen.has(c.id)).length;
}

/** 把一条检索评估未命中转成 canonical bad case。 */
export function retrievalMiss(params: {
  evalCaseId: string;
  runId: string;
  question: string;
  resource: string;
  expectedChunkIds: string[];
  actualTopIds: string[];
  rankedIds: string[];
  k: number;
}): BadCase {
  const {
    evalCaseId,
    runId,
    question,
    resource,
    expectedChunkIds,
    actualTopIds,
    rankedIds,
    k,
  } = params;
  if (!evalCaseId) throw new Error('retrievalMiss requires evalCaseId');
  if (!runId) throw new Error('retrievalMiss requires runId');
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
    actual: { sourceIds: actualTopIds, traceId: `${runId}:${evalCaseId}` },
    failure: {
      layer,
      type: failureType,
      note,
    },
    severity: layer === 'retrieval' ? 'high' : 'medium',
    status: 'new',
    tracking: {
      evalCaseId,
      source: 'retrieval_eval',
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      observedRunIds: [runId],
      occurrenceCount: 1,
    },
  };
}

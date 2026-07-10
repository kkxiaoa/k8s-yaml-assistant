import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalBadCaseId,
  normalizeCanonicalBadCases,
  type BadCase,
  type BadCaseOrigin,
} from './bad-cases';
import { EVAL_SET, type EvalCase } from './eval-set';
import { FAITH_DIR, type FaithOutcome, type FaithTrace } from './faith-store';
import {
  computeEvalSetHash,
  RUNS_DIR,
  runKind,
  type EvalRun,
} from './run-store';

export type FaithBadCaseAction =
  | 'create'
  | 'recur'
  | 'already_imported'
  | 'link_only'
  | 'resolved_in_run'
  | 'skip'
  | 'warning'
  | 'error';

export interface FaithBadCaseCandidate {
  action: FaithBadCaseAction;
  evalCaseId: string;
  issueId?: string;
  issue?: BadCase;
  relatedBadCaseIds?: string[];
  message?: string;
  unsupportedClaims?: string[];
}

const ACTIONS: FaithBadCaseAction[] = [
  'create',
  'recur',
  'already_imported',
  'link_only',
  'resolved_in_run',
  'skip',
  'warning',
  'error',
];

type FaithScope = 'full' | 'policy' | 'smoke';

interface FaithFailure {
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
  severity: BadCase['severity'];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function equalSorted(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function inferScope(run: EvalRun): FaithScope {
  if (run.faithSelection?.scope) return run.faithSelection.scope;
  if (run.id.endsWith('-policy')) return 'policy';
  if (run.id.endsWith('-smoke')) return 'smoke';
  return 'full';
}

export function readFaithBadCaseInput(params: {
  runId: string;
  runsDir?: string;
  faithDir?: string;
  evalSet?: EvalCase[];
}): {
  run: EvalRun;
  traces: FaithTrace[];
  scope: FaithScope;
  warnings: string[];
} {
  const {
    runId,
    runsDir = RUNS_DIR,
    faithDir = FAITH_DIR,
    evalSet = EVAL_SET,
  } = params;
  const runPath = join(runsDir, `${runId}.json`);
  const tracePath = join(faithDir, `${runId}.jsonl`);

  if (!existsSync(runPath)) {
    throw new Error(`run file not found: ${runPath}`);
  }
  if (!existsSync(tracePath)) {
    throw new Error(`faith trace file not found: ${tracePath}`);
  }

  const run = readJson<EvalRun>(runPath);
  const traces = readJsonl<FaithTrace>(tracePath);

  if (run.id !== runId) {
    throw new Error(`run id mismatch: expected ${runId}, got ${run.id}`);
  }
  if (runKind(run) !== 'faith') {
    throw new Error(`expected faith run, got ${runKind(run)}`);
  }

  const seenTraceIds = new Set<string>();
  for (const trace of traces) {
    if (seenTraceIds.has(trace.id)) {
      throw new Error(`duplicate trace id: ${trace.id}`);
    }
    seenTraceIds.add(trace.id);
  }

  const evalById = new Map(evalSet.map((ec) => [ec.id, ec]));
  const alignedCases: EvalCase[] = [];
  for (const trace of traces) {
    const evalCase = evalById.get(trace.id);
    if (!evalCase) {
      throw new Error(`trace case ${trace.id} not found in EVAL_SET`);
    }
    if (
      trace.question !== evalCase.question ||
      !equalSorted(trace.retrieval.expectedChunkIds, evalCase.expectedChunkIds)
    ) {
      throw new Error(`trace case drift: ${trace.id}`);
    }
    alignedCases.push(evalCase);
  }

  const selectionHash = computeEvalSetHash(alignedCases);
  if (run.evalSetHash !== selectionHash) {
    throw new Error(
      `evalSetHash mismatch: run=${run.evalSetHash ?? '<missing>'} trace=${selectionHash}`,
    );
  }

  const warnings: string[] = [];
  const fullHash = computeEvalSetHash(evalSet);
  if (run.evalSetVersionHash) {
    if (run.evalSetVersionHash !== fullHash) {
      throw new Error(
        `evalSetVersionHash mismatch: run=${run.evalSetVersionHash} current=${fullHash}`,
      );
    }
  } else {
    warnings.push('legacy run missing evalSetVersionHash');
  }

  return {
    run,
    traces,
    scope: inferScope(run),
    warnings,
  };
}

function failureForOutcome(outcome: FaithOutcome): FaithFailure | null {
  switch (outcome) {
    case 'hallucination':
    case 'dual_cause':
      return { layer: 'generation', type: 'hallucination', severity: 'high' };
    case 'refused_wrong':
      return { layer: 'generation', type: 'refusal_error', severity: 'high' };
    case 'judge_failed':
      return { layer: 'judge', type: 'judge_error', severity: 'medium' };
    default:
      return null;
  }
}

function sameEvalCase(issue: BadCase, evalCaseId: string): boolean {
  return issue.origin.evalCaseId === evalCaseId;
}

function retrievalQualityIssues(
  existingBadCases: BadCase[],
  evalCaseId: string,
): BadCase[] {
  return existingBadCases.filter(
    (issue) =>
      sameEvalCase(issue, evalCaseId) &&
      (issue.failure.type === 'retrieval_miss' ||
        issue.failure.type === 'rerank_miss') &&
      (issue.failure.layer === 'retrieval' || issue.failure.layer === 'rerank'),
  );
}

function faithIssues(
  existingBadCases: BadCase[],
  evalCaseId: string,
): BadCase[] {
  return existingBadCases.filter(
    (issue) =>
      sameEvalCase(issue, evalCaseId) && issue.origin.source === 'faith_eval',
  );
}

function issueIdFor(evalCaseId: string, failure: FaithFailure): string {
  return canonicalBadCaseId({
    evalCaseId,
    layer: failure.layer,
    type: failure.type,
  });
}

function nextObservedRunIds(origin: BadCaseOrigin, runId: string): string[] {
  return origin.observedRunIds.includes(runId)
    ? origin.observedRunIds
    : [...origin.observedRunIds, runId];
}

function modelsFromRun(run: EvalRun): BadCaseOrigin['models'] {
  const withJudge = run as EvalRun & { judgeModel?: string };
  return {
    embedding: run.embeddingModel,
    rerank: run.rerankModel,
    answer: run.answerModel,
    judge: withJudge.judgeModel,
  };
}

function issueFromTrace(params: {
  trace: FaithTrace;
  run: EvalRun;
  scope: FaithScope;
  now: string;
  failure: FaithFailure;
  existing?: BadCase;
  relatedBadCaseIds?: string[];
}): BadCase {
  const {
    trace,
    run,
    scope,
    now,
    failure,
    existing,
    relatedBadCaseIds = [],
  } = params;
  const issueId = issueIdFor(trace.id, failure);
  const unsupportedClaims = trace.verdict?.unsupported ?? [];
  const baseOrigin: BadCaseOrigin =
    existing?.origin ??
    ({
      evalCaseId: trace.id,
      source: 'faith_eval',
      firstSeenAt: now,
      lastSeenAt: now,
      observedRunIds: [],
      occurrenceCount: 0,
    } satisfies BadCaseOrigin);
  const observedRunIds = nextObservedRunIds(baseOrigin, run.id);

  return {
    id: issueId,
    createdAt: existing?.createdAt ?? now,
    taskType: existing?.taskType ?? 'ask_free',
    input: existing?.input ?? { question: trace.question },
    expected: existing?.expected ?? {
      sourceIds: trace.retrieval.expectedChunkIds,
    },
    actual: {
      ...existing?.actual,
      answer: trace.answer,
      sourceIds: trace.retrieval.topIds,
      traceId: `${run.id}:${trace.id}`,
      evaluation: {
        runId: run.id,
        scope,
        outcome: trace.outcome,
        unsupportedClaims,
        ...(trace.verdict?.reason ? { judgeReason: trace.verdict.reason } : {}),
      },
    },
    failure: {
      layer: failure.layer,
      type: failure.type,
      note: existing?.failure.note ?? trace.verdict?.reason,
    },
    severity: existing?.severity ?? failure.severity,
    status: existing?.status ?? 'new',
    origin: {
      ...baseOrigin,
      evalCaseId: trace.id,
      source: 'faith_eval',
      lastSeenAt: now,
      lastSeenRunId: run.id,
      observedRunIds,
      occurrenceCount: baseOrigin.observedRunIds.includes(run.id)
        ? baseOrigin.occurrenceCount
        : baseOrigin.occurrenceCount + 1,
      scope,
      models: modelsFromRun(run),
    },
    relatedBadCaseIds:
      relatedBadCaseIds.length > 0
        ? Array.from(
            new Set([
              ...(existing?.relatedBadCaseIds ?? []),
              ...relatedBadCaseIds,
            ]),
          )
        : existing?.relatedBadCaseIds,
  };
}

function issueCandidate(params: {
  trace: FaithTrace;
  existingBadCases: BadCase[];
  run: EvalRun;
  scope: FaithScope;
  now: string;
  failure: FaithFailure;
  relatedBadCaseIds?: string[];
}): FaithBadCaseCandidate {
  const {
    trace,
    existingBadCases,
    run,
    scope,
    now,
    failure,
    relatedBadCaseIds,
  } = params;
  const issueId = issueIdFor(trace.id, failure);
  const existing = existingBadCases.find((issue) => issue.id === issueId);

  if (existing?.origin.observedRunIds.includes(run.id)) {
    return {
      action: 'already_imported',
      evalCaseId: trace.id,
      issueId,
      issue: existing,
      unsupportedClaims: trace.verdict?.unsupported ?? [],
    };
  }

  return {
    action: existing ? 'recur' : 'create',
    evalCaseId: trace.id,
    issueId,
    issue: issueFromTrace({
      trace,
      run,
      scope,
      now,
      failure,
      existing,
      relatedBadCaseIds,
    }),
    relatedBadCaseIds,
    unsupportedClaims: trace.verdict?.unsupported ?? [],
  };
}

function warningCandidate(
  trace: FaithTrace,
  message: string,
): FaithBadCaseCandidate {
  return {
    action: 'warning',
    evalCaseId: trace.id,
    message,
  };
}

export function buildFaithBadCaseCandidates(params: {
  traces: FaithTrace[];
  existingBadCases: BadCase[];
  run: EvalRun;
  scope: FaithScope;
  now?: string;
}): FaithBadCaseCandidate[] {
  const {
    traces,
    existingBadCases,
    run,
    scope,
    now = new Date().toISOString(),
  } = params;
  const candidates: FaithBadCaseCandidate[] = [];

  for (const trace of traces) {
    if (trace.outcome === 'error') {
      candidates.push({
        action: 'error',
        evalCaseId: trace.id,
        message: 'runtime error during faith eval',
      });
      continue;
    }

    if (trace.outcome === 'faithful_miss') {
      const related = retrievalQualityIssues(existingBadCases, trace.id);
      if (related.length > 0) {
        candidates.push({
          action: 'link_only',
          evalCaseId: trace.id,
          issueId: related[0]!.id,
          issue: related[0],
          relatedBadCaseIds: related.map((issue) => issue.id),
        });
      } else {
        candidates.push(
          warningCandidate(trace, 'missing_retrieval_issue for faithful_miss'),
        );
      }
      continue;
    }

    const failure = failureForOutcome(trace.outcome);
    if (!failure) {
      const existingFaithIssues = faithIssues(existingBadCases, trace.id);
      candidates.push(
        existingFaithIssues.length > 0
          ? {
              action: 'resolved_in_run',
              evalCaseId: trace.id,
              issueId: existingFaithIssues[0]!.id,
            }
          : {
              action: 'skip',
              evalCaseId: trace.id,
              message: trace.outcome,
            },
      );
      continue;
    }

    const related =
      trace.outcome === 'dual_cause'
        ? retrievalQualityIssues(existingBadCases, trace.id)
        : [];

    candidates.push(
      issueCandidate({
        trace,
        existingBadCases,
        run,
        scope,
        now,
        failure,
        relatedBadCaseIds: related.map((issue) => issue.id),
      }),
    );

    if (trace.outcome === 'dual_cause' && related.length === 0) {
      candidates.push(
        warningCandidate(trace, 'missing_retrieval_issue for dual_cause'),
      );
    }
  }

  return candidates;
}

function emptySummary(): Record<FaithBadCaseAction, number> {
  return Object.fromEntries(ACTIONS.map((action) => [action, 0])) as Record<
    FaithBadCaseAction,
    number
  >;
}

export function mergeBadCaseIssues(params: {
  existing: BadCase[];
  candidates: FaithBadCaseCandidate[];
}): {
  cases: BadCase[];
  summary: Record<FaithBadCaseAction, number>;
  warnings: string[];
} {
  const { existing, candidates } = params;
  const byId = new Map(
    normalizeCanonicalBadCases(existing).map((badCase) => [
      badCase.id,
      badCase,
    ]),
  );
  const summary = emptySummary();

  for (const candidate of candidates) {
    summary[candidate.action]++;
    if (candidate.action !== 'create' && candidate.action !== 'recur') {
      continue;
    }
    if (!candidate.issue) {
      throw new Error(
        `candidate ${candidate.action} missing issue: ${candidate.evalCaseId}`,
      );
    }
    byId.set(candidate.issue.id, candidate.issue);
  }

  return {
    cases: [...byId.values()],
    summary,
    warnings: [],
  };
}

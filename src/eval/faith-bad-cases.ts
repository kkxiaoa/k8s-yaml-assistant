import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalBadCaseId,
  decodeBadCase,
  normalizeCanonicalBadCases,
  type BadCase,
  type BadCaseEvidenceReference,
  type BadCaseTracking,
} from './bad-cases';
import {
  assessFaith,
  decodeFaithTrace,
  type FaithTrace,
} from './faith-store';
import {
  evalArtifactPath,
  readTraceEnvelopes,
  runPath,
} from './artifacts';
import { faithTraceDatasetIdentity } from './runner-protocol';
import { readRun } from './run-store';
import { type EvalRun } from './protocol';

type FaithEvalRun = Extract<EvalRun, { kind: 'faith' }>;

export interface FaithTraceObservation {
  trace: FaithTrace;
  latestEvidence: BadCaseEvidenceReference;
}

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

type FaithScope = 'tuning' | 'holdout' | 'full' | 'policy' | 'smoke';

interface FaithFailure {
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
  severity: BadCase['severity'];
  note?: string;
}

function equalSorted(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function faithScope(run: FaithEvalRun): FaithScope {
  if (
    run.scope === 'tuning' ||
    run.scope === 'holdout' ||
    run.scope === 'full' ||
    run.scope === 'policy' ||
    run.scope === 'smoke'
  ) {
    return run.scope;
  }
  throw new Error(`unsupported faith scope: ${run.scope}`);
}

export function readFaithBadCaseInput(params: {
  runId: string;
  evalRoot?: string;
}): {
  run: FaithEvalRun;
  observations: FaithTraceObservation[];
  scope: FaithScope;
  warnings: string[];
} {
  const { runId, evalRoot } = params;
  const runFilePath = runPath(runId, evalRoot);

  if (!existsSync(runFilePath)) {
    throw new Error(`run file not found: ${runFilePath}`);
  }

  const decodedRun = readRun(runId, { evalRoot });
  if (decodedRun.kind !== 'faith') {
    throw new Error(`expected faith run, got ${decodedRun.kind}`);
  }
  const run = decodedRun;
  if (run.status !== 'completed') {
    throw new Error(`faith run ${run.id} is ${run.status}, expected completed`);
  }
  const tracePath = evalArtifactPath(run.artifactPaths.trace, evalRoot);
  if (!existsSync(tracePath)) {
    throw new Error(`faith trace file not found: ${tracePath}`);
  }
  const envelopes = readTraceEnvelopes(tracePath);
  const observations: FaithTraceObservation[] = [];

  const seenCaseIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.runId !== run.id || envelope.kind !== 'faith') {
      throw new Error(`faith trace envelope mismatch: ${envelope.traceId}`);
    }
    if (seenCaseIds.has(envelope.evalCaseId)) {
      throw new Error(`duplicate trace case id: ${envelope.evalCaseId}`);
    }
    const trace = decodeFaithTrace(envelope.payload);
    if (trace.id !== envelope.evalCaseId) {
      throw new Error(
        `faith payload id mismatch: envelope=${envelope.evalCaseId} payload=${trace.id}`,
      );
    }
    if (!isDeepStrictEqual(trace.governance, envelope.governance)) {
      throw new Error(
        `faith governance mismatch: envelope=${envelope.evalCaseId}`,
      );
    }
    seenCaseIds.add(envelope.evalCaseId);
    observations.push({
      trace,
      latestEvidence: { runId: run.id, traceId: envelope.traceId },
    });
  }

  if (
    !equalSorted(
      [...seenCaseIds],
      run.dataset.cases.map((evalCase) => evalCase.id),
    )
  ) {
    throw new Error('faith trace cases do not match run dataset');
  }

  const selectionIdentity = faithTraceDatasetIdentity(
    observations.map(({ trace }) => trace),
  );
  if (
    run.dataset.hash !== selectionIdentity.hash ||
    !isDeepStrictEqual(run.dataset.cases, selectionIdentity.cases)
  ) {
    throw new Error(
      `dataset identity mismatch: run=${run.dataset.hash} trace=${selectionIdentity.hash}`,
    );
  }

  return {
    run,
    observations,
    scope: faithScope(run),
    warnings: [],
  };
}

function sameEvalCase(issue: BadCase, evalCaseId: string): boolean {
  return issue.tracking.evalCaseId === evalCaseId;
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
      sameEvalCase(issue, evalCaseId) && issue.tracking.source === 'faith_eval',
  );
}

function issueIdFor(evalCaseId: string, failure: FaithFailure): string {
  return canonicalBadCaseId({
    evalCaseId,
    layer: failure.layer,
    type: failure.type,
  });
}

function nextObservedRunIds(tracking: BadCaseTracking, runId: string): string[] {
  return tracking.observedRunIds.includes(runId)
    ? tracking.observedRunIds
    : [...tracking.observedRunIds, runId];
}

function modelsFromRun(run: FaithEvalRun): BadCaseTracking['models'] {
  return {
    embedding: run.config.embeddingModel,
    rerank: run.config.rerankModel,
    answer: run.config.answerModel,
    judge: run.config.judgeModel,
  };
}

function issueFromTrace(params: {
  trace: FaithTrace;
  run: FaithEvalRun;
  scope: FaithScope;
  now: string;
  failure: FaithFailure;
  latestEvidence: BadCaseEvidenceReference;
  existing?: BadCase;
  relatedBadCaseIds?: string[];
}): BadCase {
  const {
    trace,
    run,
    scope,
    now,
    failure,
    latestEvidence,
    existing,
    relatedBadCaseIds = [],
  } = params;
  const issueId = issueIdFor(trace.id, failure);
  const unsupportedClaims = trace.verdict?.unsupported ?? [];
  const baseTracking: BadCaseTracking =
    existing?.tracking ??
    ({
      evalCaseId: trace.id,
      source: 'faith_eval',
      firstSeenAt: now,
      lastSeenAt: now,
      observedRunIds: [],
      occurrenceCount: 0,
    } satisfies BadCaseTracking);
  const observedRunIds = nextObservedRunIds(baseTracking, run.id);

  return decodeBadCase({
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
      note: existing?.failure.note ?? failure.note ?? trace.verdict?.reason,
    },
    severity: existing?.severity ?? failure.severity,
    status: existing?.status ?? 'new',
    tracking: {
      ...baseTracking,
      evalCaseId: trace.id,
      source: 'faith_eval',
      lastSeenAt: now,
      lastSeenRunId: run.id,
      observedRunIds,
      occurrenceCount: baseTracking.observedRunIds.includes(run.id)
        ? baseTracking.occurrenceCount
        : baseTracking.occurrenceCount + 1,
      scope,
      models: modelsFromRun(run),
    },
    latestEvidence,
    relatedBadCaseIds:
      relatedBadCaseIds.length > 0
        ? Array.from(
            new Set([
              ...(existing?.relatedBadCaseIds ?? []),
              ...relatedBadCaseIds,
            ]),
          )
        : existing?.relatedBadCaseIds,
  });
}

function issueCandidate(params: {
  trace: FaithTrace;
  existingBadCases: BadCase[];
  run: FaithEvalRun;
  scope: FaithScope;
  now: string;
  failure: FaithFailure;
  latestEvidence: BadCaseEvidenceReference;
  relatedBadCaseIds?: string[];
}): FaithBadCaseCandidate {
  const {
    trace,
    existingBadCases,
    run,
    scope,
    now,
    failure,
    latestEvidence,
    relatedBadCaseIds,
  } = params;
  const issueId = issueIdFor(trace.id, failure);
  const existing = existingBadCases.find((issue) => issue.id === issueId);

  if (existing?.tracking.observedRunIds.includes(run.id)) {
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
      latestEvidence,
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
  observations: FaithTraceObservation[];
  existingBadCases: BadCase[];
  run: FaithEvalRun;
  scope: FaithScope;
  now?: string;
}): FaithBadCaseCandidate[] {
  const {
    observations,
    existingBadCases,
    run,
    scope,
    now = new Date().toISOString(),
  } = params;
  const candidates: FaithBadCaseCandidate[] = [];
  if (scope === 'holdout') return candidates;

  for (const { trace, latestEvidence } of observations) {
    if (latestEvidence.runId !== run.id) {
      throw new Error(
        `faith evidence run ${latestEvidence.runId} does not match ${run.id}`,
      );
    }
    if (trace.governance.role === 'holdout') continue;
    if (trace.outcome === 'error') {
      candidates.push({
        action: 'error',
        evalCaseId: trace.id,
        message: 'runtime error during faith eval',
      });
      continue;
    }

    if (trace.outcome === 'failed') {
      const assessment = assessFaith(trace);
      if (trace.verdict?.faithful === false) {
        candidates.push(
          issueCandidate({
            trace,
            existingBadCases,
            run,
            scope,
            now,
            failure: {
              layer: 'generation',
              type: 'unsupported_claim',
              severity: 'high',
            },
            latestEvidence,
          }),
        );
      }
      if (assessment.expectedBehaviorSatisfied === false) {
        candidates.push(
          issueCandidate({
            trace,
            existingBadCases,
            run,
            scope,
            now,
            failure: {
              layer: 'generation',
              type: 'behavior_mismatch',
              severity: 'high',
              note: `expected ${trace.expectedBehavior}; observed ${assessment.responseBehavior}`,
            },
            latestEvidence,
          }),
        );
      }

      const related = retrievalQualityIssues(existingBadCases, trace.id);
      if (!assessment.retrievalSatisfied) {
        candidates.push(
          related.length > 0
            ? {
                action: 'link_only',
                evalCaseId: trace.id,
                issueId: related[0]!.id,
                issue: related[0],
                relatedBadCaseIds: related.map((issue) => issue.id),
              }
            : warningCandidate(
                trace,
                'missing_retrieval_issue for retrieval_incomplete',
              ),
        );
      }
      if (!assessment.sourceCoverageSatisfied) {
        candidates.push(
          warningCandidate(trace, 'source expectation is incomplete'),
        );
      }
      continue;
    }

    if (trace.outcome === 'judge_failed') {
      candidates.push(
        issueCandidate({
          trace,
          existingBadCases,
          run,
          scope,
          now,
          failure: {
            layer: 'judge',
            type: 'judge_error',
            severity: 'medium',
          },
          latestEvidence,
        }),
      );
      continue;
    }

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

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTraceEnvelope,
  evalArtifactPath,
  runPath,
  traceRelativePath,
  writeJsonAtomic,
} from './artifacts';
import {
  buildFaithBadCaseCandidates,
  mergeBadCaseIssues,
  readFaithBadCaseInput,
  type FaithBadCaseCandidate,
  type FaithTraceObservation,
} from './faith-bad-cases';
import {
  canonicalBadCaseId,
  type BadCase,
  type BadCaseTracking,
} from './bad-cases';
import {
  resolveGroundedAnswerCase,
  type GroundedAnswerCase,
} from './cases/grounded-answer-cases';
import type { SemanticRetrievalCase } from './cases/retrieval-cases';
import {
  assessFaith,
  currentFaithOutcome,
  decodeFaithTrace,
  type FaithOutcome,
  type FaithTrace,
} from './faith-store';
import {
  EVAL_SCHEMA_VERSION,
  type EvalRun,
} from './protocol';
import {
  faithDatasetIdentity,
  faithEnvelopeOutcome,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
} from './run-session';

type FaithEvalRun = Extract<EvalRun, { kind: 'faith' }>;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function contextChunk(id: string) {
  return {
    id,
    title: `title ${id}`,
    text: `text ${id}`,
    sourceType: 'schema' as const,
    provenance: { authority: 'cluster_api' as const, version: 'v1' },
    targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.field' }],
  };
}

function contextSnapshot(id: string) {
  const chunk = contextChunk(id);
  return {
    text: `[S1][schema] ${chunk.title}\n${chunk.text}`,
    chunks: [chunk],
    sources: [
      {
        n: 1,
        id: chunk.id,
        title: chunk.title,
        sourceType: chunk.sourceType,
        provenance: chunk.provenance,
        targets: chunk.targets,
      },
    ],
  };
}

function searchTrace(question: string, chunkId: string) {
  const chunk = contextChunk(chunkId);
  const hit = {
    id: chunk.id,
    title: chunk.title,
    sourceType: chunk.sourceType,
    provenance: chunk.provenance,
    targets: chunk.targets,
    score: 0.9,
  };
  return {
    question,
    mode: 'free' as const,
    queryText: question,
    queryExpansion: {
      enabled: false,
      status: 'disabled' as const,
      originalQueryText: question,
      expandedQueryText: question,
      matchedAliases: [],
      expansionTerms: [],
    },
    path: 'search' as const,
    coarseHits: [hit],
    rerankHits: [hit],
    finalHits: [hit],
    latencyMs: { total: 1 },
    cache: { index: { status: 'hit' as const }, embeddingHit: false },
    createdAt: '2026-07-12T00:00:00.000Z',
  };
}

const QUERY_EXPANSION_CONFIG = {
  enabled: false,
  registryHash: null,
  reviewedAliasCount: 0,
};

const MINI_RETRIEVAL_CASES: SemanticRetrievalCase[] = [
  {
    id: 'case-a',
    governance: {
      task: 'field_explanation',
      origin: 'human',
      role: 'development',
    },
    question: '问题 A',
    expectedChunkIds: ['Chunk::a'],
    target: { kind: 'Pod' },
  },
  {
    id: 'case-b',
    governance: {
      task: 'field_explanation',
      origin: 'human',
      role: 'development',
    },
    question: '问题 B',
    expectedChunkIds: ['Chunk::b'],
    target: { kind: 'Deployment' },
  },
];

const MINI_GROUNDED_CASES: GroundedAnswerCase[] = MINI_RETRIEVAL_CASES.map(
  (evalCase) => ({
    id: evalCase.id,
    input: { kind: 'retrieval_case', retrievalCaseId: evalCase.id },
    expectedBehavior: 'answer_with_sources',
  }),
);

function faithRun(params: {
  id: string;
  cases: GroundedAnswerCase[];
  scope?: FaithEvalRun['scope'];
}): FaithEvalRun {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: params.id,
    kind: 'faith',
    status: 'completed',
    scope: params.scope ?? 'full',
    createdAt: '2026-07-10T00:00:00.000Z',
    completedAt: '2026-07-10T00:01:00.000Z',
    dataset: faithDatasetIdentity(params.cases, MINI_RETRIEVAL_CASES),
    artifactPaths: { trace: traceRelativePath(params.id, 'faith') },
    metricDefinitionVersion: 'legacy-v1',
    config: {
      corpusManifestHash: HASH_B,
      indexHash: HASH_B,
      embeddingModel: 'voyage-3',
      rerankModel: 'rerank-2.5',
      queryExpansion: {
        enabled: false,
        registryHash: null,
        reviewedAliasCount: 0,
      },
      k: 3,
      answerModel: 'claude-sonnet-4-6',
      judgeModel: 'claude-opus-4-8',
      answerPromptHash: HASH_A,
      judgePromptHash: HASH_B,
      judgeParserSchemaIdentity: 'judge-vote-parser-v2',
      judgeAttemptLimit: 2,
    },
    metrics: {},
  };
}

const RUN = faithRun({
  id: 'faith-run-1',
  cases: [MINI_GROUNDED_CASES[0]!],
});

function verdict(
  faithful: boolean,
  responseBehavior: 'answer' | 'refusal' | 'non_answer' = 'answer',
) {
  return {
    faithful,
    responseBehavior,
    unsupported: faithful ? [] : ['unsupported claim'],
    reason: faithful ? 'faithful' : 'unsupported',
  };
}

function inputTrace(id: 'case-a' | 'case-b'): FaithTrace {
  const evalCase = MINI_GROUNDED_CASES.find((item) => item.id === id)!;
  const resolved = resolveGroundedAnswerCase(evalCase, MINI_RETRIEVAL_CASES);
  return {
    id: evalCase.id,
    governance: resolved.governance,
    input: evalCase.input,
    question: resolved.question,
    expectedBehavior: evalCase.expectedBehavior,
    target: resolved.target,
    context: contextSnapshot(resolved.expectedChunkIds[0]!),
    retrieval: {
      expectedChunkIds: resolved.expectedChunkIds,
      topIds: resolved.expectedChunkIds,
      foundCount: resolved.expectedChunkIds.length,
      fullRecall: true,
      queryExpansionConfig: QUERY_EXPANSION_CONFIG,
      searchTrace: searchTrace(
        resolved.question,
        resolved.expectedChunkIds[0]!,
      ),
    },
    answer: 'answer',
    judgeAttempts: [{ status: 'valid', vote: verdict(true, 'answer') }],
    verdict: verdict(true, 'answer'),
    outcome: 'passed',
  };
}

function withEvalRoot(fn: (evalRoot: string) => void): void {
  const evalRoot = mkdtempSync(join(tmpdir(), 'faith-bad-cases-'));
  try {
    fn(evalRoot);
  } finally {
    rmSync(evalRoot, { recursive: true, force: true });
  }
}

function writeInput(params: {
  evalRoot: string;
  runId: string;
  traces: FaithTrace[];
  scope?: FaithEvalRun['scope'];
}): { run: FaithEvalRun; traceIds: Map<string, string> } {
  const selectedCases = params.traces.map((trace) =>
    MINI_GROUNDED_CASES.find((evalCase) => evalCase.id === trace.id),
  );
  if (selectedCases.some((evalCase) => evalCase === undefined)) {
    throw new Error('test trace has no matching eval case');
  }
  const run = faithRun({
    id: params.runId,
    cases: selectedCases as GroundedAnswerCase[],
    scope: params.scope,
  });
  writeJsonAtomic(runPath(run.id, params.evalRoot), run);

  const tracePath = evalArtifactPath(run.artifactPaths.trace, params.evalRoot);
  const traceIds = new Map<string, string>();
  for (const trace of params.traces) {
    const envelope =
      trace.outcome === 'error'
        ? createErrorTraceEnvelope({
            runId: run.id,
            evalCaseId: trace.id,
            governance: trace.governance,
            kind: 'faith',
            payload: trace,
            stage: 'answer_model',
            error: new Error('case failed'),
          })
        : createTraceEnvelope({
            runId: run.id,
            evalCaseId: trace.id,
            governance: trace.governance,
            kind: 'faith',
            outcome: faithEnvelopeOutcome(trace),
            payload: trace,
          });
    appendTraceEnvelope(tracePath, envelope);
    traceIds.set(trace.id, envelope.traceId);
  }
  return { run, traceIds };
}

function trace(
  outcome: FaithOutcome,
  overrides: Partial<FaithTrace> = {},
): FaithTrace {
  const expectedBehavior =
    overrides.expectedBehavior ?? 'answer_with_sources';
  const isRefusal = expectedBehavior === 'refuse_insufficient_context';
  const governance = isRefusal
    ? {
        task: 'refusal' as const,
        origin: 'human' as const,
        role: 'development' as const,
      }
    : MINI_RETRIEVAL_CASES[0]!.governance;
  const judgedVerdict =
    outcome === 'judge_failed' || outcome === 'error'
      ? null
      : verdict(
          outcome === 'passed',
          isRefusal ? 'refusal' : 'answer',
        );
  const expectedChunkIds = isRefusal
    ? []
    : ['schema::v1::Pod::spec.containers.name'];
  return {
    id: 'case-1',
    input: isRefusal
      ? { kind: 'standalone_question', question: '这个字段怎么用?' }
      : { kind: 'retrieval_case', retrievalCaseId: 'case-1' },
    question: '这个字段怎么用?',
    expectedBehavior,
    ...(isRefusal ? {} : { target: { kind: 'Pod' } }),
    context: contextSnapshot('schema::v1::Pod::spec.containers.name'),
    retrieval: {
      expectedChunkIds,
      topIds: ['schema::v1::Pod::spec.containers.name'],
      foundCount: expectedChunkIds.length,
      fullRecall: expectedChunkIds.length > 0,
      queryExpansionConfig: QUERY_EXPANSION_CONFIG,
      searchTrace: searchTrace(
        '这个字段怎么用?',
        'schema::v1::Pod::spec.containers.name',
      ),
    },
    answer: 'answer',
    judgeAttempts:
      judgedVerdict !== null
        ? [{ status: 'valid', vote: judgedVerdict }]
        : outcome === 'judge_failed'
          ? [
              {
                status: 'error',
                stage: 'judge_request',
                message: 'judge request failed',
              },
            ]
          : [],
    verdict: judgedVerdict,
    outcome,
    ...(outcome === 'error' ? { errorPhase: 'answer_model' } : {}),
    ...overrides,
    governance: overrides.governance ?? governance,
  };
}

function observation(
  value: FaithTrace,
  traceId = `trace-${value.id}`,
): FaithTraceObservation {
  return {
    trace: value,
    latestEvidence: { runId: RUN.id, traceId },
  };
}

function tracking(
  evalCaseId: string,
  source: BadCaseTracking['source'],
  observedRunIds: string[] = [],
): BadCaseTracking {
  return {
    evalCaseId,
    source,
    firstSeenAt: '2026-07-09T00:00:00.000Z',
    lastSeenAt: '2026-07-09T00:00:00.000Z',
    observedRunIds,
    occurrenceCount: Math.max(1, observedRunIds.length),
  };
}

function badCase(params: {
  evalCaseId: string;
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
  source: BadCaseTracking['source'];
  observedRunIds?: string[];
  status?: BadCase['status'];
}): BadCase {
  return {
    id: canonicalBadCaseId(params),
    createdAt: '2026-07-09T00:00:00.000Z',
    taskType: 'ask_free',
    input: { question: 'existing question' },
    expected: { sourceIds: ['expected'] },
    actual: { sourceIds: ['actual'] },
    failure: {
      layer: params.layer,
      type: params.type,
      note: 'existing note',
    },
    severity: 'medium',
    status: params.status ?? 'triaged',
    tracking: tracking(
      params.evalCaseId,
      params.source,
      params.observedRunIds ?? [],
    ),
  };
}

function onlyCandidate(candidates: FaithBadCaseCandidate[]) {
  assert.equal(candidates.length, 1);
  return candidates[0]!;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

console.log('faith-bad-cases:');

check('reads a decoded faith run and envelope payloads from the eval root', () => {
  withEvalRoot((evalRoot) => {
    const written = writeInput({
      evalRoot,
      runId: 'run-1',
      traces: [inputTrace('case-a'), inputTrace('case-b')],
      scope: 'policy',
    });
    const input = readFaithBadCaseInput({
      runId: 'run-1',
      evalRoot,
    });

    assert.equal(input.run.kind, 'faith');
    assert.equal(input.scope, 'policy');
    assert.deepEqual(
      input.observations.map((item) => item.trace.id),
      ['case-a', 'case-b'],
    );
    assert.deepEqual(
      input.observations.map((item) => item.latestEvidence),
      ['case-a', 'case-b'].map((evalCaseId) => ({
        runId: 'run-1',
        traceId: written.traceIds.get(evalCaseId),
      })),
    );
    assert.deepEqual(input.warnings, []);
  });
});

check('rejects missing and legacy run artifacts', () => {
  withEvalRoot((evalRoot) => {
    assert.throws(
      () => readFaithBadCaseInput({ runId: 'missing', evalRoot }),
      /run file not found/,
    );
    writeJsonAtomic(runPath('legacy', evalRoot), {
      id: 'legacy',
      createdAt: '2026-07-10T00:00:00.000Z',
      metrics: {},
    });
    assert.throws(
      () => readFaithBadCaseInput({ runId: 'legacy', evalRoot }),
      /invalid eval run/,
    );
  });
});

check('rejects a failed faith run as bad-case input', () => {
  withEvalRoot((evalRoot) => {
    const failedRun = {
      ...faithRun({
        id: 'failed-run',
        cases: [MINI_GROUNDED_CASES[0]!],
      }),
      status: 'failed' as const,
      failure: { stage: 'judge_quorum', message: 'failed' },
    };
    writeJsonAtomic(runPath(failedRun.id, evalRoot), failedRun);

    assert.throws(
      () =>
        readFaithBadCaseInput({
          runId: failedRun.id,
          evalRoot,
        }),
      /failed-run.*failed.*completed/i,
    );
  });
});

check('rejects payload/envelope identity mismatch', () => {
  withEvalRoot((evalRoot) => {
    const run = faithRun({
      id: 'run-1',
      cases: [MINI_GROUNDED_CASES[0]!],
    });
    writeJsonAtomic(runPath(run.id, evalRoot), run);
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      createTraceEnvelope({
        runId: run.id,
        evalCaseId: 'case-a',
        governance: MINI_RETRIEVAL_CASES[0]!.governance,
        kind: 'faith',
        outcome: 'success',
        payload: inputTrace('case-b'),
      }),
    );

    assert.throws(
      () =>
        readFaithBadCaseInput({
          runId: run.id,
          evalRoot,
        }),
      /faith payload id mismatch/,
    );
  });
});

check('rejects payload governance that differs from the envelope', () => {
  withEvalRoot((evalRoot) => {
    const run = faithRun({
      id: 'governance-mismatch',
      cases: [MINI_GROUNDED_CASES[0]!],
    });
    writeJsonAtomic(runPath(run.id, evalRoot), run);
    const payload = inputTrace('case-a');
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      createTraceEnvelope({
        runId: run.id,
        evalCaseId: payload.id,
        governance: MINI_RETRIEVAL_CASES[0]!.governance,
        kind: 'faith',
        outcome: 'success',
        payload: {
          ...payload,
          governance: { ...payload.governance, role: 'regression' },
        },
      }),
    );

    assert.throws(
      () => readFaithBadCaseInput({ runId: run.id, evalRoot }),
      /governance mismatch/i,
    );
  });
});

check('rejects run dataset identity that disagrees with trace snapshots', () => {
  withEvalRoot((evalRoot) => {
    const written = writeInput({
      evalRoot,
      runId: 'run-1',
      traces: [inputTrace('case-a')],
    });
    writeJsonAtomic(runPath(written.run.id, evalRoot), {
      ...written.run,
      dataset: { ...written.run.dataset, hash: 'c'.repeat(64) },
    });

    assert.throws(
      () =>
        readFaithBadCaseInput({
          runId: 'run-1',
          evalRoot,
        }),
      /dataset identity mismatch/,
    );
  });
});

check('rejects legacy faith payloads without captured context/search snapshots', () => {
  withEvalRoot((evalRoot) => {
    const run = faithRun({
      id: 'legacy-payload',
      cases: [MINI_GROUNDED_CASES[0]!],
    });
    writeJsonAtomic(runPath(run.id, evalRoot), run);
    const current = inputTrace('case-a');
    const { context: _context, retrieval, ...rest } = current;
    const {
      queryExpansionConfig: _queryExpansionConfig,
      searchTrace: _searchTrace,
      ...legacyRetrieval
    } = retrieval;
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      createTraceEnvelope({
        runId: run.id,
        evalCaseId: current.id,
        governance: current.governance,
        kind: 'faith',
        outcome: 'success',
        payload: { ...rest, retrieval: legacyRetrieval },
      }),
    );

    assert.throws(
      () => readFaithBadCaseInput({ runId: run.id, evalRoot }),
      /context|queryExpansionConfig|searchTrace/i,
    );
  });
});

check('rejects inconsistent context, source, query, and judge snapshots', () => {
  const current = inputTrace('case-a');
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        context: contextSnapshot('Chunk::different'),
      }),
    /context chunk ids.*retrieval topIds/i,
  );
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        sourceExpectation: { mode: 'required', types: ['schema'] },
        sourceCoverage: {
          mode: 'required',
          expectedTypes: ['schema'],
          presentTypes: [],
          missingTypes: ['schema'],
          status: 'missing_required',
        },
      }),
    /source coverage.*context snapshot/i,
  );
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        retrieval: {
          ...current.retrieval,
          queryExpansionConfig: {
            enabled: true,
            registryHash: null,
            reviewedAliasCount: 0,
          },
        },
      }),
    /query expansion config.*search trace/i,
  );
  const { judgeAttempts: _judgeAttempts, ...withoutJudgeAttempts } = current;
  assert.throws(
    () => decodeFaithTrace(withoutJudgeAttempts),
    /judgeAttempts/i,
  );
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        judgeAttempts: [{ status: 'valid', vote: verdict(false) }],
      }),
    /verdict.*valid judge attempt/i,
  );
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        judgeAttempts: [
          { status: 'valid', vote: verdict(true) },
          {
            status: 'invalid',
            code: 'invalid_json',
            reason: 'late invalid output',
            response: {
              stopReason: 'unknown',
              textBlockCount: 1,
              nonTextBlockCount: 0,
            },
          },
        ],
      }),
    /stop after the first valid vote/i,
  );
});

check('faithfulness, response behavior, retrieval, sources, and policy are independent', () => {
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'answer_with_sources',
      retrieval: { fullRecall: true },
      verdict: verdict(true, 'answer'),
    }),
    'passed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'answer_with_sources',
      retrieval: { fullRecall: false },
      verdict: verdict(true, 'answer'),
    }),
    'failed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'refuse_insufficient_context',
      retrieval: { fullRecall: false },
      verdict: verdict(true, 'answer'),
    }),
    'failed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'refuse_insufficient_context',
      retrieval: { fullRecall: false },
      verdict: verdict(true, 'refusal'),
    }),
    'passed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'refuse_insufficient_context',
      retrieval: { fullRecall: false },
      verdict: verdict(false, 'refusal'),
    }),
    'failed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'refuse_insufficient_context',
      retrieval: { fullRecall: false },
      verdict: verdict(true, 'non_answer'),
    }),
    'failed',
  );

  const conflictVote = {
    ...verdict(true, 'answer'),
    policy: {
      distinguished: true,
      conflictExplained: true,
      misstatedAsOfficial: false,
    },
  };
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'explain_schema_policy_conflict',
      retrieval: { fullRecall: true },
      verdict: conflictVote,
    }),
    'passed',
  );
  assert.equal(
    currentFaithOutcome({
      expectedBehavior: 'explain_schema_policy_conflict',
      retrieval: { fullRecall: true },
      verdict: {
        ...conflictVote,
        policy: { ...conflictVote.policy, conflictExplained: false },
      },
    }),
    'failed',
  );

  const sourceAssessment = assessFaith({
    expectedBehavior: 'answer_with_sources',
    retrieval: { fullRecall: true },
    sourceCoverage: {
      mode: 'required',
      expectedTypes: ['docs'],
      presentTypes: ['schema'],
      missingTypes: ['docs'],
      status: 'missing_required',
    },
    verdict: verdict(true, 'answer'),
  });
  assert.equal(sourceAssessment.sourceCoverageSatisfied, false);
  assert.equal(sourceAssessment.passed, false);
});

check('current faith traces require response behavior and a consistent coarse outcome', () => {
  const current = inputTrace('case-a');
  const currentVote = verdict(true, 'answer');
  assert.equal(decodeFaithTrace(current).outcome, 'passed');
  assert.throws(
    () => decodeFaithTrace({ ...current, outcome: 'failed' }),
    /outcome does not match independent assessment/i,
  );
  const {
    responseBehavior: _responseBehavior,
    ...voteWithoutResponseBehavior
  } = currentVote;
  assert.throws(
    () =>
      decodeFaithTrace({
        ...current,
        judgeAttempts: [
          { status: 'valid', vote: voteWithoutResponseBehavior },
        ],
        verdict: voteWithoutResponseBehavior,
      }),
    /responseBehavior/i,
  );
});

check('maps passed, failed, judge, and runtime outcomes', () => {
  const expected = [
    ['passed', 'skip'],
    ['failed', 'create'],
    ['judge_failed', 'create'],
    ['error', 'error'],
  ] as const;

  for (const [outcome, action] of expected) {
    const candidate = onlyCandidate(
      buildFaithBadCaseCandidates({
        observations: [observation(trace(outcome))],
        existingBadCases: [],
        run: RUN,
        scope: 'full',
        now: '2026-07-10T00:00:00.000Z',
      }),
    );
    assert.equal(candidate.action, action, outcome);
  }
});

check('current failures use observational bad-case types instead of causal labels', () => {
  const supportedRetrieval = inputTrace('case-a');
  const unsupportedVote = verdict(false, 'answer');
  const unsupported = {
    ...supportedRetrieval,
    judgeAttempts: [{ status: 'valid' as const, vote: unsupportedVote }],
    verdict: unsupportedVote,
    outcome: 'failed' as const,
  };
  const unsupportedCandidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      observations: [observation(unsupported)],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  assert.equal(unsupportedCandidate.issue?.failure.type, 'unsupported_claim');

  const expectedRefusal = trace('passed', {
    expectedBehavior: 'refuse_insufficient_context',
  });
  const answerVote = verdict(true, 'answer');
  const behaviorMismatch = {
    ...expectedRefusal,
    judgeAttempts: [{ status: 'valid' as const, vote: answerVote }],
    verdict: answerVote,
    outcome: 'failed' as const,
  };
  const behaviorCandidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      observations: [observation(behaviorMismatch)],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  assert.equal(behaviorCandidate.issue?.failure.type, 'behavior_mismatch');
});

check('full and holdout runs never turn holdout traces into bad-case candidates', () => {
  const holdoutTrace = trace('failed', {
    governance: {
      task: 'field_explanation',
      origin: 'human',
      role: 'holdout',
    },
  });

  assert.deepEqual(
    buildFaithBadCaseCandidates({
      observations: [observation(holdoutTrace)],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
    [],
  );
  assert.deepEqual(
    buildFaithBadCaseCandidates({
      observations: [observation(holdoutTrace)],
      existingBadCases: [],
      run: { ...RUN, scope: 'holdout' },
      scope: 'holdout',
      now: '2026-07-10T00:00:00.000Z',
    }),
    [],
  );
});

check('reports retrieval-incomplete evidence independently from unsupported claims', () => {
  const retrieval = badCase({
    evalCaseId: 'case-1',
    layer: 'rerank',
    type: 'rerank_miss',
    source: 'retrieval_eval',
  });
  const incomplete = trace('failed', {
    retrieval: {
      ...trace('failed').retrieval,
      expectedChunkIds: ['schema::v1::Pod::spec.containers.image'],
      foundCount: 0,
      fullRecall: false,
    },
  });
  const candidates = buildFaithBadCaseCandidates({
    observations: [observation(incomplete)],
    existingBadCases: [retrieval],
    run: RUN,
    scope: 'policy',
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(candidates.length, 2);
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.action === 'create' &&
        candidate.issue?.failure.type === 'unsupported_claim',
    ),
    true,
  );
  assert.deepEqual(
    candidates.find((candidate) => candidate.action === 'link_only')
      ?.relatedBadCaseIds,
    [retrieval.id],
  );
});

check('recurring issues retain status and extend observed runs once', () => {
  const existing = badCase({
    evalCaseId: 'case-1',
    layer: 'generation',
    type: 'unsupported_claim',
    source: 'faith_eval',
    observedRunIds: ['older-run'],
    status: 'fixed',
  });
  const candidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      observations: [observation(trace('failed'), 'trace-recurrence')],
      existingBadCases: [existing],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  const merged = mergeBadCaseIssues({ existing: [existing], candidates: [candidate] });

  assert.equal(candidate.action, 'recur');
  assert.deepEqual(candidate.issue?.latestEvidence, {
    runId: RUN.id,
    traceId: 'trace-recurrence',
  });
  assert.equal(merged.cases[0]?.status, 'fixed');
  assert.deepEqual(merged.cases[0]?.tracking.observedRunIds, [
    'older-run',
    'faith-run-1',
  ]);
  assert.equal(merged.cases[0]?.tracking.occurrenceCount, 2);
});

console.log(`\n通过 ${passed} 项`);

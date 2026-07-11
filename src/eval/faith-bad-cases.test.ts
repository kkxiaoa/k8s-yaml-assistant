import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFaithBadCaseCandidates,
  mergeBadCaseIssues,
  readFaithBadCaseInput,
  type FaithBadCaseCandidate,
} from './faith-bad-cases';
import {
  canonicalBadCaseId,
  type BadCase,
  type BadCaseTracking,
} from './bad-cases';
import type { FaithOutcome, FaithTrace } from './faith-store';
import { computeEvalSetHash, type EvalRun } from './run-store';
import type { RetrievalEvalCase } from './cases/retrieval-cases';

const RUN: EvalRun = {
  id: 'faith-run-1',
  kind: 'faith',
  createdAt: '2026-07-10T00:00:00.000Z',
  corpusHash: 'corpus',
  indexHash: 'index',
  evalSetHash: 'retrieval-cases',
  embeddingModel: 'voyage-3',
  rerankModel: 'rerank-2.5',
  answerModel: 'claude-sonnet-4-6',
  k: 3,
  metrics: {},
};

const MINI_RETRIEVAL_CASES: RetrievalEvalCase[] = [
  {
    id: 'case-a',
    taskType: 'ask_free',
    question: '问题 A',
    expectedChunkIds: ['Chunk::a'],
    resource: 'Pod',
    answerable: true,
    source: 'human',
  },
  {
    id: 'case-b',
    taskType: 'ask_free',
    question: '问题 B',
    expectedChunkIds: ['Chunk::b'],
    resource: 'Deployment',
    answerable: true,
    source: 'human',
  },
];

function inputTrace(id: 'case-a' | 'case-b'): FaithTrace {
  const ec = MINI_RETRIEVAL_CASES.find((c) => c.id === id)!;
  return {
    id: ec.id,
    question: ec.question,
    answerable: ec.answerable,
    resource: ec.resource,
    retrieval: {
      expectedChunkIds: ec.expectedChunkIds,
      topIds: ec.expectedChunkIds,
      foundCount: ec.expectedChunkIds.length,
      fullRecall: true,
    },
    answer: 'answer',
    verdict: verdict(true),
    outcome: 'faithful_hit',
  };
}

function withInputFiles(
  fn: (paths: {
    dir: string;
    runsDir: string;
    tracesDir: string;
  }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'faith-bad-cases-'));
  try {
    const runsDir = join(dir, 'runs');
    const tracesDir = join(dir, 'traces');
    fn({ dir, runsDir, tracesDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeInput(params: {
  runsDir: string;
  tracesDir: string;
  runId: string;
  traces: FaithTrace[];
  run?: Partial<EvalRun>;
}): EvalRun {
  mkdirSync(params.runsDir, { recursive: true });
  mkdirSync(params.tracesDir, { recursive: true });
  const tracePath = join(params.tracesDir, `${params.runId}.faith.jsonl`);
  const run: EvalRun = {
    ...RUN,
    id: params.runId,
    kind: 'faith',
    artifactPaths: { tracePath },
    evalSetHash: computeEvalSetHash(
      params.traces.map((t) => ({
        id: t.id,
        question: t.question,
        expectedChunkIds: t.retrieval.expectedChunkIds,
      })),
    ),
    evalSetVersionHash: computeEvalSetHash(MINI_RETRIEVAL_CASES),
    faithSelection: {
      scope: 'full',
      caseIds: params.traces.map((t) => t.id),
    },
    ...params.run,
  };
  writeFileSync(
    join(params.runsDir, `${params.runId}.json`),
    `${JSON.stringify(run, null, 2)}\n`,
  );
  writeFileSync(
    tracePath,
    params.traces.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
  return run;
}

function verdict(faithful: boolean) {
  return {
    faithful,
    unsupported: faithful ? [] : ['unsupported claim'],
    reason: faithful ? 'faithful' : 'unsupported',
  };
}

function trace(
  outcome: FaithOutcome,
  overrides: Partial<FaithTrace> = {},
): FaithTrace {
  return {
    id: 'case-1',
    question: '这个字段怎么用?',
    answerable: true,
    resource: 'Pod',
    retrieval: {
      expectedChunkIds: ['Pod::spec.containers.image'],
      topIds: ['Pod::spec.containers.name'],
      foundCount: 0,
      fullRecall: false,
    },
    answer: 'answer',
    verdict: outcome === 'judge_failed' || outcome === 'error'
      ? null
      : verdict(
          outcome === 'faithful_hit' ||
            outcome === 'faithful_miss' ||
            outcome === 'refused_correctly',
        ),
    outcome,
    ...overrides,
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
    id: canonicalBadCaseId({
      evalCaseId: params.evalCaseId,
      layer: params.layer,
      type: params.type,
    }),
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

withInputFiles(({ runsDir }) => {
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'missing',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /run file not found/,
  );
});

withInputFiles(({ runsDir }) => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, 'run-1.json'),
    `${JSON.stringify({ ...RUN, id: 'run-1', kind: 'faith' })}\n`,
  );
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /artifactPaths\.tracePath/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, 'run-1.json'),
    `${JSON.stringify({
      ...RUN,
      id: 'run-1',
      kind: 'faith',
      artifactPaths: {
        tracePath: join(tracesDir, 'missing.faith.jsonl'),
      },
    })}\n`,
  );
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /faith trace file not found/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { id: 'other-run' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /run id mismatch/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { kind: 'retrieval' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /expected faith run/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a'), inputTrace('case-a')],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /duplicate trace id/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [{ ...inputTrace('case-a'), id: 'unknown' }],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /not found in RETRIEVAL_CASES/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [{ ...inputTrace('case-a'), question: '漂移的问题' }],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /trace case drift/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [
      {
        ...inputTrace('case-a'),
        retrieval: {
          ...inputTrace('case-a').retrieval,
          expectedChunkIds: ['Changed::chunk'],
        },
      },
    ],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /trace case drift/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { evalSetHash: 'bad-selection-hash' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /evalSetHash mismatch/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { evalSetVersionHash: 'bad-version-hash' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        evalSet: MINI_RETRIEVAL_CASES,
      }),
    /evalSetVersionHash mismatch/,
  );
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'legacy-policy',
    traces: [inputTrace('case-a')],
    run: {
      evalSetVersionHash: undefined,
      faithSelection: undefined,
    },
  });
  const input = readFaithBadCaseInput({
    runId: 'legacy-policy',
    runsDir,
    evalSet: MINI_RETRIEVAL_CASES,
  });

  assert.equal(input.scope, 'policy');
  assert.deepEqual(input.warnings, ['legacy run missing evalSetVersionHash']);
});

withInputFiles(({ runsDir, tracesDir }) => {
  writeInput({
    runsDir,
    tracesDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: {
      faithSelection: {
        scope: 'smoke',
        caseIds: ['case-a'],
      },
    },
  });
  const input = readFaithBadCaseInput({
    runId: 'run-1',
    runsDir,
    evalSet: MINI_RETRIEVAL_CASES,
  });

  assert.equal(input.scope, 'smoke');
  assert.equal(input.traces.length, 1);
  assert.deepEqual(input.warnings, []);
});

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('faithful_hit')],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'skip');
  assert.equal(c.evalCaseId, 'case-1');
}

{
  const retrieval = badCase({
    evalCaseId: 'case-1',
    layer: 'retrieval',
    type: 'retrieval_miss',
    source: 'retrieval_eval',
  });
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('faithful_miss')],
      existingBadCases: [retrieval],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'link_only');
  assert.equal(c.issueId, retrieval.id);
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('faithful_miss')],
      existingBadCases: [],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'warning');
  assert.match(c.message ?? '', /missing_retrieval_issue/);
  assert.equal(c.issue, undefined);
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'create');
  assert.equal(c.issue?.failure.layer, 'generation');
  assert.equal(c.issue?.failure.type, 'hallucination');
  assert.equal(c.issue?.severity, 'high');
  assert.equal(c.issue?.tracking.source, 'faith_eval');
  assert.deepEqual(c.issue?.tracking.observedRunIds, ['faith-run-1']);
  assert.equal(c.issue?.actual.evaluation?.runId, 'faith-run-1');
  assert.equal(c.issue?.actual.evaluation?.scope, 'policy');
  assert.equal(c.issue?.actual.evaluation?.outcome, 'hallucination');
  assert.deepEqual(c.issue?.actual.evaluation?.unsupportedClaims, [
    'unsupported claim',
  ]);
}

{
  const retrieval = badCase({
    evalCaseId: 'case-1',
    layer: 'rerank',
    type: 'rerank_miss',
    source: 'retrieval_eval',
  });
  const candidates = buildFaithBadCaseCandidates({
    traces: [trace('dual_cause')],
    existingBadCases: [retrieval],
    run: RUN,
    scope: 'policy',
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.action, 'create');
  assert.deepEqual(candidates[0]!.issue?.relatedBadCaseIds, [retrieval.id]);
}

{
  const candidates = buildFaithBadCaseCandidates({
    traces: [trace('dual_cause')],
    existingBadCases: [],
    run: RUN,
    scope: 'policy',
    now: '2026-07-10T00:00:00.000Z',
  });

  assert.equal(candidates.map((c) => c.action).join(','), 'create,warning');
  assert.match(candidates[1]!.message ?? '', /missing_retrieval_issue/);
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('refused_correctly', { answerable: false })],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'skip');
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('refused_wrong', { answerable: false })],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'create');
  assert.equal(c.issue?.failure.layer, 'generation');
  assert.equal(c.issue?.failure.type, 'refusal_error');
  assert.equal(c.issue?.severity, 'high');
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('judge_failed')],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'create');
  assert.equal(c.issue?.failure.layer, 'judge');
  assert.equal(c.issue?.failure.type, 'judge_error');
  assert.equal(c.issue?.severity, 'medium');
}

{
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('error')],
      existingBadCases: [],
      run: RUN,
      scope: 'full',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'error');
  assert.match(c.message ?? '', /runtime error/);
  assert.equal(c.issue, undefined);
}

{
  const existing = badCase({
    evalCaseId: 'case-1',
    layer: 'generation',
    type: 'hallucination',
    source: 'faith_eval',
    observedRunIds: ['older-run'],
    status: 'fixed',
  });
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [existing],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'recur');
  assert.equal(c.issue?.status, 'fixed');
  assert.deepEqual(c.issue?.tracking.observedRunIds, [
    'older-run',
    'faith-run-1',
  ]);
  assert.equal(c.issue?.tracking.occurrenceCount, 2);
}

{
  const existing = badCase({
    evalCaseId: 'case-1',
    layer: 'generation',
    type: 'hallucination',
    source: 'faith_eval',
    observedRunIds: ['faith-run-1'],
  });
  const c = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [existing],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );

  assert.equal(c.action, 'already_imported');
}

{
  const candidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  const merged = mergeBadCaseIssues({
    existing: [],
    candidates: [
      candidate,
      { action: 'skip', evalCaseId: 'skip-case' },
      { action: 'warning', evalCaseId: 'warn-case', message: 'warn' },
      { action: 'error', evalCaseId: 'error-case', message: 'error' },
    ],
  });

  assert.equal(merged.cases.length, 1);
  assert.equal(merged.cases[0]!.failure.type, 'hallucination');
  assert.equal(merged.summary.create, 1);
  assert.equal(merged.summary.skip, 1);
  assert.equal(merged.summary.warning, 1);
  assert.equal(merged.summary.error, 1);
}

{
  const existing = badCase({
    evalCaseId: 'case-1',
    layer: 'generation',
    type: 'hallucination',
    source: 'faith_eval',
    observedRunIds: ['older-run'],
    status: 'fixed',
  });
  const candidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [existing],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  const merged = mergeBadCaseIssues({
    existing: [existing],
    candidates: [candidate],
  });

  assert.equal(merged.cases.length, 1);
  assert.equal(merged.cases[0]!.status, 'fixed');
  assert.deepEqual(merged.cases[0]!.tracking.observedRunIds, [
    'older-run',
    'faith-run-1',
  ]);
  assert.equal(merged.cases[0]!.tracking.occurrenceCount, 2);
  assert.equal(merged.summary.recur, 1);
}

{
  const existing = badCase({
    evalCaseId: 'case-1',
    layer: 'generation',
    type: 'hallucination',
    source: 'faith_eval',
    observedRunIds: ['faith-run-1'],
  });
  const candidate = onlyCandidate(
    buildFaithBadCaseCandidates({
      traces: [trace('hallucination')],
      existingBadCases: [existing],
      run: RUN,
      scope: 'policy',
      now: '2026-07-10T00:00:00.000Z',
    }),
  );
  const merged = mergeBadCaseIssues({
    existing: [existing],
    candidates: [candidate],
  });

  assert.equal(merged.cases.length, 1);
  assert.deepEqual(merged.cases[0]!.tracking.observedRunIds, ['faith-run-1']);
  assert.equal(merged.cases[0]!.tracking.occurrenceCount, 1);
  assert.equal(merged.summary.already_imported, 1);
}

console.log('faith-bad-cases tests passed');

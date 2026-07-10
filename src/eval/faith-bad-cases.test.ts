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
  type BadCaseOrigin,
} from './bad-cases';
import type { FaithOutcome, FaithTrace } from './faith-store';
import { computeEvalSetHash, type EvalRun } from './run-store';
import type { EvalCase } from './eval-set';

const RUN: EvalRun = {
  id: 'faith-run-1',
  kind: 'faith',
  createdAt: '2026-07-10T00:00:00.000Z',
  corpusHash: 'corpus',
  indexHash: 'index',
  evalSetHash: 'eval-set',
  embeddingModel: 'voyage-3',
  rerankModel: 'rerank-2.5',
  answerModel: 'claude-sonnet-4-6',
  k: 3,
  metrics: {},
};

const MINI_EVAL_SET: EvalCase[] = [
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
  const ec = MINI_EVAL_SET.find((c) => c.id === id)!;
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
  fn: (paths: { dir: string; runsDir: string; faithDir: string }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'faith-bad-cases-'));
  try {
    const runsDir = join(dir, 'runs');
    const faithDir = join(dir, 'faith');
    fn({ dir, runsDir, faithDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeInput(params: {
  runsDir: string;
  faithDir: string;
  runId: string;
  traces: FaithTrace[];
  run?: Partial<EvalRun>;
}): EvalRun {
  mkdirSync(params.runsDir, { recursive: true });
  mkdirSync(params.faithDir, { recursive: true });
  const run: EvalRun = {
    ...RUN,
    id: params.runId,
    kind: 'faith',
    evalSetHash: computeEvalSetHash(
      params.traces.map((t) => ({
        id: t.id,
        question: t.question,
        expectedChunkIds: t.retrieval.expectedChunkIds,
      })),
    ),
    evalSetVersionHash: computeEvalSetHash(MINI_EVAL_SET),
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
    join(params.faithDir, `${params.runId}.jsonl`),
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

function origin(
  evalCaseId: string,
  source: BadCaseOrigin['source'],
  observedRunIds: string[] = [],
): BadCaseOrigin {
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
  source: BadCaseOrigin['source'];
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
    convertedEvalId: params.evalCaseId,
    origin: origin(
      params.evalCaseId,
      params.source,
      params.observedRunIds ?? [],
    ),
  };
}

function legacyBadCase(params: {
  id: string;
  question: string;
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
  status?: BadCase['status'];
}): BadCase {
  return {
    id: params.id,
    createdAt: '2026-07-08T00:00:00.000Z',
    taskType: 'ask_free',
    input: { question: params.question },
    expected: { sourceIds: ['Chunk::a'] },
    actual: { sourceIds: ['Chunk::other'] },
    failure: {
      layer: params.layer,
      type: params.type,
      note: 'legacy note',
    },
    severity: 'medium',
    status: params.status ?? 'triaged',
  };
}

function onlyCandidate(candidates: FaithBadCaseCandidate[]) {
  assert.equal(candidates.length, 1);
  return candidates[0]!;
}

withInputFiles(({ runsDir, faithDir }) => {
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'missing',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /run file not found/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
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
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /faith trace file not found/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { id: 'other-run' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /run id mismatch/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { kind: 'retrieval' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /expected faith run/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [inputTrace('case-a'), inputTrace('case-a')],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /duplicate trace id/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [{ ...inputTrace('case-a'), id: 'unknown' }],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /not found in EVAL_SET/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [{ ...inputTrace('case-a'), question: '漂移的问题' }],
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /trace case drift/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
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
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /trace case drift/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { evalSetHash: 'bad-selection-hash' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /evalSetHash mismatch/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
    runId: 'run-1',
    traces: [inputTrace('case-a')],
    run: { evalSetVersionHash: 'bad-version-hash' },
  });
  assert.throws(
    () =>
      readFaithBadCaseInput({
        runId: 'run-1',
        runsDir,
        faithDir,
        evalSet: MINI_EVAL_SET,
      }),
    /evalSetVersionHash mismatch/,
  );
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
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
    faithDir,
    evalSet: MINI_EVAL_SET,
  });

  assert.equal(input.scope, 'policy');
  assert.deepEqual(input.warnings, ['legacy run missing evalSetVersionHash']);
});

withInputFiles(({ runsDir, faithDir }) => {
  writeInput({
    runsDir,
    faithDir,
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
    faithDir,
    evalSet: MINI_EVAL_SET,
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
  assert.equal(c.issue?.origin?.source, 'faith_eval');
  assert.deepEqual(c.issue?.origin?.observedRunIds, ['faith-run-1']);
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
  assert.deepEqual(c.issue?.origin?.observedRunIds, [
    'older-run',
    'faith-run-1',
  ]);
  assert.equal(c.issue?.origin?.occurrenceCount, 2);
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
    evalSet: MINI_EVAL_SET,
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
    evalSet: MINI_EVAL_SET,
  });

  assert.equal(merged.cases.length, 1);
  assert.equal(merged.cases[0]!.status, 'fixed');
  assert.deepEqual(merged.cases[0]!.origin?.observedRunIds, [
    'older-run',
    'faith-run-1',
  ]);
  assert.equal(merged.cases[0]!.origin?.occurrenceCount, 2);
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
    evalSet: MINI_EVAL_SET,
  });

  assert.equal(merged.cases.length, 1);
  assert.deepEqual(merged.cases[0]!.origin?.observedRunIds, ['faith-run-1']);
  assert.equal(merged.cases[0]!.origin?.occurrenceCount, 1);
  assert.equal(merged.summary.already_imported, 1);
}

{
  const canonical = badCase({
    evalCaseId: 'case-a',
    layer: 'retrieval',
    type: 'retrieval_miss',
    source: 'retrieval_eval',
    status: 'new',
  });
  const legacy = legacyBadCase({
    id: 'legacy-id',
    question: '问题 A',
    layer: 'retrieval',
    type: 'retrieval_miss',
    status: 'triaged',
  });
  const merged = mergeBadCaseIssues({
    existing: [legacy, canonical],
    candidates: [],
    evalSet: MINI_EVAL_SET,
  });

  assert.equal(merged.cases.length, 1);
  assert.equal(
    merged.cases[0]!.id,
    canonicalBadCaseId({
      evalCaseId: 'case-a',
      layer: 'retrieval',
      type: 'retrieval_miss',
    }),
  );
  assert.equal(merged.cases[0]!.origin?.evalCaseId, 'case-a');
  assert.equal(merged.cases[0]!.status, 'triaged');
  assert.equal(merged.warnings.length, 1);
  assert.match(merged.warnings[0]!, /merged duplicate bad case/);
}

console.log('faith-bad-cases tests passed');

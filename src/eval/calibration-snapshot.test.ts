import assert from 'node:assert/strict';
import {
  buildJudgeCalibrationCaseFromFaith,
  type JudgeCalibrationLabel,
} from './calibration-snapshot';
import { decodeFaithTrace, type FaithTrace } from './faith-store';

const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

const SNAPSHOT_CHUNK = {
  id: 'Chunk::actual',
  title: 'actual chunk',
  text: 'snapshot text',
  sourceType: 'schema' as const,
  provenance: { authority: 'cluster_api' as const, version: 'v1' },
  targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.field' }],
};
const SNAPSHOT_SOURCE = {
  n: 1,
  id: SNAPSHOT_CHUNK.id,
  title: SNAPSHOT_CHUNK.title,
  sourceType: SNAPSHOT_CHUNK.sourceType,
  provenance: SNAPSHOT_CHUNK.provenance,
  targets: SNAPSHOT_CHUNK.targets,
};
const SNAPSHOT_HIT = {
  id: SNAPSHOT_CHUNK.id,
  title: SNAPSHOT_CHUNK.title,
  sourceType: SNAPSHOT_CHUNK.sourceType,
  provenance: SNAPSHOT_CHUNK.provenance,
  targets: SNAPSHOT_CHUNK.targets,
  score: 0.9,
};
const SNAPSHOT_CONTEXT = {
  text: '[S1] snapshot captured during the faith run',
  chunks: [SNAPSHOT_CHUNK],
  sources: [SNAPSHOT_SOURCE],
};

const BASE_TRACE: FaithTrace = {
  id: 'case-1',
  governance: GOVERNANCE,
  input: { kind: 'retrieval_case', retrievalCaseId: 'case-1' },
  question: 'question',
  expectedBehavior: 'answer_with_sources',
  target: { kind: 'Pod' },
  context: SNAPSHOT_CONTEXT,
  retrieval: {
    expectedChunkIds: ['Chunk::expected'],
    topIds: ['Chunk::actual'],
    foundCount: 0,
    fullRecall: false,
    queryExpansionConfig: {
      enabled: false,
      registryHash: null,
      reviewedAliasCount: 0,
    },
    searchTrace: {
      question: 'question',
      mode: 'free',
      queryText: 'question',
      queryExpansion: {
        enabled: false,
        status: 'disabled',
        originalQueryText: 'question',
        expandedQueryText: 'question',
        matchedAliases: [],
        expansionTerms: [],
      },
      path: 'search',
      coarseHits: [SNAPSHOT_HIT],
      rerankHits: [SNAPSHOT_HIT],
      finalHits: [SNAPSHOT_HIT],
      latencyMs: { total: 1 },
      cache: { index: { status: 'hit' }, embeddingHit: false },
      createdAt: '2026-07-12T00:00:00.000Z',
    },
  },
  answer: 'answer',
  judgeAttempts: [
    {
      status: 'valid',
      vote: {
        faithful: false,
        responseBehavior: 'answer',
        unsupported: ['claim'],
        reason: 'unsupported',
      },
    },
  ],
  verdict: {
    faithful: false,
    responseBehavior: 'answer',
    unsupported: ['claim'],
    reason: 'unsupported',
  },
  outcome: 'failed',
};

const { context: _context, ...TRACE_WITHOUT_CONTEXT } = BASE_TRACE;

const LABEL = {
  id: 'case-1',
  sourceFaithRunId: 'faith-run-1',
  category: 'hallucinated',
  human: { faithful: false, note: 'human label' },
} satisfies JudgeCalibrationLabel;

const { governance: _governance, ...TRACE_WITHOUT_GOVERNANCE } = BASE_TRACE;
assert.throws(
  () => decodeFaithTrace(TRACE_WITHOUT_GOVERNANCE),
  /governance/i,
);

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: LABEL,
      trace: TRACE_WITHOUT_CONTEXT as FaithTrace,
      sourceFaithRunId: 'faith-run-1',
      sourceFaithTraceId: 'faith-run-1:case-1',
    }),
  /case-1.*context snapshot|context snapshot.*case-1/i,
);

const calibrationCase = buildJudgeCalibrationCaseFromFaith({
  label: LABEL,
  trace: BASE_TRACE,
  sourceFaithRunId: 'faith-run-1',
  sourceFaithTraceId: 'faith-run-1:case-1',
});

assert.deepEqual(calibrationCase, {
  id: LABEL.id,
  governance: GOVERNANCE,
  category: LABEL.category,
  question: BASE_TRACE.question,
  context: SNAPSHOT_CONTEXT.text,
  sources: SNAPSHOT_CONTEXT.sources,
  answer: BASE_TRACE.answer,
  human: LABEL.human,
  sourceFaithRunId: 'faith-run-1',
  sourceFaithTraceId: 'faith-run-1:case-1',
});

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: { ...LABEL, id: 'other-case' },
      trace: BASE_TRACE,
      sourceFaithRunId: 'faith-run-1',
      sourceFaithTraceId: 'faith-run-1:case-1',
    }),
  /label.*other-case.*trace.*case-1|identity mismatch/i,
);

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: LABEL,
      trace: BASE_TRACE,
      sourceFaithRunId: 'faith-run-2',
      sourceFaithTraceId: 'faith-run-2:case-1',
    }),
  /source run mismatch/i,
);

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: LABEL,
      trace: BASE_TRACE,
      sourceFaithRunId: 'faith-run-1',
      sourceFaithTraceId: '',
    }),
  /source faith trace id/i,
);

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: LABEL,
      trace: { ...BASE_TRACE, answer: '' },
      sourceFaithRunId: 'faith-run-1',
      sourceFaithTraceId: 'faith-run-1:case-1',
    }),
  /missing answer snapshot/i,
);

console.log('calibration-snapshot: 7 checks passed');

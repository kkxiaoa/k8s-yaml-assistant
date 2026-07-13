import assert from 'node:assert/strict';
import { buildJudgeCalibrationCaseFromFaith } from './calibration-snapshot';
import type { FaithTrace } from './faith-store';

const BASE_TRACE: FaithTrace = {
  id: 'case-1',
  question: 'question',
  answerable: true,
  retrieval: {
    expectedChunkIds: ['Chunk::expected'],
    topIds: ['Chunk::actual'],
    foundCount: 0,
    fullRecall: false,
  },
  answer: 'answer',
  verdict: {
    faithful: false,
    unsupported: ['claim'],
    reason: 'unsupported',
  },
  outcome: 'dual_cause',
};

const LABEL = {
  id: 'case-1',
  category: 'hallucinated',
  human: { faithful: false, note: 'human label' },
};

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: LABEL,
      trace: BASE_TRACE,
      sourceFaithRunId: 'faith-run-1',
    }),
  /case-1.*context snapshot|context snapshot.*case-1/i,
);

const snapshotContext = '[S1] snapshot captured during the faith run';
const calibrationCase = buildJudgeCalibrationCaseFromFaith({
  label: LABEL,
  trace: { ...BASE_TRACE, context: snapshotContext },
  sourceFaithRunId: 'faith-run-1',
});

assert.deepEqual(calibrationCase, {
  id: LABEL.id,
  category: LABEL.category,
  question: BASE_TRACE.question,
  context: snapshotContext,
  answer: BASE_TRACE.answer,
  human: LABEL.human,
  sourceFaithRunId: 'faith-run-1',
});

assert.throws(
  () =>
    buildJudgeCalibrationCaseFromFaith({
      label: { ...LABEL, id: 'other-case' },
      trace: { ...BASE_TRACE, context: snapshotContext },
      sourceFaithRunId: 'faith-run-1',
    }),
  /label.*other-case.*trace.*case-1|identity mismatch/i,
);

console.log('calibration-snapshot: 3 checks passed');

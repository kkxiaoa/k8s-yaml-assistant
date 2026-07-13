import type { FaithTrace } from './faith-store';
import type { JudgeCalibrationCase } from './metrics/judge-metrics';

export type JudgeCalibrationLabel = Pick<
  JudgeCalibrationCase,
  'id' | 'category' | 'human'
>;

export function buildJudgeCalibrationCaseFromFaith(params: {
  label: JudgeCalibrationLabel;
  trace: FaithTrace;
  sourceFaithRunId: string;
}): JudgeCalibrationCase {
  const { label, trace, sourceFaithRunId } = params;
  if (label.id !== trace.id) {
    throw new Error(
      `calibration identity mismatch: label ${label.id}, trace ${trace.id}`,
    );
  }
  if (trace.context === undefined || !trace.context.trim()) {
    throw new Error(`faith trace ${trace.id} missing context snapshot`);
  }

  return {
    id: label.id,
    category: label.category,
    question: trace.question,
    context: trace.context,
    answer: trace.answer,
    human: label.human,
    sourceFaithRunId,
  };
}

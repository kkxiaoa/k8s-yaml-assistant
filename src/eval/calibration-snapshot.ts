import type { FaithTrace } from './faith-store';
import {
  JudgeCalibrationCaseSchema,
  JudgeCalibrationLabelSchema,
  type JudgeCalibrationCase,
  type JudgeCalibrationLabel,
} from './metrics/judge-metrics';

export type { JudgeCalibrationLabel } from './metrics/judge-metrics';

export function buildJudgeCalibrationCaseFromFaith(params: {
  label: JudgeCalibrationLabel;
  trace: FaithTrace;
  sourceFaithRunId: string;
  sourceFaithTraceId: string;
}): JudgeCalibrationCase {
  const { trace, sourceFaithRunId, sourceFaithTraceId } = params;
  const label = JudgeCalibrationLabelSchema.parse(params.label);
  if (label.id !== trace.id) {
    throw new Error(
      `calibration identity mismatch: label ${label.id}, trace ${trace.id}`,
    );
  }
  if (label.sourceFaithRunId !== sourceFaithRunId) {
    throw new Error(
      `calibration source run mismatch: label ${label.sourceFaithRunId}, trace ${sourceFaithRunId}`,
    );
  }
  if (trace.context === undefined || !trace.context.text.trim()) {
    throw new Error(`faith trace ${trace.id} missing context snapshot`);
  }
  if (!trace.answer.trim()) {
    throw new Error(`faith trace ${trace.id} missing answer snapshot`);
  }
  if (!sourceFaithRunId.trim()) {
    throw new Error('source faith run id must be non-empty');
  }
  if (!sourceFaithTraceId.trim()) {
    throw new Error('source faith trace id must be non-empty');
  }

  return JudgeCalibrationCaseSchema.parse({
    id: label.id,
    governance: trace.governance,
    category: label.category,
    question: trace.question,
    context: trace.context.text,
    sources: trace.context.sources,
    answer: trace.answer,
    human: label.human,
    sourceFaithRunId,
    sourceFaithTraceId,
  });
}

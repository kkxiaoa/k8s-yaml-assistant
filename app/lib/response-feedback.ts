import {
  RESPONSE_FEEDBACK_REASONS_BY_ROUTE,
  type ModelRoute,
  type ResponseFeedbackReason,
} from '@/server/experience-control';

type RouteReasonLabels = {
  [Route in ModelRoute]: Readonly<
    Record<
      (typeof RESPONSE_FEEDBACK_REASONS_BY_ROUTE)[Route][number],
      string
    >
  >;
};

const RESPONSE_FEEDBACK_REASON_LABELS_BY_ROUTE: RouteReasonLabels = {
  ask: {
    incorrect_or_incomplete: '内容错误或不完整',
    not_what_i_asked: '没有回答我的问题',
    insufficient_evidence: '依据或引用有问题',
    unusable_result: '结果无法使用',
    slow_or_buggy: '响应慢或功能异常',
    other: '其他',
  },
  generate: {
    incorrect_or_incomplete: '生成内容错误或不完整',
    not_what_i_asked: '没有按生成要求',
    unusable_result: '结果无法使用',
    slow_or_buggy: '响应慢或功能异常',
    other: '其他',
  },
  fix: {
    incorrect_or_incomplete: '修复错误或不完整',
    not_what_i_asked: '没有修复指定问题',
    unintended_changes: '修改了无关内容或引入新问题',
    unusable_result: '结果无法使用',
    slow_or_buggy: '响应慢或功能异常',
    other: '其他',
  },
};

const RESPONSE_FEEDBACK_SUMMARY_LABELS: Readonly<
  Record<ResponseFeedbackReason, string>
> = {
  incorrect_or_incomplete: '结果错误或不完整',
  not_what_i_asked: '未满足要求',
  insufficient_evidence: '依据或引用有问题',
  unintended_changes: '修改无关内容或引入新问题',
  unusable_result: '结果无法使用',
  slow_or_buggy: '响应慢或功能异常',
  other: '其他',
};

export function responseFeedbackReasonOptions(route: ModelRoute) {
  const labels = RESPONSE_FEEDBACK_REASON_LABELS_BY_ROUTE[route] as Readonly<
    Partial<Record<ResponseFeedbackReason, string>>
  >;
  return RESPONSE_FEEDBACK_REASONS_BY_ROUTE[route].map((reason) => ({
    reason,
    label: labels[reason]!,
  }));
}

export const RESPONSE_FEEDBACK_REASON_SUMMARY_OPTIONS = Object.entries(
  RESPONSE_FEEDBACK_SUMMARY_LABELS,
).map(([reason, label]) => ({
  reason: reason as ResponseFeedbackReason,
  label,
}));

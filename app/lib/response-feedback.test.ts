import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESPONSE_FEEDBACK_REASON_SUMMARY_OPTIONS,
  responseFeedbackReasonOptions,
} from './response-feedback';

test('反馈原因复用核心分类并只展示路由相关选项', () => {
  assert.deepEqual(responseFeedbackReasonOptions('ask'), [
    { reason: 'incorrect_or_incomplete', label: '内容错误或不完整' },
    { reason: 'not_what_i_asked', label: '没有回答我的问题' },
    { reason: 'insufficient_evidence', label: '依据或引用有问题' },
    { reason: 'unusable_result', label: '结果无法使用' },
    { reason: 'slow_or_buggy', label: '响应慢或功能异常' },
    { reason: 'other', label: '其他' },
  ]);
  assert.deepEqual(responseFeedbackReasonOptions('generate'), [
    { reason: 'incorrect_or_incomplete', label: '生成内容错误或不完整' },
    { reason: 'not_what_i_asked', label: '没有按生成要求' },
    { reason: 'unusable_result', label: '结果无法使用' },
    { reason: 'slow_or_buggy', label: '响应慢或功能异常' },
    { reason: 'other', label: '其他' },
  ]);
  assert.deepEqual(responseFeedbackReasonOptions('fix'), [
    { reason: 'incorrect_or_incomplete', label: '修复错误或不完整' },
    { reason: 'not_what_i_asked', label: '没有修复指定问题' },
    {
      reason: 'unintended_changes',
      label: '修改了无关内容或引入新问题',
    },
    { reason: 'unusable_result', label: '结果无法使用' },
    { reason: 'slow_or_buggy', label: '响应慢或功能异常' },
    { reason: 'other', label: '其他' },
  ]);
});

test('管理汇总覆盖共享和路由专属原因', () => {
  assert.deepEqual(
    RESPONSE_FEEDBACK_REASON_SUMMARY_OPTIONS.map(({ reason }) => reason),
    [
      'incorrect_or_incomplete',
      'not_what_i_asked',
      'insufficient_evidence',
      'unintended_changes',
      'unusable_result',
      'slow_or_buggy',
      'other',
    ],
  );
});

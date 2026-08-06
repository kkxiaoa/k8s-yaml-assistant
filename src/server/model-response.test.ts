import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  modelTextResponse,
  requireModelText,
} from './model-response';

function message(
  content: unknown[],
  stopReason: Anthropic.Message['stop_reason'],
): Pick<Anthropic.Message, 'content' | 'stop_reason'> {
  return {
    content,
    stop_reason: stopReason,
  } as Pick<Anthropic.Message, 'content' | 'stop_reason'>;
}

console.log('model response:');

test('文本边界拼接文本块并保留有界诊断元数据', () => {
  const response = modelTextResponse(
    message(
      [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
      'end_turn',
    ),
  );

  assert.equal(requireModelText(response), '第一段第二段');
  assert.deepEqual(response.metadata, {
    stopReason: 'end_turn',
    textBlockCount: 2,
    nonTextBlockCount: 1,
  });
});

test('空文本响应显式失败并报告停止原因与块计数', () => {
  const response = modelTextResponse(
    message([{ type: 'thinking', thinking: 'internal' }], 'max_tokens'),
  );

  assert.throws(
    () => requireModelText(response),
    /stop_reason=max_tokens, text_blocks=0, non_text_blocks=1/,
  );
});

test('未知停止原因不会原样进入错误消息', () => {
  const response = modelTextResponse(
    message([], 'unexpected-stop' as Anthropic.Message['stop_reason']),
  );

  assert.throws(() => requireModelText(response), /stop_reason=unknown/);
});

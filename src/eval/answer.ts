// 生成层(被测)的共享配置与调用:答系统提示 + 模型 + generateAnswer。
// 独立成无副作用模块,供 faithfulness / judge-capture 复用(避免从带 main 的文件 import 触发跑批)。

import type Anthropic from '@anthropic-ai/sdk';
import { textOf } from './judge';

/** 被测(生成)模型:DeepSeek 映射 deepseek-v4-flash。 */
export const MODEL = 'claude-sonnet-4-6';

export const ANSWER_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手。基于给定的 <docs> 片段回答问题。
规则:
- 只依据 <docs> 作答,不要编造文档里没有的字段、取值或步骤。
- 若片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 简洁准确,涉及枚举值时列全。用中文回答。`;

/** 基于给定文档上下文生成回答(与 eval:faith 同一路径)。 */
export function generateAnswer(
  client: Anthropic,
  context: string,
  question: string,
): Promise<string> {
  return textOf(
    client,
    MODEL,
    ANSWER_SYSTEM,
    `参考以下文档回答。\n\n<docs>\n${context}\n</docs>\n\n问题:${question}`,
  );
}

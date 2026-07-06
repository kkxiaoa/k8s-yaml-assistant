import type Anthropic from '@anthropic-ai/sdk';
import { textOf } from './llm';

/** 裁判模型:DeepSeek 映射 deepseek-v4-pro,更强 + 与被测异构,降低"自评偏袒"。 */
export const JUDGE_MODEL = 'claude-opus-4-8';

export const JUDGE_SYSTEM = `你是严格的事实核查裁判。判断【回答】有没有编造【文档】里没有的具体事实。
判定规则:
- faithful=false 表示回答陈述了文档中找不到依据的**具体事实**(字段名、取值、默认值、步骤等)。
- faithful=true 表示回答只用了文档里有的事实或回答是"文档中没有相关信息""无法回答"之类的**拒答**。
- 重要: "没有相关信息" "文档未说明" 这类话**本身不是需要核查的事实主张**。不要因为文档里碰巧包含别的字段,就判这种拒答为不忠实。判定的唯一关注点是:回答有没有**编造文档外的具体事实**。
- 通读全部片段: 【文档】常含多个字段片段。某主张只要在**任意一个片段**里有依据即算有据;不要只盯"最像的"那个片段、而忽略相邻片段里的支持(尤其多个同名/相似字段时,主张常由另一个片段支持)。
- 忠实 ≠ 正确: 回答即使在现实中是对的, 只要文档没写, 也算 faithful=false。
- 示例性数值不算编造: 对文档已说明"用户可设置/可调大"的参数, 回答给出明显是举例的占位数值(例如把"调大"举例成从 10Gi 改到 20Gi), 属于合理示例即 faithful=true。只有当回答把文档没有的内容当成**确定的字段名/枚举值/默认值/行为**来陈述时才算 faithful=false。
只输出 JSON, 不要代码围栏、不要任何额外文字:
{"faithful": true 或 false, "unsupported": ["文档不支持的具体主张,没有则空数组"], "reason": "一句话理由"}`;

export interface Verdict {
  faithful: boolean;
  unsupported: string[];
  reason: string;
}

/** 从可能带 ```json 围栏的文本里抠出 JSON 并解析。解析不出返回 null(=判定失败,不等于不忠实)。 */
export function parseJson(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Verdict>;
    return {
      faithful: Boolean(o.faithful),
      unsupported: Array.isArray(o.unsupported) ? o.unsupported : [],
      reason: typeof o.reason === 'string' ? o.reason : '',
    };
  } catch {
    return null;
  }
}

/** 空/无法解析时重试一次,仍失败返回 null(=判定失败,不算幻觉)。 */
export async function judge(
  client: Anthropic,
  context: string,
  answer: string,
): Promise<Verdict | null> {
  const user = `【文档】\n${context}\n\n【回答】\n${answer}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await textOf(client, JUDGE_MODEL, JUDGE_SYSTEM, user);
    const v = parseJson(raw);
    if (v) return v;
  }
  return null;
}

import type Anthropic from '@anthropic-ai/sdk';
import { textOf } from './llm';
import {
  parseJudgeAttempt,
  type JudgeAttempt,
  type JudgeVote,
} from './judge-votes';
import { evalErrorDetails } from './run-session';

export const JUDGE_MODEL = 'deepseek-v4-pro';
export const FAITH_JUDGE_ATTEMPT_LIMIT = 2;
export const JUDGE_PARSER_SCHEMA_IDENTITY = 'judge-vote-parser-v2';

export const JUDGE_SYSTEM = `你是严格的事实核查裁判。判断【回答】有没有编造【文档】里没有的具体事实。
判定规则:
- faithful=false 表示回答陈述了文档中找不到依据的**具体事实**(字段名、取值、默认值、步骤等)。
- faithful=true 表示回答只用了文档里有的事实或回答是"文档中没有相关信息""无法回答"之类的**拒答**。
- 重要: "没有相关信息" "文档未说明" 这类话**本身不是需要核查的事实主张**。不要因为文档里碰巧包含别的字段,就判这种拒答为不忠实。判定的唯一关注点是:回答有没有**编造文档外的具体事实**。
- 通读全部片段: 【文档】常含多个字段片段。某主张只要在**任意一个片段**里有依据即算有据;不要只盯"最像的"那个片段、而忽略相邻片段里的支持(尤其多个同名/相似字段时,主张常由另一个片段支持)。
- 忠实 ≠ 正确: 回答即使在现实中是对的, 只要文档没写, 也算 faithful=false。
- 示例性数值不算编造: 对文档已说明"用户可设置/可调大"的参数, 回答给出明显是举例的占位数值(例如把"调大"举例成从 10Gi 改到 20Gi), 属于合理示例即 faithful=true。只有当回答把文档没有的内容当成**确定的字段名/枚举值/默认值/行为**来陈述时才算 faithful=false。
- policy 判定(仅当【文档】含标 [policy] 的片段时):额外判断回答是否 ① 区分了官方事实(schema)与组织策略(policy)(distinguished)、② 对 schema/policy 冲突问题是否同时说明 schema 字段校验层与 policy 限制层(conflictExplained;若问题不是冲突类,填 false)、③ 是否误把 policy 当 K8s 官方强制(misstatedAsOfficial)。文档无 policy 片段时 policy 字段整体省略。
只输出 JSON, 不要代码围栏、不要任何额外文字:
{"faithful": true 或 false, "unsupported": ["文档不支持的具体主张,没有则空数组"], "reason": "一句话理由", "policy": {"distinguished": bool, "conflictExplained": bool, "misstatedAsOfficial": bool} 或省略}`;

export async function judgeOnce(
  client: Anthropic,
  context: string,
  answer: string,
): Promise<JudgeAttempt> {
  const user = `【文档】\n${context}\n\n【回答】\n${answer}`;
  try {
    const raw = await textOf(client, JUDGE_MODEL, JUDGE_SYSTEM, user);
    return parseJudgeAttempt(raw);
  } catch (error) {
    return {
      status: 'error',
      ...evalErrorDetails('judge_request', error),
    };
  }
}

export interface JudgeResult {
  attempts: JudgeAttempt[];
  verdict: JudgeVote | null;
}

export async function judge(
  client: Anthropic,
  context: string,
  answer: string,
  attemptLimit = FAITH_JUDGE_ATTEMPT_LIMIT,
): Promise<JudgeResult> {
  if (!Number.isInteger(attemptLimit) || attemptLimit <= 0) {
    throw new TypeError('faith judge attempt limit must be a positive integer');
  }
  const attempts: JudgeAttempt[] = [];
  for (let index = 0; index < attemptLimit; index++) {
    const attempt = await judgeOnce(client, context, answer);
    attempts.push(attempt);
    if (attempt.status === 'valid') {
      return { attempts, verdict: attempt.vote };
    }
  }
  return { attempts, verdict: null };
}

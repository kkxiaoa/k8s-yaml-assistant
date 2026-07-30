import type Anthropic from '@anthropic-ai/sdk';
import { textResponseOf } from './llm';
import {
  parseJudgeAttempt,
  type LiveJudgeAttempt,
  type LiveJudgeVote,
} from './judge-votes';
import { evalErrorDetails } from './run-session';

export const JUDGE_MODEL = 'deepseek-v4-pro';
export const JUDGE_MAX_TOKENS = 8192;
export const FAITH_JUDGE_ATTEMPT_LIMIT = 2;
export const JUDGE_PARSER_SCHEMA_IDENTITY = 'judge-vote-parser-v5';

export const JUDGE_SYSTEM = `你是严格的证据核查裁判。逐项核对【回答】中的具体主张是否得到允许依据支持。
证据边界:
- 【问题】只确定用户意图。只有依据本身已明确列出有限选项时,问题才能从中限定一个选项；问题不能补充依据未列出的选项或事实。
- 【生成输入】中只有 <docs>、<current_yaml> 和 <editor_context> 里的当前配置或错误信息是允许依据；提示说明、<ask_mode> 和末尾重复的问题都不是依据。
- 必须通读全部允许依据。一个主张被单个片段直接说明,或能由多个片段和问题限定无歧义地联合推出,即算有据。
主张边界:
- 字段名、资源名、API、参数名、键名、枚举值、默认值、行为、步骤、命令以及校验、准入、拒绝或运行结果都是具体主张。
- 只有允许依据已经说明某字段或参数可配置时,回答才可以为它给出明确标为示例的占位值。这个例外不能引入依据未出现的字段、资源、API、参数、键、命令或行为。
- 校验、准入、拒绝和运行结果必须由允许依据直接说明；不能仅根据字段类型、取值范围、枚举或组织策略推断具体机制或结果。
- 具体操作建议中的命令、资源、字段或参数也必须有据；披露"文档未说明"不能抵消同一回答里的无依据主张。
- 现实中正确但依据未支持的具体主张仍是无依据主张。
判定:
- 回答存在任一无依据具体主张时 faithful=false,并逐项写入 unsupported；否则 faithful=true。纯粹因依据不足而拒答且没有继续给出具体结论或建议时也为 faithful=true。
- responseBehavior 与 faithful 独立:
  - answer: 给出任何实质性结论、解释或操作建议,即使只回答一部分或同时披露依据不足。
  - refusal: 明确因依据不足而无法作答,且没有实质性结论、解释或操作建议。
  - non_answer: 空响应、无关内容或元话语,既未实质作答,也未明确拒答。
- policy 判定仅在 <docs> 含 [policy] 片段时输出: distinguished 判断回答是否区分 schema 官方事实和 policy 组织策略；conflictExplained 仅对冲突问题判断回答是否同时说明 schema 校验层与 policy 限制层,非冲突问题为 false；misstatedAsOfficial 判断回答是否把 policy 误称为 Kubernetes 官方强制。没有 [policy] 片段时省略 policy。
输出契约:
- 只输出一个合法 JSON 对象。第一个字符必须是 {,最后一个字符必须是 };不要代码围栏、前后说明或第二个对象。
- unsupported 必须是字符串数组,没有无依据主张时使用 []。
- <docs> 没有 [policy] 片段时必须完全省略 policy 属性,绝不能输出 policy:null 或空 policy 对象。
- 无 [policy] 的合法格式示例:
{"faithful":true,"responseBehavior":"refusal","unsupported":[],"reason":"回答仅因允许依据不足而拒答。"}
- 有 [policy] 的合法格式示例:
{"faithful":false,"responseBehavior":"answer","unsupported":["允许依据不支持的具体主张"],"reason":"回答包含无依据主张。","policy":{"distinguished":true,"conflictExplained":true,"misstatedAsOfficial":false}}`;

export interface JudgeInput {
  question: string;
  context: string;
  answer: string;
}

function buildJudgeUserMessage(input: JudgeInput): string {
  return `【问题】\n${input.question}\n\n【生成输入】\n${input.context}\n\n【回答】\n${input.answer}`;
}

export const JUDGE_USER_MESSAGE_TEMPLATE = buildJudgeUserMessage({
  question: '<question>',
  context: '<generation_input>',
  answer: '<answer>',
});

export async function judgeOnce(
  client: Anthropic,
  input: JudgeInput,
): Promise<LiveJudgeAttempt> {
  const user = buildJudgeUserMessage(input);
  try {
    const response = await textResponseOf(
      client,
      JUDGE_MODEL,
      JUDGE_SYSTEM,
      user,
      JUDGE_MAX_TOKENS,
    );
    return parseJudgeAttempt(response.text, response.metadata);
  } catch (error) {
    return {
      status: 'error',
      ...evalErrorDetails('judge_request', error),
    };
  }
}

export interface JudgeResult {
  attempts: LiveJudgeAttempt[];
  verdict: LiveJudgeVote | null;
}

export async function judge(
  client: Anthropic,
  input: JudgeInput,
  attemptLimit = FAITH_JUDGE_ATTEMPT_LIMIT,
): Promise<JudgeResult> {
  if (!Number.isInteger(attemptLimit) || attemptLimit <= 0) {
    throw new TypeError('faith judge attempt limit must be a positive integer');
  }
  const attempts: LiveJudgeAttempt[] = [];
  for (let index = 0; index < attemptLimit; index++) {
    const attempt = await judgeOnce(client, input);
    attempts.push(attempt);
    if (attempt.status === 'valid') {
      return { attempts, verdict: attempt.vote };
    }
  }
  return { attempts, verdict: null };
}

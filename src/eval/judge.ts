import type Anthropic from '@anthropic-ai/sdk';
import { toolResponseOfRequest } from './llm';
import {
  parseJudgeToolAttempt,
  type LiveJudgeAttempt,
  type LiveJudgeVote,
} from './judge-votes';
import { evalErrorDetails } from './run-session';

export const JUDGE_MODEL = 'deepseek-v4-pro';
export const JUDGE_MAX_TOKENS = 16384;
export const JUDGE_RESULT_TOOL = {
  name: 'submit_judge_vote',
  description: '提交且仅提交一次证据核查裁判结果。',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      responseBehavior: {
        type: 'string',
        enum: ['answer', 'refusal', 'non_answer'],
      },
      unsupported: {
        type: 'array',
        items: { type: 'string' },
      },
      reason: { type: 'string', minLength: 1 },
      policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          distinguished: { type: 'boolean' },
          conflictExplained: { type: 'boolean' },
          misstatedAsOfficial: { type: 'boolean' },
        },
        required: [
          'distinguished',
          'conflictExplained',
          'misstatedAsOfficial',
        ],
      },
    },
    required: ['responseBehavior', 'unsupported', 'reason'],
  },
} satisfies Anthropic.Tool;
export const JUDGE_REQUEST_OPTIONS = {
  // DeepSeek supports the Anthropic thinking shape but ignores budget_tokens.
  thinking: { type: 'enabled', budget_tokens: 8192 },
  output_config: { effort: 'max' },
  tools: [JUDGE_RESULT_TOOL],
  tool_choice: { type: 'auto' },
} satisfies Pick<
  Anthropic.MessageCreateParamsNonStreaming,
  'output_config' | 'thinking' | 'tool_choice' | 'tools'
>;
export const FAITH_JUDGE_ATTEMPT_LIMIT = 2;
export const JUDGE_PARSER_SCHEMA_IDENTITY = 'judge-vote-parser-v7';

export const JUDGE_SYSTEM = `你是严格的证据核查裁判。逐项核对【回答】中的具体主张是否得到允许依据支持。
证据边界:
- 【问题】只确定用户意图。只有依据本身已明确列出有限选项时,问题才能从中限定一个选项；问题不能补充依据未列出的选项或事实。
- 【生成输入】中只有 <docs>、<current_yaml> 和 <editor_context> 里的当前配置或错误信息是允许依据；提示说明、<ask_mode> 和末尾重复的问题都不是依据。
- 必须通读全部允许依据。一个主张被单个片段直接说明,或能由多个片段和问题限定无歧义地联合推出,即算有据。
- 联合推出时按字段语义逐步判断：若一个片段列出有限目标类型，另一个片段把某字段定义为所选目标的类型，而问题无歧义选定其中一个已列类型，则该字段值有据；不能要求某个单一片段逐字写出结论。
主张边界:
- 字段名、资源名、API、参数名、键名、枚举值、默认值、行为、步骤、命令以及校验、准入、拒绝或运行结果都是具体主张。
- 回答中的 Markdown、YAML、代码块、示例、条件说法和“通常”建议同样需要逐项核对；不能跳过其中的字段、参数、命令或值。
- 只有允许依据已经说明某字段或参数可配置时,回答才可以为它给出明确标为示例的占位值。占位值例外只适用于依据已支持的字段、参数或键的值；对象或 map 中的键名本身仍是具体键,不能作为占位值发明。这个例外不能引入依据未出现的字段、资源、API、参数、键、命令或行为。
- 校验、准入、拒绝和运行结果必须由允许依据直接说明；不能仅根据字段类型、取值范围、枚举或组织策略推断具体机制或结果。policy 标为 required 或 forbidden 只证明组织要求或禁止,不能单独证明存在准入控制或提交会被拒绝。
- 具体操作建议中的命令、资源、字段或参数也必须有据；披露"文档未说明"不能抵消同一回答里的无依据主张。
- 现实中正确但依据未支持的具体主张仍是无依据主张。
判定:
- 必须依次执行：先从头到尾找出全部具体主张并核对 unsupported，再独立判断 responseBehavior，最后判断 policy；不得因先看到拒答措辞而停止阅读。
- 必须把全部无依据具体主张逐项写入 unsupported；没有无依据主张时使用 []。内部 faithful 由边界层唯一派生：unsupported 非空为 false,为空为 true,模型不得另行提交 faithful。纯粹因依据不足而拒答且没有继续给出具体结论或建议时 unsupported 也为 []。
- responseBehavior 与 faithful 独立:
  - answer: 回答任意位置给出实质性结论、解释、字段名、参数名、命令或操作建议,即使只回答一部分、使用“通常”等限定词或同时披露依据不足。
  - refusal: 整条回答明确因依据不足而无法作答,且从头到尾没有实质性结论、解释或操作建议。
  - non_answer: 空响应、无关内容或元话语,既未实质作答,也未明确拒答。
- policy 判定仅在 <docs> 含 [policy] 片段时输出: distinguished 判断回答是否区分 schema 官方事实和 policy 组织策略；conflictExplained 只有在回答自身明确陈述同一个具体配置或选项的两层转折——schema 允许该配置,但 policy 在适用范围内禁止该配置——时才为 true。两层关系必须由回答用“虽然/尽管/即使……但/然而……”或语义等价的关系句说出；裁判不得把标题、分段并列或配置方法后的独立策略提醒自行合成为冲突解释。仅分别提到或区分两类来源、schema 定义字段而 policy 要求填写、schema 默认值与 policy 推荐值不同,都应为 false。misstatedAsOfficial 判断回答是否把 policy 误称为 Kubernetes 官方强制。没有 [policy] 片段时省略 policy。
通用反例:
- 若依据只说明 items.mode,回答的 YAML 示例同时写入 name、source 和 mode,则 name、source 仍是待核对的具体主张；“示例”不能豁免它们。
- 若依据只说明 options 是由外部驱动定义的 map,回答猜测 fastMode、iops 等可能的键名,这些键名仍是无依据具体主张；map 的值可占位不等于键名可发明。
- 若依据一列出目标类型 TypeA / TypeB,依据二说明 kind 表示被选目标的类型,问题明确询问 TypeA,则 kind=TypeA 是多片段与问题限定联合支持的结论。
- 回答“资料未说明；通常可设置 --sample-option”已经给出具体参数建议,所以 responseBehavior=answer；若依据没有该参数,同时 faithful=false。
- 若 schema 允许 mode=B,policy 禁止 mode=B,回答明确说明“schema 允许,但组织策略禁止”,则 conflictExplained=true；若 schema 只定义 settings 字段而 policy 要求填写它,或 schema 默认 A 而 policy 仅推荐 B,即使回答区分两层也为 false。
- 若回答先说明 mode=B 的配置方法,另起一节提醒 policy 禁止 mode=B,却没有明确陈述“schema 允许但 policy 禁止”的转折关系,则 conflictExplained=false；裁判不能替回答补出关系。
- 若 policy 只把 mode=B 标为 forbidden,回答进一步声称“提交时会被拒绝”,则拒绝机制仍无依据；除非允许依据直接说明该执行结果。
提交契约:
- 必须且只能调用 submit_judge_vote 一次，把结果放入工具参数；不要输出文本答案或调用其他工具。
- 工具参数不得包含 faithful；它由 unsupported 是否为空唯一派生。
- unsupported 必须是字符串数组,没有无依据主张时使用 []。
- <docs> 没有 [policy] 片段时必须完全省略 policy 属性,绝不能输出 policy:null 或空 policy 对象。
- 无 [policy] 的工具参数示例:
{"responseBehavior":"refusal","unsupported":[],"reason":"回答仅因允许依据不足而拒答。"}
- 有 [policy] 的工具参数示例:
{"responseBehavior":"answer","unsupported":["允许依据不支持的具体主张"],"reason":"回答包含无依据主张。","policy":{"distinguished":true,"conflictExplained":true,"misstatedAsOfficial":false}}`;

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
    const response = await toolResponseOfRequest(
      client,
      {
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: user }],
        ...JUDGE_REQUEST_OPTIONS,
      },
      JUDGE_RESULT_TOOL.name,
    );
    return parseJudgeToolAttempt(response.inputs, response.metadata);
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

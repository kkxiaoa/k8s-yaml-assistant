// Stage 4:生成/修复引擎 —— agentic 循环「生成 → 提交 → parse → schema 校验 → 修复」。
// 结构化入参 GenerateRequest / 出参 GenerateResult(含分阶段 diagnostics);修复轮次封顶,
// 失败如实返回原因、不伪装成功。支持多文档 YAML(为多资源一致性生成铺路)。

import Anthropic from '@anthropic-ai/sdk';
import {
  validateYamlDocuments,
  type ValidationError,
} from '../validation/validate';
import { ANSWER_MODEL } from './pipeline';

/** 最大修复轮次:首次生成 + 至多 2 次修复(§6 边界)。 */
const MAX_REPAIR_ROUNDS = 2;

const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_yaml',
  description:
    '提交你生成或修正的 Kubernetes 资源 YAML 进行 schema 校验,返回错误列表(空数组表示通过)。产出 YAML 后必须调用本工具;若返回错误,逐条修正后重新调用,直到校验通过。',
  input_schema: {
    type: 'object',
    properties: {
      yaml: {
        type: 'string',
        description: '完整的资源 YAML 文本(多资源用 --- 分隔)',
      },
    },
    required: ['yaml'],
  },
};

export interface Diagnostic {
  stage: 'generate' | 'parse' | 'validate' | 'repair';
  message: string;
}

export interface GenerateRequest {
  requirement: string;
  target?: { kind?: string; apiVersion?: string };
  context?: {
    currentYaml?: string;
    selectedText?: string;
    validationErrors?: ValidationError[];
  };
}

/** 每次 submit_yaml 的结构化记录,供 eval 汇总首轮/多轮真实行为。 */
export interface SubmitAttempt {
  submitIndex: number; // 1-based
  yaml: string;
  parseOk: boolean;
  validationOk: boolean;
  errors: ValidationError[];
}

export interface GenerateResult {
  /** 最终通过校验的 YAML;始终拿不到合法结果则为 null(不伪装成功) */
  yaml: string | null;
  /** 修复轮数(首次提交之后的重提次数) */
  rounds: number;
  /** 每次提交的结构化明细(submit 流) */
  attempts: SubmitAttempt[];
  /** 循环级诊断:模型未提交(generate)/ 达修复上限(repair) */
  diagnostics: Diagnostic[];
}

/** agentic loop:submit_yaml → check → 修复,直到通过或达修复轮次上限。 */
async function runLoop(
  client: Anthropic,
  system: string,
  firstUser: string,
): Promise<GenerateResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: firstUser },
  ];
  const diagnostics: Diagnostic[] = [];
  const attempts: SubmitAttempt[] = [];
  let lastValid: string | null = null;
  let submits = 0;
  const maxSubmits = 1 + MAX_REPAIR_ROUNDS;

  for (let turn = 0; turn < maxSubmits + 2; turn++) {
    const resp = await client.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 2048,
      system,
      tools: [SUBMIT_TOOL],
      messages,
    });

    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      diagnostics.push({
        stage: 'generate',
        message: text
          ? `模型未提交 YAML,仅返回文本:${text.slice(0, 120)}`
          : '模型未产出可提交的 YAML',
      });
      break;
    }

    messages.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of resp.content) {
      if (block.type === 'tool_use' && block.name === 'submit_yaml') {
        submits++;

        const yamlText = String((block.input as { yaml?: unknown }).yaml ?? '');
        const check = validateYamlDocuments(yamlText);
        const validationOk = check.errors.length === 0;

        attempts.push({
          submitIndex: submits,
          yaml: yamlText,
          parseOk: !check.parseFailed,
          validationOk,
          errors: check.errors,
        });
        if (validationOk) lastValid = yamlText;

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(check.errors),
        });
      }
    }

    messages.push({ role: 'user', content: results });

    if (lastValid) break;
    if (submits >= maxSubmits) {
      diagnostics.push({
        stage: 'repair',
        message: `已达最大修复轮次(${MAX_REPAIR_ROUNDS}),仍未通过校验,返回失败`,
      });
      break;
    }
  }

  return {
    yaml: lastValid,
    rounds: Math.max(0, submits - 1),
    attempts,
    diagnostics,
  };
}

const GEN_SYSTEM = `你是 Kubernetes 专家。根据用户的自然语言需求,生成合法的资源 YAML。
工作流程(必须遵守):
1. 生成 YAML 后,必须调用 submit_yaml 工具提交校验。
2. 若工具返回错误,逐条修正后重新调用,直到返回空错误列表。
3. YAML 要完整(含 apiVersion/kind/metadata.name),不要附带解释。`;

const FIX_SYSTEM = `你是 Kubernetes 专家。用户给你一段有校验错误的资源 YAML 和错误列表。
请修正所有错误,同时尽量保持原有字段与意图不变。
工作流程(必须遵守):
1. 修正后必须调用 submit_yaml 工具提交校验。
2. 若仍有错误,继续修正重新提交,直到返回空错误列表。
3. 只输出修正后的资源,不要附带解释。`;

function buildGenUser(req: GenerateRequest): string {
  const parts = [`需求:${req.requirement}`];
  if (req.target?.kind) {
    parts.push(
      `目标资源:${req.target.kind}${req.target.apiVersion ? ` (${req.target.apiVersion})` : ''}`,
    );
  }
  if (req.context?.currentYaml) {
    parts.push('当前 YAML:\n```yaml\n' + req.context.currentYaml + '\n```');
  }
  if (req.context?.selectedText) {
    parts.push(`选中内容:${req.context.selectedText}`);
  }
  if (req.context?.validationErrors?.length) {
    parts.push(
      '已知校验错误:\n' +
        req.context.validationErrors
          .map((e) => `- ${e.path || '(根)'}: ${e.message}`)
          .join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** 根据结构化需求生成资源 YAML(带自检闭环)。 */
export function generateResource(
  client: Anthropic,
  request: GenerateRequest,
): Promise<GenerateResult> {
  return runLoop(client, GEN_SYSTEM, buildGenUser(request));
}

/** 修正一段有校验错误的资源 YAML(带自检闭环)。 */
export function fixResource(
  client: Anthropic,
  yaml: string,
  errors: ValidationError[],
): Promise<GenerateResult> {
  const errText = errors
    .map((e) => `- ${e.path || '(根)'}: ${e.message}`)
    .join('\n');
  return runLoop(
    client,
    FIX_SYSTEM,
    `请修正这段 YAML 的校验错误。\n\n当前 YAML:\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n校验错误:\n${errText}`,
  );
}

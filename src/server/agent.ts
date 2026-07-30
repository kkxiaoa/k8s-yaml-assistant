// Stage 4:生成/修复引擎 —— agentic 循环「生成 → 提交 → parse → schema 校验 → 修复」。
// 结构化入参 GenerateRequest / 出参 GenerateResult(含分阶段 diagnostics);修复轮次封顶,
// 失败如实返回原因、不伪装成功。支持多文档 YAML(为多资源一致性生成铺路)。

import Anthropic from '@anthropic-ai/sdk';
import {
  validateYamlDocuments,
  type ValidationError,
} from '../validation/validate';
import {
  AGENT_MAX_TOKENS,
  ANSWER_MODEL,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
} from './agent-contract';
import { assertModelInputByteBudget } from './model-request-policy';
import type { ProviderRequestObserver } from './provider-usage';

export {
  AGENT_MAX_TOKENS,
  ANSWER_MODEL,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
} from './agent-contract';

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
  observer?: ProviderRequestObserver,
): Promise<GenerateResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: firstUser },
  ];
  const diagnostics: Diagnostic[] = [];
  const attempts: SubmitAttempt[] = [];
  let lastValid: string | null = null;
  let submits = 0;
  const maxSubmits = 1 + MAX_REPAIR_ROUNDS;

  for (let turn = 0; turn < maxSubmits; turn++) {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: ANSWER_MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      system,
      tools: [SUBMIT_YAML_TOOL],
      messages,
    };
    assertModelInputByteBudget(request);
    observer?.requestStarted('deepseek');
    const resp = await client.messages.create(request);
    observer?.deepSeekUsage(
      request.model,
      resp.usage?.input_tokens,
      resp.usage?.output_tokens,
      resp.usage?.cache_creation_input_tokens,
      resp.usage?.cache_read_input_tokens,
    );

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

  if (lastValid === null && diagnostics.length === 0) {
    diagnostics.push({
      stage: 'repair',
      message: `已达最大模型调用次数(${maxSubmits}),仍未通过校验,返回失败`,
    });
  }

  return {
    yaml: lastValid,
    rounds: Math.max(0, submits - 1),
    attempts,
    diagnostics,
  };
}

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
  observer?: ProviderRequestObserver,
): Promise<GenerateResult> {
  return runLoop(client, GENERATION_SYSTEM, buildGenUser(request), observer);
}

/** 修正一段有校验错误的资源 YAML(带自检闭环)。 */
export function fixResource(
  client: Anthropic,
  yaml: string,
  errors: ValidationError[],
  observer?: ProviderRequestObserver,
): Promise<GenerateResult> {
  const errText = errors
    .map((e) => `- ${e.path || '(根)'}: ${e.message}`)
    .join('\n');
  return runLoop(
    client,
    FIX_SYSTEM,
    `请修正这段 YAML 的校验错误。\n\n当前 YAML:\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n校验错误:\n${errText}`,
    observer,
  );
}

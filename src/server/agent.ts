// Phase D:通用 agentic 循环 —— 生成 / 修复任意 K8s 资源 YAML,带"生成→校验→修正"自检闭环。
// 模型产出 YAML → 调 submit_yaml 工具 → schema 驱动校验 → 有错回灌修正 → 直到通过,返回最终合法 YAML。

import Anthropic from '@anthropic-ai/sdk';
import { load } from 'js-yaml';
import { validateResource, type ValidationError } from '../validation/validate';
import { ANSWER_MODEL } from './pipeline';

const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_yaml',
  description:
    '提交你生成或修正的 Kubernetes 资源 YAML 进行 schema 校验,返回错误列表(空数组表示通过)。产出 YAML 后必须调用本工具;若返回错误,逐条修正后重新调用,直到校验通过。',
  input_schema: {
    type: 'object',
    properties: {
      yaml: { type: 'string', description: '完整的资源 YAML 文本' },
    },
    required: ['yaml'],
  },
};

function validateYamlText(yamlText: string): ValidationError[] {
  try {
    return validateResource(load(yamlText));
  } catch (e) {
    return [
      {
        path: '',
        message:
          'YAML 解析失败: ' + (e instanceof Error ? e.message : String(e)),
      },
    ];
  }
}

export interface AgentResult {
  /** 最终通过校验的 YAML;始终拿不到合法结果则为 null */
  yaml: string | null;
  /** 自检修正轮数(模型自己发现错并改的次数) */
  rounds: number;
}

/** 手动 agentic loop:submit_yaml → 校验 → 修正,直到通过或到上限。 */
async function runLoop(
  client: Anthropic,
  system: string,
  firstUser: string,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: firstUser },
  ];
  let lastValid: string | null = null;
  let rounds = 0;

  for (let turn = 0; turn < 8; turn++) {
    const resp = await client.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 2048,
      system,
      tools: [SUBMIT_TOOL],
      messages,
    });

    if (resp.stop_reason !== 'tool_use') break;
    console.log(resp);
    messages.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type === 'tool_use' && block.name === 'submit_yaml') {
        const yamlText = String((block.input as { yaml?: unknown }).yaml ?? '');
        const errors = validateYamlText(yamlText);
        if (errors.length === 0) lastValid = yamlText;
        else rounds++;
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(errors),
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { yaml: lastValid, rounds };
}

const GEN_SYSTEM = `你是 Kubernetes 专家。根据用户的自然语言需求,生成一个合法的资源 YAML。
工作流程(必须遵守):
1. 生成 YAML 后,必须调用 submit_yaml 工具提交校验。
2. 若工具返回错误,逐条修正后重新调用,直到返回空错误列表。
3. 只生成一个资源,YAML 要完整(含 apiVersion/kind/metadata.name),不要附带解释。`;

const FIX_SYSTEM = `你是 Kubernetes 专家。用户给你一段有校验错误的资源 YAML 和错误列表。
请修正所有错误,同时尽量保持原有字段与意图不变。
工作流程(必须遵守):
1. 修正后必须调用 submit_yaml 工具提交校验。
2. 若仍有错误,继续修正重新提交,直到返回空错误列表。
3. 只输出修正后的资源,不要附带解释。`;

/** 根据自然语言需求生成资源 YAML(带自检闭环)。 */
export function generateResource(
  client: Anthropic,
  requirement: string,
): Promise<AgentResult> {
  return runLoop(client, GEN_SYSTEM, `需求:${requirement}`);
}

/** 修正一段有校验错误的资源 YAML(带自检闭环)。 */
export function fixResource(
  client: Anthropic,
  yaml: string,
  errors: ValidationError[],
): Promise<AgentResult> {
  const errText = errors
    .map((e) => `- ${e.path || '(根)'}: ${e.message}`)
    .join('\n');
  return runLoop(
    client,
    FIX_SYSTEM,
    `请修正这段 YAML 的校验错误。\n\n当前 YAML:\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n校验错误:\n${errText}`,
  );
}

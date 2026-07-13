import type Anthropic from '@anthropic-ai/sdk';

export const ANSWER_MODEL = 'claude-sonnet-4-6';
export const MAX_REPAIR_ROUNDS = 2;
export const AGENT_MAX_TOKENS = 2048;

export const SUBMIT_YAML_TOOL: Anthropic.Tool = {
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

export const GENERATION_SYSTEM = `你是 Kubernetes 专家。根据用户的自然语言需求,生成合法的资源 YAML。
工作流程(必须遵守):
1. 生成 YAML 后,必须调用 submit_yaml 工具提交校验。
2. 若工具返回错误,逐条修正后重新调用,直到返回空错误列表。
3. YAML 要完整(含 apiVersion/kind/metadata.name),不要附带解释。`;

export const FIX_SYSTEM = `你是 Kubernetes 专家。用户给你一段有校验错误的资源 YAML 和错误列表。
请修正所有错误,同时尽量保持原有字段与意图不变。
工作流程(必须遵守):
1. 修正后必须调用 submit_yaml 工具提交校验。
2. 若仍有错误,继续修正重新提交,直到返回空错误列表。
3. 只输出修正后的资源,不要附带解释。`;

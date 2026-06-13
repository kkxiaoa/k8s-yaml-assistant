// 迭代2:自然语言生成 StorageClass YAML + 自检修正闭环。
// 模式:模型生成 → 调 submit_storageclass 工具自检(复用迭代1的 validateStorageClass)
//      → 有错就修正重提 → 直到校验通过。这是"生成→验证→修正"的 agentic 自纠错循环。
//
// 用法: npm run gen -- "用 AWS EBS CSI、保留策略、延迟绑定、允许扩容的 StorageClass,名字叫 prod-ssd"

import { config } from 'dotenv';
config({ override: true });
import { load } from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import { validateStorageClass, type ValidationError } from './validate';

const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_storageclass',
  description:
    '提交你生成的 StorageClass YAML 进行静态校验。返回错误列表(空数组表示通过)。你必须在生成 YAML 后调用本工具;若返回了错误,逐条修正后重新调用,直到校验通过。',
  input_schema: {
    type: 'object',
    properties: {
      yaml: { type: 'string', description: '完整的 StorageClass YAML 文本' },
    },
    required: ['yaml'],
  },
};

const SYSTEM_PROMPT = `你是一位 Kubernetes 专家助手。根据用户的自然语言需求,生成一个合法的 StorageClass YAML。

工作流程(必须遵守):
1. 生成 StorageClass YAML 后,必须调用 submit_storageclass 工具提交校验。
2. 若工具返回错误,逐条修正后重新调用工具,直到返回空错误列表。
3. 校验通过后,用一两句话说明你生成了什么,并把最终 YAML 用代码块展示。
4. 只生成 StorageClass 这一种资源,不要附带其他资源或解释性废话。`;

/** 校验一段 YAML 文本:先解析,再跑规则校验。解析失败也算一条错误。 */
function validateYamlText(yamlText: string): ValidationError[] {
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (e) {
    return [{ path: '', message: `YAML 解析失败: ${e instanceof Error ? e.message : String(e)}` }];
  }
  return validateStorageClass(parsed);
}

async function main(): Promise<void> {
  const requirement = process.argv.slice(2).join(' ').trim();
  if (!requirement) {
    console.error('用法: npm run gen -- "<自然语言需求>"');
    console.error('示例: npm run gen -- "用 AWS EBS CSI、保留策略、延迟绑定的 StorageClass,名字 prod-ssd"');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置(在 .env 里填入)');
    process.exit(1);
  }

  const client = new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: requirement }];

  let repairRounds = 0; // 自检发现错误、触发修正的轮数 —— 一个可量化的"自纠错"指标
  let finalValidYaml: string | null = null;

  for (let turn = 0; turn < 8; turn++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [SUBMIT_TOOL],
      messages,
    });

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === 'tool_use' && block.name === 'submit_storageclass') {
          const yamlText = String((block.input as { yaml?: unknown }).yaml ?? '');
          const errors = validateYamlText(yamlText);
          if (errors.length === 0) {
            finalValidYaml = yamlText;
            console.error('  [tool] submit_storageclass → ✅ 校验通过');
          } else {
            repairRounds++;
            console.error(`  [tool] submit_storageclass → ${errors.length} 个问题,需修正(第 ${repairRounds} 轮)`);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(errors),
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // end_turn:打印模型的最终说明 + YAML
    for (const block of resp.content) {
      if (block.type === 'text') process.stdout.write(block.text);
    }
    process.stdout.write('\n');
    break;
  }

  console.error(`\n[指标] 自检修正轮数=${repairRounds},最终是否产出合法 YAML=${finalValidYaml ? '是' : '否'}`);
}

main().catch((e: unknown) => {
  console.error('\n错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

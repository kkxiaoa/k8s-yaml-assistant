// 迭代1:校验 + Tool Use。
// 流程:读 YAML → 给模型一个 validate_storageclass 工具 → 模型主动调用它拿到结构化错误
//      → 模型用自然语言解释每个问题 + 给修复建议。
//
// 这是"手动 agentic loop":我们自己控制 tool_use → 执行 → tool_result → 继续 的循环,
// 看得最清楚(生产里也可换成 SDK 的 tool runner 自动跑)。
//
// 用法: npm run check -- examples/storageclass-invalid.yaml

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import { validateStorageClass } from './validate';

const TOOL: Anthropic.Tool = {
  name: 'validate_storageclass',
  description:
    '对当前正在审阅的 StorageClass YAML 运行静态校验,返回结构化错误列表(每项含 path 和 message,path 可用于编辑器定位)。当用户要求校验/检查 YAML 时,必须先调用本工具,再依据返回结果回答。',
  // 无入参:工具校验的是"当前这份 YAML"(由程序持有),不需要模型把 YAML 再传一遍
  input_schema: { type: 'object', properties: {} },
};

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: npm run check -- <path-to-storageclass.yaml>');
    console.error('示例: npm run check -- examples/storageclass-invalid.yaml');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置(在 .env 里填入)');
    process.exit(1);
  }

  const yamlText = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (e) {
    console.error('YAML 解析失败:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const client = new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `请校验这段 StorageClass YAML,指出所有问题并给出修复建议。\n\n\`\`\`yaml\n${yamlText}\n\`\`\``,
    },
  ];

  // 手动 agentic loop:最多转几圈,防止意外死循环
  for (let turn = 0; turn < 5; turn++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      tools: [TOOL],
      messages,
    });
    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (
          block.type === 'tool_use' &&
          block.name === 'validate_storageclass'
        ) {
          const errors = validateStorageClass(parsed);
          console.error(
            `  [tool] validate_storageclass → ${errors.length} 个问题`,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(errors),
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue; // 把工具结果喂回去,让模型继续作答
    }

    // end_turn:打印最终回答
    for (const block of resp.content) {
      if (block.type === 'text') process.stdout.write(block.text);
    }
    process.stdout.write('\n');
    return;
  }

  console.error('达到最大循环次数仍未结束。');
}

main().catch((e: unknown) => {
  console.error('\n错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

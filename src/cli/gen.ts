// 自然语言生成任意 K8s 资源 YAML + 自检修正闭环。走统一引擎 src/server/agent.ts
// (schema 驱动校验,不再是 StorageClass 专用玩具)。
//
// 用法: npm run gen -- "用 AWS EBS CSI、保留策略、延迟绑定、允许扩容的 StorageClass,名字叫 prod-ssd"

import { config } from 'dotenv';
config({ override: true });
import { getClient } from '../server/pipeline';
import { generateResource } from '../server/agent';

async function main(): Promise<void> {
  const requirement = process.argv.slice(2).join(' ').trim();
  if (!requirement) {
    console.error('用法: npm run gen -- "<自然语言需求>"');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置(在 .env 里填入)');
    process.exit(1);
  }

  const result = await generateResource(getClient(), { requirement });

  console.error('=== 诊断 ===');
  for (const d of result.diagnostics) console.error(`[${d.stage}] ${d.message}`);
  console.error(
    `\n[指标] 修复轮数=${result.rounds},产出合法 YAML=${result.yaml ? '是' : '否'}`,
  );

  if (result.yaml) {
    process.stdout.write(`\n=== 最终 YAML ===\n${result.yaml}\n`);
  } else {
    console.error('未能生成通过校验的 YAML。');
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error('\n错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

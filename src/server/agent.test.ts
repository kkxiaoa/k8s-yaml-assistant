// 生成/修复闭环单测。用桩 client(不联网、不花额度、不依赖模型是否犯错)确定性地验证:
// submit_yaml → 校验失败 → 回灌重提 → 收敛 / 到上限诚实失败。
// 运行: npm test

import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { generateResource } from './agent';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

const VALID = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`;
const INVALID = VALID.replace('replicas: 3', 'replicas: "3"'); // 类型错
const UNPARSEABLE = 'foo: [a, b'; // flow 未闭合,YAML 解析报错

/** 桩 client:按顺序吐 yamls 里的 YAML(用完取最后一个);每次都是 submit_yaml 工具调用。 */
function stubClient(yamls: string[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const yaml = yamls[Math.min(i, yamls.length - 1)]!;
        i++;
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: `t${i}`, name: 'submit_yaml', input: { yaml } },
          ],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

async function main(): Promise<void> {
  console.log('agent 生成/修复闭环:');

  await check('首发即对 → rounds=0', async () => {
    const r = await generateResource(stubClient([VALID]), { requirement: 'x' });
    assert.equal(r.rounds, 0);
    assert.ok(r.yaml !== null);
  });

  await check('非法→合法 → rounds=1 且收敛', async () => {
    const r = await generateResource(stubClient([INVALID, VALID]), {
      requirement: 'x',
    });
    assert.equal(r.rounds, 1);
    assert.ok(r.yaml !== null);
    // attempts:第一次校验失败,第二次通过
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0]!.validationOk, false);
    assert.equal(r.attempts[1]!.validationOk, true);
  });

  await check('解析失败计入 parse 阶段,随后修复收敛', async () => {
    const r = await generateResource(stubClient([UNPARSEABLE, VALID]), {
      requirement: 'x',
    });
    assert.equal(r.rounds, 1);
    assert.ok(r.yaml !== null);
    assert.equal(r.attempts[0]!.parseOk, false); // 首次提交解析失败
  });

  await check('始终非法 → 到上限诚实失败(yaml=null, rounds=2)', async () => {
    const r = await generateResource(stubClient([INVALID]), {
      requirement: 'x',
    });
    assert.equal(r.yaml, null);
    assert.equal(r.rounds, 2); // 首次 + 2 次修复后仍失败
    assert.ok(r.diagnostics.some((d) => d.message.includes('已达最大修复轮次')));
  });

  console.log(`\n通过 ${passed} 项`);
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

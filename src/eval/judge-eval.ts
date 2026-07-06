// Judge 校准(§7.2 元评估):对固化的 calibration set 跑线上裁判,比人工 label,算一致率 + 复盘分歧。
// 校准的是线上真用的 judge(共享模块),不是副本;样本来自真实 pipeline。
// 用法: npm run eval:judge  (先 npm run build:calibration 生成 calibration set)

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient } from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';

interface CalCase {
  id: string;
  category: string;
  question: string;
  context: string;
  answer: string;
  human: { faithful: boolean; note: string };
}

const CALIBRATION_PATH = join(process.cwd(), 'data', 'eval', 'judge-calibration.jsonl');
const ACCEPTABLE = 0.8; // §7.2:达标才扩大 grounding eval

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const cases = readFileSync(CALIBRATION_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CalCase);
  console.error(
    `Judge 校准(${cases.length} 条:对固化 context+answer 跑线上裁判 vs 人工 label)\n`,
  );

  const VOTES = 5; // 每条判 N 次取多数,压 LLM judge 边界噪声,得可复现判定
  let agree = 0;
  let judged = 0;
  let judgeFailed = 0;
  let unstableCount = 0; // judge N 次判定分裂(如 3:2)的条数
  const disagreements: Array<CalCase & { judge: boolean; reason: string }> = [];

  for (const c of cases) {
    const votes: boolean[] = [];
    let lastReason = '';
    for (let i = 0; i < VOTES; i++) {
      const v = await judge(client, c.context, c.answer);
      if (v) {
        votes.push(v.faithful);
        if (!v.faithful) lastReason = v.reason;
      }
    }
    if (votes.length === 0) {
      judgeFailed++;
      console.error(`⚠ 判定失败 ${c.id}`);
      continue;
    }
    judged++;
    const trueN = votes.filter(Boolean).length;
    const judgeFaithful = trueN * 2 > votes.length; // 多数
    const unstable = trueN > 0 && trueN < votes.length; // N 次判定分裂 = judge 自己不稳
    if (unstable) unstableCount++;
    const match = judgeFaithful === c.human.faithful;
    if (match) agree++;
    else disagreements.push({ ...c, judge: judgeFaithful, reason: lastReason });
    console.error(
      `${match ? '✓一致' : '✗分歧'} ${c.id.padEnd(28)} human=${c.human.faithful} judge=${judgeFaithful}(${trueN}/${votes.length})${unstable ? ' ⚠不稳' : ''}  [${c.category}]`,
    );
  }

  const rate = judged ? agree / judged : 0;
  console.error('\n━━━━━━ 汇总 ━━━━━━');
  console.error(`一致率 = ${(rate * 100).toFixed(1)}%  (${agree}/${judged})`);
  console.error(`判定失败(不计入)= ${judgeFailed} 条  |  裁判=${JUDGE_MODEL}`);
  console.error(
    `judge 内部不稳定(${VOTES} 次判定分裂)= ${unstableCount} 条  ← 这些是 judge 自身对该 case 就拿不准`,
  );

  if (disagreements.length) {
    console.error('\n分歧复盘(§7.4):');
    for (const d of disagreements) {
      console.error(`\n▸ ${d.id} [${d.category}]  human=${d.human.faithful} vs judge=${d.judge}`);
      console.error(`  human 依据: ${d.human.note}`);
      console.error(`  judge 理由: ${d.reason}`);
    }
  }
  console.error(
    rate >= ACCEPTABLE
      ? `\n裁判一致率 ≥ ${ACCEPTABLE * 100}%,可接受,方可扩大 grounding eval(§7.2)。`
      : `\n一致率 < ${ACCEPTABLE * 100}%,先复盘/修裁判再用。`,
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

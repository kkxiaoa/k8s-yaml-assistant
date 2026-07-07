// Judge 校准(§7.2 元评估):对固化的 calibration set 跑线上裁判,比人工 label,算一致率 + 复盘分歧。
// 校准的是线上真用的 judge(共享模块),不是副本;样本来自真实 pipeline。
// 用法: npm run eval:judge  (先 npm run build:calibration 生成 calibration set)

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient } from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';

type PolicyDimension =
  | 'distinguished'
  | 'conflictExplained'
  | 'misstatedAsOfficial';

interface CalCase {
  id: string;
  category: string;
  question: string;
  context: string;
  answer: string;
  human: {
    faithful: boolean;
    policy?: Partial<Record<PolicyDimension, boolean>>;
    note: string;
  };
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
  const policyStats: Record<
    PolicyDimension,
    { total: number; agree: number; missing: number; unstable: number }
  > = {
    distinguished: { total: 0, agree: 0, missing: 0, unstable: 0 },
    conflictExplained: { total: 0, agree: 0, missing: 0, unstable: 0 },
    misstatedAsOfficial: { total: 0, agree: 0, missing: 0, unstable: 0 },
  };
  const policyDisagreements: Array<{
    id: string;
    dimension: PolicyDimension;
    human: boolean;
    judge: boolean | null;
    note: string;
  }> = [];

  for (const c of cases) {
    const votes: boolean[] = [];
    const policyVotes: Record<PolicyDimension, boolean[]> = {
      distinguished: [],
      conflictExplained: [],
      misstatedAsOfficial: [],
    };
    let lastReason = '';
    for (let i = 0; i < VOTES; i++) {
      const v = await judge(client, c.context, c.answer);
      if (v) {
        votes.push(v.faithful);
        for (const dim of Object.keys(policyVotes) as PolicyDimension[]) {
          const value = v.policy?.[dim];
          if (typeof value === 'boolean') policyVotes[dim].push(value);
        }
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

    const policyMarks: string[] = [];
    for (const dim of Object.keys(policyStats) as PolicyDimension[]) {
      const expected = c.human.policy?.[dim];
      if (typeof expected !== 'boolean') continue;

      const stat = policyStats[dim];
      stat.total++;
      const dimVotes = policyVotes[dim];
      if (dimVotes.length === 0) {
        stat.missing++;
        policyDisagreements.push({
          id: c.id,
          dimension: dim,
          human: expected,
          judge: null,
          note: c.human.note,
        });
        policyMarks.push(`${dim}=missing`);
        continue;
      }

      const trueDimN = dimVotes.filter(Boolean).length;
      const judgeValue = trueDimN * 2 > dimVotes.length;
      const dimUnstable = trueDimN > 0 && trueDimN < dimVotes.length;
      if (dimUnstable) stat.unstable++;
      if (judgeValue === expected) stat.agree++;
      else {
        policyDisagreements.push({
          id: c.id,
          dimension: dim,
          human: expected,
          judge: judgeValue,
          note: c.human.note,
        });
      }
      policyMarks.push(
        `${dim}=${judgeValue === expected ? '✓' : '✗'}(${trueDimN}/${dimVotes.length})${dimUnstable ? '⚠' : ''}`,
      );
    }

    console.error(
      `${match ? '✓一致' : '✗分歧'} ${c.id.padEnd(28)} human=${c.human.faithful} judge=${judgeFaithful}(${trueN}/${votes.length})${unstable ? ' ⚠不稳' : ''}  [${c.category}]${policyMarks.length ? ` policy: ${policyMarks.join(' ')}` : ''}`,
    );
  }

  const rate = judged ? agree / judged : 0;
  console.error('\n━━━━━━ 汇总 ━━━━━━');
  console.error(`一致率 = ${(rate * 100).toFixed(1)}%  (${agree}/${judged})`);
  console.error(`判定失败(不计入)= ${judgeFailed} 条  |  裁判=${JUDGE_MODEL}`);
  console.error(
    `judge 内部不稳定(${VOTES} 次判定分裂)= ${unstableCount} 条  ← 这些是 judge 自身对该 case 就拿不准`,
  );
  console.error('\npolicy 维度一致率(只统计 human.policy 明确标注的维度):');
  for (const dim of Object.keys(policyStats) as PolicyDimension[]) {
    const s = policyStats[dim];
    const judgedPolicy = s.total - s.missing;
    const rate = judgedPolicy ? (s.agree / judgedPolicy) * 100 : null;
    console.error(
      `- ${dim}: ${rate === null ? 'N/A' : `${rate.toFixed(1)}%`} (${s.agree}/${judgedPolicy}, missing=${s.missing}, unstable=${s.unstable})`,
    );
  }

  if (disagreements.length) {
    console.error('\n分歧复盘(§7.4):');
    for (const d of disagreements) {
      console.error(`\n▸ ${d.id} [${d.category}]  human=${d.human.faithful} vs judge=${d.judge}`);
      console.error(`  human 依据: ${d.human.note}`);
      console.error(`  judge 理由: ${d.reason}`);
    }
  }
  if (policyDisagreements.length) {
    console.error('\npolicy 维度分歧复盘:');
    for (const d of policyDisagreements) {
      console.error(
        `\n▸ ${d.id} ${d.dimension} human=${d.human} vs judge=${d.judge ?? 'missing'}`,
      );
      console.error(`  human 依据: ${d.note}`);
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

// Judge 校准(§7.2 元评估):对固化的 calibration set 跑线上裁判,比人工 label,算一致率 + 复盘分歧。
// 校准的是线上真用的 judge(共享模块),不是副本;样本来自真实 pipeline。
// 用法: npm run eval:judge  (先 npm run build:calibration 生成 calibration set)

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClient } from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';
import { tracePathForRun, appendJsonl } from './artifacts';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationHash,
  computeJudgeCalibrationMetrics,
  judgeMetricsRecord,
  POLICY_DIMENSIONS,
  type JudgeCalibrationCase,
  type JudgeCalibrationTrace,
  type JudgeVote,
} from './metrics/judge-metrics';
import { writeRun, type EvalRun } from './run-store';

const CALIBRATION_PATH = join(process.cwd(), 'data', 'eval', 'judge-calibration.jsonl');
const ACCEPTABLE = 0.8; // §7.2:达标才扩大 grounding eval
const VOTES = 5; // 每条判 N 次取多数,降低 judge 边界噪声。

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const cases = readFileSync(CALIBRATION_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JudgeCalibrationCase);
  console.error(
    `Judge 校准(${cases.length} 条:对固化 context+answer 跑线上裁判 vs 人工 label)\n`,
  );

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-judge`;
  const tracePath = tracePathForRun(id, 'judge');
  const traces: JudgeCalibrationTrace[] = [];

  for (const c of cases) {
    const votes: JudgeVote[] = [];
    for (let i = 0; i < VOTES; i++) {
      const v = await judge(client, c.context, c.answer);
      if (v) {
        votes.push({
          faithful: v.faithful,
          unsupported: v.unsupported,
          reason: v.reason,
          policy: v.policy,
        });
      }
    }
    const trace = buildJudgeCalibrationTrace({
      calibrationCase: c,
      votes,
    });
    traces.push(trace);
    appendJsonl(tracePath, trace);

    if (trace.majority.faithful === null) {
      console.error(`⚠ 判定失败 ${c.id}`);
      continue;
    }
    const policyMarks: string[] = [];
    for (const dim of POLICY_DIMENSIONS) {
      const result = trace.policy[dim];
      if (!result) continue;
      if (result.missing) policyMarks.push(`${dim}=missing`);
      else {
        policyMarks.push(
          `${dim}=${result.agree ? '✓' : '✗'}(${result.trueVotes}/${result.totalVotes})${result.unstable ? '⚠' : ''}`,
        );
      }
    }

    console.error(
      `${trace.majority.agree ? '✓一致' : '✗分歧'} ${c.id.padEnd(28)} human=${c.human.faithful} judge=${trace.majority.faithful}(${trace.majority.trueVotes}/${trace.majority.totalVotes})${trace.majority.unstable ? ' ⚠不稳' : ''}  [${c.category}]${policyMarks.length ? ` policy: ${policyMarks.join(' ')}` : ''}`,
    );
  }

  const metrics = computeJudgeCalibrationMetrics(traces);
  console.error('\n━━━━━━ 汇总 ━━━━━━');
  console.error(
    `一致率 = ${(metrics.agreementRate * 100).toFixed(1)}%  (${metrics.agree}/${metrics.judged})`,
  );
  console.error(`判定失败(不计入)= ${metrics.judgeFailed} 条  |  裁判=${JUDGE_MODEL}`);
  console.error(
    `judge 内部不稳定(${VOTES} 次判定分裂)= ${metrics.unstableCount} 条  ← 这些是 judge 自身对该 case 就拿不准`,
  );
  console.error('\npolicy 维度一致率(只统计 human.policy 明确标注的维度):');
  for (const dim of POLICY_DIMENSIONS) {
    const s = metrics.policy[dim];
    const rate =
      s.agreementRate === null ? null : s.agreementRate * 100;
    console.error(
      `- ${dim}: ${rate === null ? 'N/A' : `${rate.toFixed(1)}%`} (${s.agree}/${s.judged}, missing=${s.missing}, unstable=${s.unstable})`,
    );
  }

  const disagreements = traces.filter(
    (trace) => trace.majority.agree === false,
  );
  if (disagreements.length) {
    console.error('\n分歧复盘(§7.4):');
    for (const d of disagreements) {
      const judgeReason = [...d.votes]
        .reverse()
        .find((vote) => !vote.faithful)?.reason ?? '';
      console.error(`\n▸ ${d.id} [${d.category}]  human=${d.human.faithful} vs judge=${d.majority.faithful}`);
      console.error(`  human 依据: ${d.human.note}`);
      console.error(`  judge 理由: ${judgeReason}`);
    }
  }
  const policyDisagreements = traces.flatMap((trace) =>
    POLICY_DIMENSIONS.flatMap((dim) => {
      const result = trace.policy[dim];
      return result && !result.agree
        ? [{ trace, dim, result }]
        : [];
    }),
  );
  if (policyDisagreements.length) {
    console.error('\npolicy 维度分歧复盘:');
    for (const { trace, dim, result } of policyDisagreements) {
      console.error(
        `\n▸ ${trace.id} ${dim} human=${result.human} vs judge=${result.judge ?? 'missing'}`,
      );
      console.error(`  human 依据: ${trace.human.note}`);
    }
  }

  const run: EvalRun = {
    id,
    kind: 'judge',
    createdAt: new Date().toISOString(),
    artifactPaths: { tracePath },
    scope: 'calibration',
    caseIds: cases.map((c) => c.id),
    evalSetHash: computeJudgeCalibrationHash(cases),
    judgeModel: JUDGE_MODEL,
    k: VOTES,
    metrics: judgeMetricsRecord(metrics),
  };
  const runPath = writeRun(run);
  console.error(`\n逐条 trace → ${tracePath}\n汇总 run → ${runPath}`);
  console.error(
    metrics.agreementRate >= ACCEPTABLE
      ? `\n裁判一致率 ≥ ${ACCEPTABLE * 100}%,可接受,方可扩大 grounding eval(§7.2)。`
      : `\n一致率 < ${ACCEPTABLE * 100}%,先复盘/修裁判再用。`,
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

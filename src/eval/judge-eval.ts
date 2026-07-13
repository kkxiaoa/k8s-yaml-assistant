// Judge 校准(§7.2 元评估):对固化的 calibration set 跑线上裁判,比人工 label,算一致率 + 复盘分歧。
// 用法: npm run eval:judge  (先 npm run build:calibration 生成 calibration set)

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge, JUDGE_MODEL } from './judge';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationMetrics,
  judgeMetricsRecord,
  POLICY_DIMENSIONS,
  type JudgeCalibrationCase,
  type JudgeCalibrationTrace,
  type JudgeVote,
} from './metrics/judge-metrics';
import {
  JUDGE_CALIBRATION_VOTES,
  LEGACY_METRIC_DEFINITION_VERSION,
  isDirectExecution,
  judgeDatasetIdentity,
  judgeEnvelopeOutcome,
  judgeEvalConfig,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
} from './run-session';

const CALIBRATION_PATH = join(
  process.cwd(),
  'data',
  'eval',
  'judge-calibration.jsonl',
);
const ACCEPTABLE = 0.8;

function readCalibrationCases(): JudgeCalibrationCase[] {
  return readFileSync(CALIBRATION_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeCalibrationCase);
}

async function main(): Promise<void> {
  const cases = readCalibrationCases();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-judge`;
  const session = startEvalRun({
    id: runId,
    kind: 'judge',
    scope: 'calibration',
    dataset: judgeDatasetIdentity(cases),
    metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
    config: judgeEvalConfig(JUDGE_CALIBRATION_VOTES),
  });
  let stage = 'initialize';
  let completed = false;

  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY 未设置');
    }
    const { getClient } = await import('../server/pipeline');
    const client = getClient();
    console.error(
      `Judge 校准(${cases.length} 条:对固化 context+answer 跑线上裁判 vs 人工 label)\n`,
    );

    const traces: JudgeCalibrationTrace[] = [];
    for (const calibrationCase of cases) {
      const votes: JudgeVote[] = [];
      stage = `case:${calibrationCase.id}:judge`;
      try {
        for (let index = 0; index < JUDGE_CALIBRATION_VOTES; index++) {
          const verdict = await judge(
            client,
            calibrationCase.context,
            calibrationCase.answer,
          );
          if (verdict) {
            votes.push({
              faithful: verdict.faithful,
              unsupported: verdict.unsupported,
              reason: verdict.reason,
              policy: verdict.policy,
            });
          }
        }
      } catch (error) {
        const partialTrace = buildJudgeCalibrationTrace({
          calibrationCase,
          votes,
        });
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: calibrationCase.id,
            kind: 'judge',
            payload: toPersistedPayload(partialTrace),
            stage,
            error,
          }),
        );
        throw error;
      }

      const trace = buildJudgeCalibrationTrace({ calibrationCase, votes });
      traces.push(trace);
      session.appendCase(
        createTraceEnvelope({
          runId,
          evalCaseId: calibrationCase.id,
          kind: 'judge',
          outcome: judgeEnvelopeOutcome(trace),
          payload: toPersistedPayload(trace),
        }),
      );

      if (trace.majority.faithful === null) {
        console.error(`⚠ 判定失败 ${calibrationCase.id}`);
        continue;
      }
      const policyMarks: string[] = [];
      for (const dimension of POLICY_DIMENSIONS) {
        const result = trace.policy[dimension];
        if (!result) continue;
        if (result.missing) policyMarks.push(`${dimension}=missing`);
        else {
          policyMarks.push(
            `${dimension}=${result.agree ? '✓' : '✗'}(${result.trueVotes}/${result.totalVotes})${result.unstable ? '⚠' : ''}`,
          );
        }
      }

      console.error(
        `${trace.majority.agree ? '✓一致' : '✗分歧'} ${calibrationCase.id.padEnd(28)} human=${calibrationCase.human.faithful} judge=${trace.majority.faithful}(${trace.majority.trueVotes}/${trace.majority.totalVotes})${trace.majority.unstable ? ' ⚠不稳' : ''}  [${calibrationCase.category}]${policyMarks.length ? ` policy: ${policyMarks.join(' ')}` : ''}`,
      );
    }

    const metrics = computeJudgeCalibrationMetrics(traces);
    console.error('\n━━━━━━ 汇总 ━━━━━━');
    console.error(
      `一致率 = ${(metrics.agreementRate * 100).toFixed(1)}%  (${metrics.agree}/${metrics.judged})`,
    );
    console.error(
      `判定失败(不计入)= ${metrics.judgeFailed} 条  |  裁判=${JUDGE_MODEL}`,
    );
    console.error(
      `judge 内部不稳定(${JUDGE_CALIBRATION_VOTES} 次判定分裂)= ${metrics.unstableCount} 条  ← 这些是 judge 自身对该 case 就拿不准`,
    );
    console.error('\npolicy 维度一致率(只统计 human.policy 明确标注的维度):');
    for (const dimension of POLICY_DIMENSIONS) {
      const summary = metrics.policy[dimension];
      const rate =
        summary.agreementRate === null
          ? null
          : summary.agreementRate * 100;
      console.error(
        `- ${dimension}: ${rate === null ? 'N/A' : `${rate.toFixed(1)}%`} (${summary.agree}/${summary.judged}, missing=${summary.missing}, unstable=${summary.unstable})`,
      );
    }

    const disagreements = traces.filter(
      (trace) => trace.majority.agree === false,
    );
    if (disagreements.length) {
      console.error('\n分歧复盘(§7.4):');
      for (const disagreement of disagreements) {
        const judgeReason =
          [...disagreement.votes]
            .reverse()
            .find((vote) => !vote.faithful)?.reason ?? '';
        console.error(
          `\n▸ ${disagreement.id} [${disagreement.category}]  human=${disagreement.human.faithful} vs judge=${disagreement.majority.faithful}`,
        );
        console.error(`  human 依据: ${disagreement.human.note}`);
        console.error(`  judge 理由: ${judgeReason}`);
      }
    }

    const policyDisagreements = traces.flatMap((trace) =>
      POLICY_DIMENSIONS.flatMap((dimension) => {
        const result = trace.policy[dimension];
        return result && !result.agree ? [{ trace, dimension, result }] : [];
      }),
    );
    if (policyDisagreements.length) {
      console.error('\npolicy 维度分歧复盘:');
      for (const { trace, dimension, result } of policyDisagreements) {
        console.error(
          `\n▸ ${trace.id} ${dimension} human=${result.human} vs judge=${result.judge ?? 'missing'}`,
        );
        console.error(`  human 依据: ${trace.human.note}`);
      }
    }

    stage = 'complete';
    session.complete(judgeMetricsRecord(metrics));
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'judge'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      metrics.agreementRate >= ACCEPTABLE
        ? `\n裁判一致率 ≥ ${ACCEPTABLE * 100}%,可接受,方可扩大 grounding eval(§7.2)。`
        : `\n一致率 < ${ACCEPTABLE * 100}%,先复盘/修裁判再用。`,
    );
  } catch (error) {
    if (!completed) session.fail(stage, error);
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  config({ override: true });
  main().catch((error: unknown) => {
    console.error('错误:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

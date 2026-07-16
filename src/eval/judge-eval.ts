// Judge 校准(§7.2 元评估):对固化的 calibration set 跑线上裁判,比人工 label,算一致率 + 复盘分歧。
// 用法: npm run eval:judge  (先 npm run build:calibration 生成 calibration set)

import type Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeOnce, JUDGE_MODEL } from './judge';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import {
  buildJudgeCalibrationTrace,
  computeJudgeCalibrationMetrics,
  judgeMetricsRecord,
  parseJudgeCalibrationCasesJsonl,
  POLICY_DIMENSIONS,
  type JudgeCalibrationCase,
  type JudgeCalibrationTrace,
} from './metrics/judge-metrics';
import { JudgeAttemptSchema, type JudgeAttempt } from './judge-votes';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import {
  JUDGE_CALIBRATION_VOTES,
  harnessErrorMetrics,
  isDirectExecution,
  judgeDatasetIdentity,
  judgeEnvelopeOutcome,
  judgeEvalConfig,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  executeEvalCaseStage,
  executeEvalCases,
  executeEvalRunStage,
  failEvalRunSession,
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
  return parseJudgeCalibrationCasesJsonl(
    readFileSync(CALIBRATION_PATH, 'utf8'),
  );
}

function judgeErrorPayload(
  calibrationCase: JudgeCalibrationCase,
  attempts: readonly JudgeAttempt[],
  plannedVotes: number,
) {
  return { calibrationCase, attempts, plannedVotes };
}

async function evaluateCalibrationCase(
  client: Anthropic,
  calibrationCase: JudgeCalibrationCase,
  plannedVotes: number,
): Promise<JudgeCalibrationTrace> {
  const attempts: JudgeAttempt[] = [];
  for (let index = 0; index < plannedVotes; index++) {
    const rawAttempt = await executeEvalCaseStage(
      'judge_request',
      () => judgeOnce(client, calibrationCase.context, calibrationCase.answer),
      judgeErrorPayload(calibrationCase, attempts, plannedVotes),
    );
    const attempt = await executeEvalCaseStage(
      'judge_parse',
      () => JudgeAttemptSchema.parse(rawAttempt),
      judgeErrorPayload(calibrationCase, attempts, plannedVotes),
    );
    attempts.push(attempt);
  }

  return executeEvalCaseStage(
    'judge_quorum',
    () =>
      buildJudgeCalibrationTrace({
        calibrationCase,
        attempts,
        plannedVotes,
      }),
    judgeErrorPayload(calibrationCase, attempts, plannedVotes),
  );
}

function reportJudgeCase(trace: JudgeCalibrationTrace): void {
  if (trace.majority.faithful === null) {
    console.error(
      `⚠ 不可判定 ${trace.id} (${trace.majority.indeterminateReason}, valid=${trace.majority.validVotes}/${trace.majority.quorum}, invalid=${trace.attempts.invalid}, error=${trace.attempts.error})`,
    );
    return;
  }

  const policyMarks: string[] = [];
  for (const dimension of POLICY_DIMENSIONS) {
    const result = trace.policy[dimension];
    if (!result) continue;
    if (result.judge === null) {
      policyMarks.push(
        `${dimension}=${result.indeterminateReason}(${result.validVotes}/${result.quorum})`,
      );
    } else {
      policyMarks.push(
        `${dimension}=${result.agree ? '✓' : '✗'}(${result.trueVotes}/${result.validVotes})${result.unstable ? '⚠' : ''}`,
      );
    }
  }

  console.error(
    `${trace.majority.agree ? '✓一致' : '✗分歧'} ${trace.id.padEnd(28)} human=${trace.human.faithful} judge=${trace.majority.faithful}(${trace.majority.trueVotes}/${trace.majority.validVotes})${trace.majority.unstable ? ' ⚠不稳' : ''}  [${trace.category}]${policyMarks.length ? ` policy: ${policyMarks.join(' ')}` : ''}`,
  );
}

function reportDisagreements(traces: readonly JudgeCalibrationTrace[]): void {
  const disagreements = traces.filter(
    (trace) => trace.majority.agree === false,
  );
  if (disagreements.length) {
    console.error('\n分歧复盘(§7.4):');
    for (const disagreement of disagreements) {
      const judgeReason = [...disagreement.attempts.items]
        .reverse()
        .find(
          (attempt) => attempt.status === 'valid' && !attempt.vote.faithful,
        );
      console.error(
        `\n▸ ${disagreement.id} [${disagreement.category}]  human=${disagreement.human.faithful} vs judge=${disagreement.majority.faithful}`,
      );
      console.error(`  human 依据: ${disagreement.human.note}`);
      console.error(
        `  judge 理由: ${judgeReason?.status === 'valid' ? judgeReason.vote.reason : ''}`,
      );
    }
  }

  const policyDisagreements = traces.flatMap((trace) =>
    POLICY_DIMENSIONS.flatMap((dimension) => {
      const result = trace.policy[dimension];
      return result?.agree === false ? [{ trace, dimension, result }] : [];
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
}

async function main(): Promise<void> {
  const setup = await executeEvalRunStage('dataset_preflight', () => {
    const cases = readCalibrationCases();
    return { cases, dataset: judgeDatasetIdentity(cases) };
  });
  const { cases } = setup;
  const runConfig = judgeEvalConfig(JUDGE_CALIBRATION_VOTES);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-judge`;
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'judge',
      scope: 'calibration',
      dataset: setup.dataset,
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      config: runConfig,
    }),
  );
  let completed = false;

  try {
    const client = await executeEvalRunStage(
      'runner_initialization',
      async () => {
        if (!process.env.DEEPSEEK_API_KEY) {
          throw new Error('DEEPSEEK_API_KEY 未设置');
        }
        const { getClient } = await import('../server/pipeline');
        return getClient();
      },
    );
    console.error(
      `Judge 校准(${cases.length} 条:对固化 context+answer 跑线上裁判 vs 人工 label)\n`,
    );

    const batch = await executeEvalCases({
      cases,
      evaluate: (calibrationCase) =>
        evaluateCalibrationCase(
          client,
          calibrationCase,
          runConfig.voteCount,
        ),
      appendSuccess: (calibrationCase, trace) => {
        session.appendCase(
          createTraceEnvelope({
            runId,
            evalCaseId: calibrationCase.id,
            kind: 'judge',
            outcome: judgeEnvelopeOutcome(trace),
            payload: trace,
          }),
        );
      },
      appendError: (calibrationCase, failure) => {
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: calibrationCase.id,
            kind: 'judge',
            payload:
              failure.payload ??
              judgeErrorPayload(
                calibrationCase,
                [],
                runConfig.voteCount,
              ),
            stage: failure.stage,
            error: failure.originalError,
          }),
        );
        console.error(
          `⚠ harness error [${failure.stage}] ${calibrationCase.id}`,
        );
      },
    });

    for (const trace of batch.results) reportJudgeCase(trace);

    const metrics = await executeEvalRunStage('metric_aggregation', () =>
      computeJudgeCalibrationMetrics(batch.results),
    );
    console.error('\n━━━━━━ 汇总 ━━━━━━');
    console.error(
      `一致率 = ${metrics.agreementRate === null ? 'N/A' : `${(metrics.agreementRate * 100).toFixed(1)}%`}  (${metrics.agree}/${metrics.judged})`,
    );
    console.error(
      `quality fail/disagreement=${metrics.judged - metrics.agree} 条`,
    );
    console.error(
      `judge indeterminate=${metrics.judgeFailed} 条  | attempts planned=${metrics.attempts.planned}, valid=${metrics.attempts.valid}, invalid=${metrics.attempts.invalid}, error=${metrics.attempts.error} | 裁判=${JUDGE_MODEL}`,
    );
    console.error(
      `harness error=${batch.harnessErrors.length} 条；质量分母=${metrics.judged}；已完成 case=${batch.results.length}/${cases.length}`,
    );
    console.error(
      `judge 内部不稳定(${JUDGE_CALIBRATION_VOTES} 次判定分裂)= ${metrics.unstableCount} 条`,
    );
    console.error('\npolicy 维度一致率(只统计 human.policy 明确标注的维度):');
    for (const dimension of POLICY_DIMENSIONS) {
      const summary = metrics.policy[dimension];
      const rate =
        summary.agreementRate === null
          ? null
          : summary.agreementRate * 100;
      console.error(
        `- ${dimension}: ${rate === null ? 'N/A' : `${rate.toFixed(1)}%`} (${summary.agree}/${summary.judged}, indeterminate=${summary.indeterminate}, unstable=${summary.unstable})`,
      );
    }

    reportDisagreements(batch.results);

    const metricRecord = await executeEvalRunStage(
      'metric_aggregation',
      () => ({
        ...judgeMetricsRecord(metrics),
        ...harnessErrorMetrics('judge', batch.harnessErrors.length),
      }),
    );
    await executeEvalRunStage('artifact_write', () =>
      session.complete(metricRecord),
    );
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'judge'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      metrics.agreementRate === null
        ? '\n裁判一致率为 N/A,没有可用于阈值判断的有效 case。'
        : metrics.agreementRate >= ACCEPTABLE
          ? `\n裁判一致率 ≥ ${ACCEPTABLE * 100}%,可接受,方可扩大 grounding eval(§7.2)。`
          : `\n一致率 < ${ACCEPTABLE * 100}%,先复盘/修裁判再用。`,
    );
  } catch (error) {
    if (!completed) failEvalRunSession(session, error);
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

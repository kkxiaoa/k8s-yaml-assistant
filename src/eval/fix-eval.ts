import { config } from 'dotenv';
import { fixResource } from '../server/agent';
import { preflightFixCases } from './assertions';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import { FIX_CASES } from './cases/fix-cases';
import {
  buildFixCaseResult,
  computeFixEvalMetrics,
  fixMetricsRecord,
  type FixCaseResult,
} from './metrics/generation-metrics';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import { ratioObservation } from './protocol';
import {
  fixDatasetIdentity,
  fixEnvelopeOutcome,
  fixEvalConfig,
  generatedResultEvaluationStage,
  harnessErrorMetrics,
  isDirectExecution,
  toPersistedPayload,
} from './runner-protocol';
import {
  EvalRunExecutionError,
  createErrorTraceEnvelope,
  createTraceEnvelope,
  executeEvalCaseStage,
  executeEvalCases,
  executeEvalRunStage,
  failEvalRunSession,
  startEvalRun,
} from './run-session';

function countRate(value: number, denominator: number): string {
  const rate = ratioObservation(value, denominator).value;
  return rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`;
}

function average(value: number, denominator: number): string {
  const result = ratioObservation(value, denominator).value;
  return result === null ? 'N/A' : result.toFixed(2);
}

function reportFixCase(result: FixCaseResult): void {
  const mark = result.contentPass ? '✓' : result.validYaml ? '△' : '✗';
  console.error(
    `${mark} ${result.id.padEnd(24)} [${result.defectType}] 提交${result.submitCount} 轮${result.rounds} target=${result.targetMatch.status} correction=${result.correctionPassCount}/${result.correctionTotal} preserve=${result.preservePassCount}/${result.preserveTotal} sideEffect=${result.sideEffectFree ? 'none' : result.resourceSet.reason}${result.validYaml ? '' : '  未修成合法 YAML'}`,
  );
}

async function main(): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-fix`;
  const setup = await executeEvalRunStage('dataset_preflight', () => ({
    dataset: fixDatasetIdentity(),
    config: fixEvalConfig(),
  }));
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'fix',
      scope: 'full',
      dataset: setup.dataset,
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      config: setup.config,
    }),
  );
  let completed = false;

  try {
    const fixturesById = await executeEvalRunStage('dataset_preflight', () => {
      const fixtures = preflightFixCases(FIX_CASES);
      const byId = new Map(
        fixtures.map((fixture) => [fixture.caseId, fixture] as const),
      );
      for (const evalCase of FIX_CASES) {
        if (!byId.has(evalCase.id)) {
          throw new Error(`missing preflight result for ${evalCase.id}`);
        }
      }
      return byId;
    });
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
    console.error(`fix 评估(${FIX_CASES.length} 条坏 YAML,逐条调 DeepSeek,稍候…)\n`);

    const batch = await executeEvalCases({
      cases: FIX_CASES,
      evaluate: async (evalCase) => {
        const fixture = fixturesById.get(evalCase.id);
        if (!fixture) {
          throw new EvalRunExecutionError(
            'dataset_preflight',
            new Error(`missing preflight result for ${evalCase.id}`),
          );
        }
        const fixed = await executeEvalCaseStage(
          'answer_model',
          () =>
            fixResource(
              client,
              evalCase.brokenYaml,
              fixture.validationErrors,
            ),
          { evalCase },
        );
        return executeEvalCaseStage(
          generatedResultEvaluationStage(fixed),
          () => buildFixCaseResult(evalCase, fixed, fixture),
          { evalCase },
        );
      },
      appendSuccess: (evalCase, result) => {
        session.appendCase(
          createTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'fix',
            outcome: fixEnvelopeOutcome(result),
            payload: toPersistedPayload(result),
          }),
        );
      },
      appendError: (evalCase, failure) => {
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'fix',
            payload: failure.payload ?? { evalCase },
            stage: failure.stage,
            error: failure.originalError,
          }),
        );
        console.error(`⚠ harness error [${failure.stage}] ${evalCase.id}`);
      },
    });

    for (const result of batch.results) reportFixCase(result);

    const metrics = await executeEvalRunStage('metric_aggregation', () =>
      computeFixEvalMetrics(batch.results),
    );
    const stats = metrics.attemptStats;

    console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
    console.error(
      `首轮 parse 成功率      : ${countRate(stats.firstParseOkCount, stats.caseCount)}`,
    );
    console.error(
      `首轮修复即通过率       : ${countRate(stats.firstValidationOkCount, stats.caseCount)}`,
    );
    console.error(
      `触发再修复率           : ${countRate(stats.repairAttemptedCount, stats.caseCount)}`,
    );
    console.error(
      `再修复成功率           : ${countRate(stats.repairSuccessAfterFailCount, stats.failedFirstCount)}  (${stats.failedFirstCount} 例首轮未修好)`,
    );
    console.error(
      `达上限仍失败率         : ${countRate(stats.maxRoundFailureCount, stats.caseCount)}`,
    );
    console.error(
      `平均提交次数 / 平均轮数: ${average(stats.submitCount, stats.caseCount)} / ${average(stats.roundCount, stats.caseCount)}`,
    );

    console.error('\n━━━━━━ 修复质量 汇总 ━━━━━━');
    console.error(
      `合法 YAML            : ${countRate(metrics.validYamlCount, metrics.caseCount)}  (${metrics.validYamlCount}/${metrics.caseCount})`,
    );
    console.error(
      `预期修正通过率       : ${countRate(metrics.correctionPassCount, metrics.caseCount)}  (${metrics.correctionPassCount}/${metrics.caseCount})`,
    );
    console.error(
      `保留断言通过率       : ${countRate(metrics.preservePassCount, metrics.caseCount)}  (${metrics.preservePassCount}/${metrics.caseCount})`,
    );
    console.error(
      `无资源副作用通过率   : ${countRate(metrics.sideEffectFreePassCount, metrics.caseCount)}  (${metrics.sideEffectFreePassCount}/${metrics.caseCount})`,
    );
    console.error(
      `完整修复通过率       : ${countRate(metrics.contentPassCount, metrics.caseCount)}  (${metrics.contentPassCount}/${metrics.caseCount})`,
    );
    console.error(
      `quality fail=${metrics.caseCount - metrics.contentPassCount} 条；skipped=0 条；harness error=${batch.harnessErrors.length} 条；质量样本=${metrics.caseCount}/${FIX_CASES.length}`,
    );

    console.error('\n━━━━━━ 按缺陷类型:修复成功率 ━━━━━━');
    for (const [type, value] of Object.entries(metrics.byDefectType).sort()) {
      console.error(
        `${type.padEnd(18)} : ${countRate(value.fixed, value.total)}  (${value.fixed}/${value.total})`,
      );
    }

    const metricRecord = await executeEvalRunStage(
      'metric_aggregation',
      () => ({
        ...fixMetricsRecord(metrics),
        ...harnessErrorMetrics('fix', batch.harnessErrors.length),
      }),
    );
    await executeEvalRunStage('artifact_write', () =>
      session.complete(metricRecord),
    );
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'fix'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      '\n说明:多轮行为基于 attempts;△=YAML 合法但目标、修正、保留或资源集合未完整通过。',
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

// 生成评估会调用生成模型，并验证合法 YAML、资源断言和跨资源关系。

import { config } from 'dotenv';
import { generateResource } from '../server/agent';
import { assertGenerationCasesContract } from './assertions';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import { GENERATION_CASES } from './cases/generation-cases';
import {
  buildGenerationCaseResult,
  computeGenerationEvalMetrics,
  generationMetricsRecord,
  type GenerationCaseResult,
} from './metrics/generation-metrics';
import {
  LEGACY_METRIC_DEFINITION_VERSION,
  generationDatasetIdentity,
  generationEnvelopeOutcome,
  generationEvalConfig,
  generatedResultEvaluationStage,
  harnessErrorMetrics,
  isDirectExecution,
  toPersistedPayload,
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

function percentage(value: number, measured: boolean): string {
  return measured ? `${(value * 100).toFixed(1)}%` : 'N/A';
}

function countRate(value: number, denominator: number): string {
  return denominator
    ? `${((value / denominator) * 100).toFixed(1)}%`
    : 'N/A';
}

function reportGenerationCase(result: GenerationCaseResult): void {
  const relations = result.relationResults.length
    ? ' 关系=' +
      result.relationResults
        .map(
          (item) =>
            `${item.relation.type.split('_')[0]}:${item.pass ? '✓' : '✗'}`,
        )
        .join(' ')
    : '';
  const mark = result.validYaml ? (result.contentPass ? '✓' : '△') : '✗';
  console.error(
    `${mark} ${result.id.padEnd(24)} 轮${result.rounds} 资源=${result.matchedResourceCount}/${result.expectedResourceCount} 断言=${result.resourceAssertionPassCount}/${result.resourceAssertionTotal}${relations}${result.validYaml ? '' : '  未产出合法 YAML'}`,
  );
}

async function main(): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-generation`;
  const setup = await executeEvalRunStage('dataset_preflight', () => ({
    dataset: generationDatasetIdentity(),
    config: generationEvalConfig(),
  }));
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'generation',
      scope: 'full',
      dataset: setup.dataset,
      metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
      config: setup.config,
    }),
  );
  let completed = false;

  try {
    await executeEvalRunStage('dataset_preflight', () =>
      assertGenerationCasesContract(GENERATION_CASES),
    );
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
      `生成评估(${GENERATION_CASES.length} 条用例,逐条调 DeepSeek,稍候…)\n`,
    );

    const batch = await executeEvalCases({
      cases: GENERATION_CASES,
      evaluate: async (evalCase) => {
        const generated = await executeEvalCaseStage(
          'answer_model',
          () =>
            generateResource(client, {
              requirement: evalCase.requirement,
            }),
          { evalCase },
        );
        return executeEvalCaseStage(
          generatedResultEvaluationStage(generated),
          () => buildGenerationCaseResult(evalCase, generated),
          { evalCase },
        );
      },
      appendSuccess: (evalCase, result) => {
        session.appendCase(
          createTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'generation',
            outcome: generationEnvelopeOutcome(result),
            payload: toPersistedPayload(result),
          }),
        );
      },
      appendError: (evalCase, failure) => {
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'generation',
            payload: failure.payload ?? { evalCase },
            stage: failure.stage,
            error: failure.originalError,
          }),
        );
        console.error(`⚠ harness error [${failure.stage}] ${evalCase.id}`);
      },
    });

    for (const result of batch.results) reportGenerationCase(result);

    const metrics = await executeEvalRunStage('metric_aggregation', () =>
      computeGenerationEvalMetrics(batch.results),
    );
    const stats = metrics.attemptStats;
    const hasCases = metrics.caseCount > 0;

    console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
    console.error(
      `首轮 parse 成功率          : ${percentage(stats.firstParseOk, hasCases)}`,
    );
    console.error(
      `首轮 validation 通过率     : ${percentage(stats.firstValidationOk, hasCases)}`,
    );
    console.error(
      `触发修复率(首轮失败)      : ${percentage(stats.repairAttempted, hasCases)}`,
    );
    console.error(
      `失败后修复成功率           : ${stats.failedFirst ? percentage(stats.repairSuccessAfterFail, true) : 'N/A'}  (${stats.failedFirst} 例首轮失败)`,
    );
    console.error(
      `达上限仍失败率             : ${percentage(stats.maxRoundFailure, hasCases)}`,
    );
    console.error(
      `平均提交次数 / 平均轮数    : ${hasCases ? `${stats.avgSubmits.toFixed(2)} / ${stats.avgRounds.toFixed(2)}` : 'N/A / N/A'}`,
    );

    console.error('\n━━━━━━ 内容正确性 汇总 ━━━━━━');
    console.error(
      `修复成功率(产出合法 YAML) : ${countRate(metrics.validYamlCount, metrics.caseCount)}  (${metrics.validYamlCount}/${metrics.caseCount})`,
    );
    console.error(
      `资源字段断言通过率         : ${countRate(metrics.resourceAssertionPassCount, metrics.resourceAssertionCount)}  (${metrics.resourceAssertionPassCount}/${metrics.resourceAssertionCount})`,
    );
    console.error(
      `跨资源关系通过率           : ${countRate(metrics.relationPassCount, metrics.relationCount)}  (${metrics.relationPassCount}/${metrics.relationCount})`,
    );
    console.error(
      `完整内容通过率             : ${countRate(metrics.contentPassCount, metrics.caseCount)}  (${metrics.contentPassCount}/${metrics.caseCount})`,
    );
    console.error(
      `quality fail=${metrics.caseCount - metrics.contentPassCount} 条；skipped=0 条；harness error=${batch.harnessErrors.length} 条；质量样本=${metrics.caseCount}/${GENERATION_CASES.length}`,
    );

    const metricRecord = await executeEvalRunStage(
      'metric_aggregation',
      () => ({
        ...generationMetricsRecord(metrics),
        ...harnessErrorMetrics('generation', batch.harnessErrors.length),
      }),
    );
    await executeEvalRunStage('artifact_write', () =>
      session.complete(metricRecord),
    );
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'generation'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      '\n说明:多轮行为基于每次 submit 的 attempts;△=YAML 合法，但资源身份、字段值或关系未全部通过。',
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

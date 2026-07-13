// §6 生成评估。对每条用例跑生成引擎,量:修复成功 / 平均轮数 / 首发即对 /
// kind 匹配 / 必备路径覆盖 / 跨资源一致性。会花 DeepSeek 额度(每条一次 generate + 若干修复)。
// 用法:npm run eval:gen

import { config } from 'dotenv';
import { generateResource } from '../server/agent';
import { GENERATION_CASES } from './cases/generation-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
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
  isDirectExecution,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
} from './run-session';

async function main(): Promise<void> {
  const n = GENERATION_CASES.length;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-generation`;
  const session = startEvalRun({
    id: runId,
    kind: 'generation',
    scope: 'full',
    dataset: generationDatasetIdentity(),
    metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
    config: generationEvalConfig(),
  });
  let stage = 'initialize';
  let completed = false;

  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY 未设置');
    }
    const { getClient } = await import('../server/pipeline');
    const client = getClient();
    console.error(`生成评估(${n} 条用例,逐条调 DeepSeek,稍候…)\n`);

    const results: GenerationCaseResult[] = [];
    for (const evalCase of GENERATION_CASES) {
      stage = `case:${evalCase.id}:generate`;
      let result: GenerationCaseResult;
      try {
        const generated = await generateResource(client, {
          requirement: evalCase.requirement,
        });
        result = buildGenerationCaseResult(evalCase, generated);
      } catch (error) {
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'generation',
            payload: toPersistedPayload({ evalCase }),
            stage,
            error,
          }),
        );
        throw error;
      }

      results.push(result);
      session.appendCase(
        createTraceEnvelope({
          runId,
          evalCaseId: evalCase.id,
          kind: 'generation',
          outcome: generationEnvelopeOutcome(result),
          payload: toPersistedPayload(result),
        }),
      );

      const consistency = result.consistencyResults.length
        ? ' 一致性=' +
          result.consistencyResults
            .map(
              (item) =>
                `${item.check.split('_')[0]}:${item.pass ? '✓' : '✗'}`,
            )
            .join(' ')
        : '';
      const mark = result.validYaml ? (result.contentPass ? '✓' : '△') : '✗';
      console.error(
        `${mark} ${evalCase.id.padEnd(24)} 轮${result.rounds} kind=${result.kindMatch ? 'ok' : result.finalKinds.join(',') || '无'} 路径=${result.requiredPathHits.length}/${result.requiredPathTotal}${consistency}${result.validYaml ? '' : '  未产出合法 YAML'}`,
      );
    }

    const metrics = computeGenerationEvalMetrics(results);
    const pct = (value: number, denominator = n) =>
      `${((value / denominator) * 100).toFixed(1)}%`;
    const stats = metrics.attemptStats;
    const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;

    console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
    console.error(`首轮 parse 成功率          : ${percentage(stats.firstParseOk)}`);
    console.error(
      `首轮 validation 通过率     : ${percentage(stats.firstValidationOk)}`,
    );
    console.error(
      `触发修复率(首轮失败)      : ${percentage(stats.repairAttempted)}`,
    );
    console.error(
      `失败后修复成功率           : ${stats.failedFirst ? percentage(stats.repairSuccessAfterFail) : 'N/A'}  (${stats.failedFirst} 例首轮失败)`,
    );
    console.error(
      `达上限仍失败率             : ${percentage(stats.maxRoundFailure)}`,
    );
    console.error(
      `平均提交次数 / 平均轮数    : ${stats.avgSubmits.toFixed(2)} / ${stats.avgRounds.toFixed(2)}`,
    );

    console.error('\n━━━━━━ 内容正确性 汇总 ━━━━━━');
    console.error(
      `修复成功率(产出合法 YAML) : ${pct(metrics.validYamlCount)}  (${metrics.validYamlCount}/${n})`,
    );
    console.error(
      `kind 匹配率(合法者中)     : ${metrics.validYamlCount ? pct(metrics.kindMatchCount, metrics.validYamlCount) : 'N/A'}`,
    );
    console.error(
      `必备路径覆盖(合法者均值)  : ${metrics.validYamlCount ? percentage(metrics.requiredPathCoverageAvg) : 'N/A'}`,
    );
    console.error(
      `跨资源一致性通过率         : ${metrics.consistencyCaseCount ? pct(metrics.consistencyPassCount, metrics.consistencyCaseCount) : 'N/A'}  (${metrics.consistencyPassCount}/${metrics.consistencyCaseCount})`,
    );

    stage = 'complete';
    session.complete(generationMetricsRecord(metrics));
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'generation'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      '\n说明:多轮行为基于每次 submit 的 attempts;内容正确性只在合法产物上算,△=合法但内容不全或不一致。',
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

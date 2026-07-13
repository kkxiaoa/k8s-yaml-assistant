// §6 fix 评估。对每条坏 YAML 跑 fixResource,量:修复成功 / 多轮行为(attempts)/
// kind 是否被改掉 / 意图保留 / 按 defect 类型分组看擅长修哪类。走 DeepSeek。
// 用法:npm run eval:fix

import { config } from 'dotenv';
import { fixResource } from '../server/agent';
import { validateYamlDocuments } from '../validation/validate';
import { FIX_CASES } from './cases/fix-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import {
  buildFixCaseResult,
  computeFixEvalMetrics,
  fixMetricsRecord,
  type FixCaseResult,
} from './metrics/generation-metrics';
import {
  LEGACY_METRIC_DEFINITION_VERSION,
  fixDatasetIdentity,
  fixEnvelopeOutcome,
  fixEvalConfig,
  isDirectExecution,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
} from './run-session';

async function main(): Promise<void> {
  const n = FIX_CASES.length;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-fix`;
  const session = startEvalRun({
    id: runId,
    kind: 'fix',
    scope: 'full',
    dataset: fixDatasetIdentity(),
    metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
    config: fixEvalConfig(),
  });
  let stage = 'initialize';
  let completed = false;

  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY 未设置');
    }
    const { getClient } = await import('../server/pipeline');
    const client = getClient();
    console.error(`fix 评估(${n} 条坏 YAML,逐条调 DeepSeek,稍候…)\n`);

    const results: FixCaseResult[] = [];
    for (const evalCase of FIX_CASES) {
      stage = `case:${evalCase.id}:fixture_validation`;
      const errors = validateYamlDocuments(evalCase.brokenYaml).errors;
      if (errors.length === 0) {
        const error = new Error('brokenYaml 没有校验错误,用例无效');
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'fix',
            payload: toPersistedPayload({ evalCase }),
            stage,
            error,
          }),
        );
        console.error(`⚠ ${evalCase.id}:${error.message}`);
        continue;
      }

      stage = `case:${evalCase.id}:fix`;
      let result: FixCaseResult;
      try {
        const fixed = await fixResource(client, evalCase.brokenYaml, errors);
        result = buildFixCaseResult(evalCase, fixed);
      } catch (error) {
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'fix',
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
          kind: 'fix',
          outcome: fixEnvelopeOutcome(result),
          payload: toPersistedPayload(result),
        }),
      );

      const mark = result.validYaml
        ? result.kindKept && result.intentPreserved
          ? '✓'
          : '△'
        : '✗';
      console.error(
        `${mark} ${evalCase.id.padEnd(24)} [${evalCase.defectType}] 提交${result.submitCount} 轮${result.rounds} kind=${result.kindKept ? 'ok' : (result.finalKinds.join(',') || '无') + '≠' + evalCase.expectedKind} 保留=${result.preserved.length}/${result.preserveTotal}${result.validYaml ? '' : '  未修成合法 YAML'}`,
      );
    }

    const metrics = computeFixEvalMetrics(results);
    const stats = metrics.attemptStats;
    const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
    const pct = (value: number, denominator = n) =>
      `${((value / denominator) * 100).toFixed(1)}%`;

    console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
    console.error(`首轮 parse 成功率      : ${percentage(stats.firstParseOk)}`);
    console.error(
      `首轮修复即通过率       : ${percentage(stats.firstValidationOk)}`,
    );
    console.error(`触发再修复率           : ${percentage(stats.repairAttempted)}`);
    console.error(
      `再修复成功率           : ${stats.failedFirst ? percentage(stats.repairSuccessAfterFail) : 'N/A'}  (${stats.failedFirst} 例首轮未修好)`,
    );
    console.error(`达上限仍失败率         : ${percentage(stats.maxRoundFailure)}`);
    console.error(
      `平均提交次数 / 平均轮数: ${stats.avgSubmits.toFixed(2)} / ${stats.avgRounds.toFixed(2)}`,
    );

    console.error('\n━━━━━━ 修复质量 汇总 ━━━━━━');
    console.error(
      `修复成功率           : ${pct(metrics.validYamlCount)}  (${metrics.validYamlCount}/${n})`,
    );
    console.error(
      `kind 保持率(未改类型): ${metrics.validYamlCount ? pct(metrics.kindKeptCount, metrics.validYamlCount) : 'N/A'}`,
    );
    console.error(
      `意图完整保留率       : ${metrics.validYamlCount ? pct(metrics.intentPreservedCount, metrics.validYamlCount) : 'N/A'}`,
    );
    console.error(
      `关键值保留覆盖(均值) : ${metrics.validYamlCount ? percentage(metrics.preserveCoverageAvg) : 'N/A'}`,
    );

    console.error('\n━━━━━━ 按缺陷类型:修复成功率 ━━━━━━');
    for (const [type, value] of Object.entries(metrics.byDefectType).sort()) {
      console.error(
        `${type.padEnd(18)} : ${((value.fixed / value.total) * 100).toFixed(0)}%  (${value.fixed}/${value.total})`,
      );
    }

    stage = 'complete';
    session.complete(fixMetricsRecord(metrics));
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'fix'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}`,
    );
    console.error(
      '\n说明:多轮行为基于 attempts;△=修成合法但改了 kind 或丢了关键字段。',
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

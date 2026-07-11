// §6 生成评估。对每条用例跑生成引擎,量:修复成功 / 平均轮数 / 首发即对 /
// kind 匹配 / 必备路径覆盖 / 跨资源一致性。会花 DeepSeek 额度(每条一次 generate + 若干修复)。
// 纯度量函数在 ./metrics/generation-metrics(无副作用);本文件才有 main。
// 用法:npm run eval:gen

import { config } from 'dotenv';
config({ override: true });
import { ANSWER_MODEL, getClient } from '../server/pipeline';
import { generateResource } from '../server/agent';
import { GENERATION_CASES } from './cases/generation-cases';
import { appendJsonl, tracePathForRun } from './artifacts';
import {
  buildGenerationCaseResult,
  computeGenerationEvalMetrics,
  generationMetricsRecord,
  type GenerationCaseResult,
} from './metrics/generation-metrics';
import { writeRun, type EvalRun } from './run-store';

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const n = GENERATION_CASES.length;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-generation`;
  const tracePath = tracePathForRun(runId, 'generation');
  console.error(`生成评估(${n} 条用例,逐条调 DeepSeek,稍候…)\n`);

  const results: GenerationCaseResult[] = [];

  for (const c of GENERATION_CASES) {
    const r = await generateResource(client, { requirement: c.requirement });
    const result = buildGenerationCaseResult(c, r);
    results.push(result);
    appendJsonl(tracePath, result);

    const consStr = result.consistencyResults.length
      ? ' 一致性=' +
        result.consistencyResults
          .map((x) => `${x.check.split('_')[0]}:${x.pass ? '✓' : '✗'}`)
          .join(' ')
      : '';
    const mark = result.validYaml ? (result.contentPass ? '✓' : '△') : '✗';
    console.error(
      `${mark} ${c.id.padEnd(24)} 轮${result.rounds} kind=${result.kindMatch ? 'ok' : result.finalKinds.join(',') || '无'} 路径=${result.requiredPathHits.length}/${result.requiredPathTotal}${consStr}${result.validYaml ? '' : '  未产出合法 YAML'}`,
    );
  }

  const metrics = computeGenerationEvalMetrics(results);
  const pct = (x: number, d = n) => `${((x / d) * 100).toFixed(1)}%`;
  const s = metrics.attemptStats;
  const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;

  console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
  console.error(`首轮 parse 成功率          : ${p1(s.firstParseOk)}`);
  console.error(`首轮 validation 通过率     : ${p1(s.firstValidationOk)}`);
  console.error(`触发修复率(首轮失败)      : ${p1(s.repairAttempted)}`);
  console.error(
    `失败后修复成功率           : ${s.failedFirst ? p1(s.repairSuccessAfterFail) : 'N/A'}  (${s.failedFirst} 例首轮失败)`,
  );
  console.error(`达上限仍失败率             : ${p1(s.maxRoundFailure)}`);
  console.error(`平均提交次数 / 平均轮数    : ${s.avgSubmits.toFixed(2)} / ${s.avgRounds.toFixed(2)}`);

  console.error('\n━━━━━━ 内容正确性 汇总 ━━━━━━');
  console.error(
    `修复成功率(产出合法 YAML) : ${pct(metrics.validYamlCount)}  (${metrics.validYamlCount}/${n})`,
  );
  console.error(
    `kind 匹配率(合法者中)     : ${metrics.validYamlCount ? pct(metrics.kindMatchCount, metrics.validYamlCount) : '0%'}`,
  );
  console.error(
    `必备路径覆盖(合法者均值)  : ${metrics.validYamlCount ? p1(metrics.requiredPathCoverageAvg) : '0%'}`,
  );
  console.error(
    `跨资源一致性通过率         : ${metrics.consistencyCaseCount ? pct(metrics.consistencyPassCount, metrics.consistencyCaseCount) : 'N/A'}  (${metrics.consistencyPassCount}/${metrics.consistencyCaseCount})`,
  );
  const run: EvalRun = {
    id: runId,
    kind: 'generation',
    createdAt: new Date().toISOString(),
    artifactPaths: { tracePath },
    scope: 'full',
    caseIds: GENERATION_CASES.map((c) => c.id),
    answerModel: ANSWER_MODEL,
    metrics: generationMetricsRecord(metrics),
  };
  const runPath = writeRun(run);
  console.error(`\n逐条 trace → ${tracePath}\n汇总 run → ${runPath}`);
  console.error(
    '\n说明:多轮行为基于每次 submit 的 attempts;内容正确性只在合法产物上算,△=合法但内容不全或不一致。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

// §6 fix 评估。对每条坏 YAML 跑 fixResource,量:修复成功 / 多轮行为(attempts)/
// kind 是否被改掉 / 意图保留 / 按 defect 类型分组看擅长修哪类。走 DeepSeek。
// 用法:npm run eval:fix

import { config } from 'dotenv';
config({ override: true });
import { ANSWER_MODEL, getClient } from '../server/pipeline';
import { fixResource } from '../server/agent';
import { validateYamlDocuments } from '../validation/validate';
import { FIX_CASES } from './cases/fix-cases';
import { appendJsonl, tracePathForRun } from './artifacts';
import {
  buildFixCaseResult,
  computeFixEvalMetrics,
  fixMetricsRecord,
  type FixCaseResult,
} from './metrics/generation-metrics';
import { writeRun, type EvalRun } from './run-store';

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const n = FIX_CASES.length;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-fix`;
  const tracePath = tracePathForRun(runId, 'fix');
  console.error(`fix 评估(${n} 条坏 YAML,逐条调 DeepSeek,稍候…)\n`);

  const results: FixCaseResult[] = [];

  for (const c of FIX_CASES) {
    const errs = validateYamlDocuments(c.brokenYaml).errors;
    if (errs.length === 0) {
      console.error(`⚠ ${c.id}:brokenYaml 没有校验错,用例无效`);
      continue;
    }

    const r = await fixResource(client, c.brokenYaml, errs);
    const result = buildFixCaseResult(c, r);
    results.push(result);
    appendJsonl(tracePath, result);

    const mark = result.validYaml
      ? result.kindKept && result.intentPreserved
        ? '✓'
        : '△'
      : '✗';
    console.error(
      `${mark} ${c.id.padEnd(24)} [${c.defectType}] 提交${result.submitCount} 轮${result.rounds} kind=${result.kindKept ? 'ok' : (result.finalKinds.join(',') || '无') + '≠' + c.expectedKind} 保留=${result.preserved.length}/${result.preserveTotal}${result.validYaml ? '' : '  未修成合法 YAML'}`,
    );
  }

  const metrics = computeFixEvalMetrics(results);
  const s = metrics.attemptStats;
  const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;
  const pct = (x: number, d = n) => `${((x / d) * 100).toFixed(1)}%`;

  console.error('\n━━━━━━ 多轮行为(基于 attempts)━━━━━━');
  console.error(`首轮 parse 成功率      : ${p1(s.firstParseOk)}`);
  console.error(`首轮修复即通过率       : ${p1(s.firstValidationOk)}`);
  console.error(`触发再修复率           : ${p1(s.repairAttempted)}`);
  console.error(
    `再修复成功率           : ${s.failedFirst ? p1(s.repairSuccessAfterFail) : 'N/A'}  (${s.failedFirst} 例首轮未修好)`,
  );
  console.error(`达上限仍失败率         : ${p1(s.maxRoundFailure)}`);
  console.error(
    `平均提交次数 / 平均轮数: ${s.avgSubmits.toFixed(2)} / ${s.avgRounds.toFixed(2)}`,
  );

  console.error('\n━━━━━━ 修复质量 汇总 ━━━━━━');
  console.error(`修复成功率           : ${pct(metrics.validYamlCount)}  (${metrics.validYamlCount}/${n})`);
  console.error(`kind 保持率(未改类型): ${metrics.validYamlCount ? pct(metrics.kindKeptCount, metrics.validYamlCount) : '0%'}`);
  console.error(`意图完整保留率       : ${metrics.validYamlCount ? pct(metrics.intentPreservedCount, metrics.validYamlCount) : '0%'}`);
  console.error(
    `关键值保留覆盖(均值) : ${metrics.validYamlCount ? p1(metrics.preserveCoverageAvg) : '0%'}`,
  );

  console.error('\n━━━━━━ 按缺陷类型:修复成功率 ━━━━━━');
  for (const [type, v] of Object.entries(metrics.byDefectType).sort()) {
    console.error(
      `${type.padEnd(18)} : ${((v.fixed / v.total) * 100).toFixed(0)}%  (${v.fixed}/${v.total})`,
    );
  }
  const run: EvalRun = {
    id: runId,
    kind: 'fix',
    createdAt: new Date().toISOString(),
    artifactPaths: { tracePath },
    scope: 'full',
    caseIds: FIX_CASES.map((c) => c.id),
    answerModel: ANSWER_MODEL,
    metrics: fixMetricsRecord(metrics),
  };
  const runPath = writeRun(run);
  console.error(`\n逐条 trace → ${tracePath}\n汇总 run → ${runPath}`);
  console.error(
    '\n说明:多轮行为基于 attempts;△=修成合法但改了 kind 或丢了关键字段。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

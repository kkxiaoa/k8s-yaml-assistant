// 把某次 eval run 与同 kind baseline 对比。纯本地,不调用模型。
// 用法:
//   npm run eval:compare
//   npm run eval:compare -- <runId>

import { runPath } from '../src/eval/artifacts';
import {
  formatMetricDelta,
  formatMetricObservation,
} from '../src/eval/metric-format';
import {
  compareEvalArtifacts,
  type MetricVerdict,
} from '../src/eval/metrics/compare';
import {
  metricDefinitionsForKind,
  type MetricDefinition,
} from '../src/eval/metrics/definitions';
import type {
  EvalBaseline,
  EvalKind,
  EvalRun,
  MetricObservation,
} from '../src/eval/protocol';
import { latestRun, readBaseline, readRun } from '../src/eval/run-store';

function definitionMap(kind: EvalKind): Map<string, MetricDefinition> {
  return new Map(
    metricDefinitionsForKind(kind).map((definition) => [
      definition.key,
      definition,
    ]),
  );
}

function metricText(
  definition: MetricDefinition,
  observation: MetricObservation,
): string {
  return formatMetricObservation(definition.unit, observation);
}

function displayValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function measurementLabel(artifact: EvalRun | EvalBaseline): string {
  return artifact.kind === 'retrieval' ? `, k=${artifact.config.k}` : '';
}

function verdictSummary(
  verdicts: readonly MetricVerdict[],
): Record<MetricVerdict, number> {
  const summary: Record<MetricVerdict, number> = {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    neutral: 0,
    not_comparable: 0,
  };
  for (const verdict of verdicts) summary[verdict]++;
  return summary;
}

function reportCurrentWithoutBaseline(current: EvalRun): void {
  const definitions = definitionMap(current.kind);
  console.log('\n尚无 baseline。当前 run 指标:');
  for (const [key, observation] of Object.entries(current.metrics).sort()) {
    const definition = definitions.get(key);
    console.log(
      definition
        ? `  ${key.padEnd(48)} ${metricText(definition, observation)}`
        : `  ${key.padEnd(48)} UNREGISTERED ${displayValue(observation)}`,
    );
  }
  console.log(
    '\n需要对应 kind 的完整 run，并通过显式 promote 建立 baseline 后才能比较。',
  );
  console.log(`metricDefinitionVersion=${current.metricDefinitionVersion}`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error('用法: npm run eval:compare [-- <runId>]');
    process.exitCode = 1;
    return;
  }
  const runId = args[0];
  const current = runId ? readRun(runId) : latestRun();
  if (!current) {
    console.error('没有可对比的 run。先执行对应 eval。');
    process.exitCode = 1;
    return;
  }

  console.log(
    `当前 run : ${runPath(current.id)} (${current.createdAt}, kind=${current.kind}${measurementLabel(current)})`,
  );
  const baseline = readBaseline(current.kind);
  if (!baseline) {
    reportCurrentWithoutBaseline(current);
    return;
  }
  console.log(
    `baseline : ${baseline.sourceRunId} (${baseline.promotedAt}, kind=${baseline.kind}${measurementLabel(baseline)})`,
  );

  const result = compareEvalArtifacts(current, baseline);
  if (result.identityIssues.length > 0) {
    console.error('\nINCOMPATIBLE: comparison identity 不一致:');
    for (const issue of result.identityIssues) {
      console.error(
        `  - ${issue.code} (${issue.path}): baseline=${displayValue(issue.baseline)} -> current=${displayValue(issue.current)}${issue.expected === undefined ? '' : `, expected=${displayValue(issue.expected)}`}`,
      );
    }
  }

  if (result.experimentChanges.length > 0) {
    console.log('\n本次 delta 跨越的实验变量:');
    for (const change of result.experimentChanges) {
      console.log(
        `  - ${change.path}: baseline=${displayValue(change.baseline)} -> current=${displayValue(change.current)}`,
      );
    }
  } else {
    console.log('\n实验变量:无已记录 config 变化。');
  }

  if (!result.compatible) {
    console.error('\n身份不兼容，不输出 improved/regressed 结论。');
    process.exitCode = 1;
    return;
  }

  const definitions = definitionMap(current.kind);
  console.log('\n指标对比:');
  for (const comparison of result.comparisons) {
    const definition = definitions.get(comparison.key);
    if (!definition) continue;
    const delta =
      comparison.delta === null
        ? 'N/A'
        : formatMetricDelta(definition.unit, comparison.delta);
    console.log(
      `  ${comparison.key}\n` +
        `    current=${metricText(definition, comparison.current)}  baseline=${metricText(definition, comparison.baseline)}  delta=${delta}  verdict=${comparison.verdict}${comparison.reason ? ` (${comparison.reason})` : ''}`,
    );
  }

  if (result.requiredGaps.length > 0) {
    console.error('\nHARNESS GAP: required metric 缺失:');
    for (const gap of result.requiredGaps) {
      console.error(`  - ${gap.key}: missing from ${gap.missingFrom}`);
    }
  }
  if (result.diagnosticGaps.length > 0) {
    console.log('\nDiagnostic metric 缺失（不阻断 required completeness）:');
    for (const gap of result.diagnosticGaps) {
      console.log(`  - ${gap.key}: missing from ${gap.missingFrom}`);
    }
  }
  if (result.unregisteredCurrentKeys.length > 0) {
    console.error(
      `\nHARNESS GAP: current 含未注册指标: ${result.unregisteredCurrentKeys.join(', ')}`,
    );
  }
  if (result.unregisteredBaselineKeys.length > 0) {
    console.error(
      `\nHARNESS GAP: baseline 含未注册指标: ${result.unregisteredBaselineKeys.join(', ')}`,
    );
  }

  const requiredKeys = new Set(
    metricDefinitionsForKind(current.kind)
      .filter((definition) => definition.stability === 'required')
      .map((definition) => definition.key),
  );
  const requiredComparisons = result.comparisons.filter((comparison) =>
    requiredKeys.has(comparison.key),
  );
  const summary = verdictSummary(
    requiredComparisons.map((comparison) => comparison.verdict),
  );
  console.log(
    '\nRequired metric summary: ' +
      `expected=${requiredKeys.size}, observed=${requiredComparisons.length}, missing=${result.requiredGaps.length}, ` +
      `improved=${summary.improved}, regressed=${summary.regressed}, unchanged=${summary.unchanged}, ` +
      `neutral=${summary.neutral}, not_comparable=${summary.not_comparable}`,
  );

  if (result.hasBlockingHarnessGap) process.exitCode = 1;
}

main();

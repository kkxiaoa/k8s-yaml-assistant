// 把某次 eval run 与同 kind baseline 对比。纯本地,不调用模型。
// 用法:
//   npm run eval:compare
//   npm run eval:compare -- <runId>

import {
  compareMetrics,
  latestRun,
  readBaseline,
  readRun,
} from '../src/eval/run-store';
import { runPath } from '../src/eval/artifacts';
import {
  formatMetricDelta,
  formatMetricValue,
} from '../src/eval/metric-format';
import type {
  EvalBaseline,
  EvalRun,
  MetricObservation,
} from '../src/eval/protocol';

function metricText(key: string, observation: MetricObservation): string {
  return observation.value === null
    ? 'N/A'
    : formatMetricValue(key, observation.value);
}

function retrievalIdentity(
  artifact: EvalRun | EvalBaseline,
): { corpusHash: string; indexHash: string; k: number } | null {
  return artifact.kind === 'retrieval' || artifact.kind === 'faith'
    ? {
        corpusHash: artifact.config.corpusHash,
        indexHash: artifact.config.indexHash,
        k: artifact.config.k,
      }
    : null;
}

function main(): void {
  const runId = process.argv[2];
  const current = runId ? readRun(runId) : latestRun();
  if (!current) {
    console.error('没有可对比的 run。先执行对应 eval。');
    process.exit(1);
  }
  const baseline = readBaseline(current.kind);
  const currentRetrieval = retrievalIdentity(current);

  console.log(
    `当前 run : ${runPath(current.id)}(${current.createdAt}, k=${currentRetrieval?.k ?? 'n/a'}, kind=${current.kind})`,
  );

  if (!baseline) {
    console.log('\n尚无 baseline。当前 run 指标:');
    for (const [key, observation] of Object.entries(current.metrics).sort()) {
      console.log(`  ${key.padEnd(42)} ${metricText(key, observation)}`);
    }
    console.log(
      `\nmetricDefinitionVersion=${current.metricDefinitionVersion}; legacy-v1 run 不可晋升。`,
    );
    return;
  }

  console.log(
    `baseline : ${baseline.sourceRunId}(${baseline.promotedAt}, kind=${baseline.kind})`,
  );
  const baselineRetrieval = retrievalIdentity(baseline);
  if (
    currentRetrieval &&
    baselineRetrieval &&
    (currentRetrieval.corpusHash !== baselineRetrieval.corpusHash ||
      currentRetrieval.indexHash !== baselineRetrieval.indexHash)
  ) {
    console.log(
      '⚠ 语料/索引指纹与 baseline 不一致,对比跨越了语料或索引变更,仅供参考。',
    );
  }
  if (current.dataset.hash !== baseline.dataset.hash) {
    console.log('⚠ dataset hash 与 baseline 不一致,Δ 含数据集语义变更。');
  }

  const rows = compareMetrics(current.metrics, baseline.metrics);
  const onlyCurrent = Object.keys(current.metrics).filter(
    (key) => !(key in baseline.metrics),
  );
  const onlyBaseline = Object.keys(baseline.metrics).filter(
    (key) => !(key in current.metrics),
  );

  console.log('\n指标                 当前      baseline   Δ');
  for (const row of rows) {
    console.log(
      `${row.key.padEnd(42)} ${formatMetricValue(row.key, row.current).padStart(8)}   ${formatMetricValue(row.key, row.baseline).padStart(8)}   ${formatMetricDelta(row.key, row.delta)}`,
    );
  }
  if (onlyCurrent.length) {
    console.log(`\n仅当前 run 有(baseline 缺,跳过):${onlyCurrent.join(', ')}`);
  }
  if (onlyBaseline.length) {
    console.log(`仅 baseline 有(当前缺,跳过):${onlyBaseline.join(', ')}`);
  }
}

main();

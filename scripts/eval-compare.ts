// §4.2:把某次 eval run 与 baseline 对比,打印每个共有指标的 Δ。纯本地,不花额度。
// 用法:
//   npm run eval:compare                         对比最近一次 run 与 baseline
//   npm run eval:compare -- data/eval/runs/<id>.json   指定 run
// 初期只提示退化、不阻塞;缺 baseline 时打印当前 run 供人工确认后 promote。

import {
  compareMetrics,
  latestRunPath,
  readBaseline,
  readRun,
  runKind,
} from '../src/eval/run-store';
import {
  formatMetricDelta,
  formatMetricValue,
} from '../src/eval/metric-format';

function main(): void {
  const runPath = process.argv[2] ?? latestRunPath();
  if (!runPath) {
    console.error('没有可对比的 run。先跑 `npm run eval`。');
    process.exit(1);
  }
  const current = readRun(runPath);
  const kind = runKind(current);
  const baseline = readBaseline(kind); // 按 run 自身 kind 匹配同类型 baseline,不混检索/faith

  console.log(
    `当前 run : ${runPath}(${current.createdAt}, k=${current.k ?? 'n/a'}, kind=${kind})`,
  );

  if (!baseline) {
    console.log('\n尚无 baseline。当前 run 指标:');
    for (const [key, val] of Object.entries(current.metrics).sort())
      console.log(`  ${key.padEnd(42)} ${formatMetricValue(key, val)}`);
    console.log(
      `\n确认无误后晋升为 baseline:npm run eval:promote -- ${runPath}`,
    );
    return;
  }

  console.log(`baseline : ${baseline.id}(${baseline.createdAt})`);
  if (
    current.corpusHash &&
    baseline.corpusHash &&
    current.indexHash &&
    baseline.indexHash &&
    (current.corpusHash !== baseline.corpusHash ||
      current.indexHash !== baseline.indexHash)
  ) {
    console.log(
      '⚠ 语料/索引指纹与 baseline 不一致(corpusHash/indexHash 变了),对比跨越了语料变更,仅供参考。',
    );
  }
  if (
    current.evalSetHash &&
    baseline.evalSetHash &&
    current.evalSetHash !== baseline.evalSetHash
  ) {
    console.log(
      '⚠ retrieval case 指纹与 baseline 不一致(标注改过),Δ 含标注变更、非纯模型改进。',
    );
  } else if (current.evalSetHash && !baseline.evalSetHash) {
    console.log(
      'ℹ baseline 无 evalSetHash(旧版 run),无法判定标注是否变更。',
    );
  }

  const rows = compareMetrics(current.metrics, baseline.metrics);
  const onlyCurrent = Object.keys(current.metrics).filter(
    (k) => !(k in baseline.metrics),
  );
  const onlyBaseline = Object.keys(baseline.metrics).filter(
    (k) => !(k in current.metrics),
  );

  console.log('\n指标                 当前      baseline   Δ');
  let regressed = 0;
  for (const r of rows) {
    const arrow = r.delta > 0 ? '↑' : r.delta < 0 ? '↓' : '=';
    if (r.delta < 0) regressed++;
    console.log(
      `${r.key.padEnd(42)} ${formatMetricValue(r.key, r.current).padStart(8)}   ${formatMetricValue(r.key, r.baseline).padStart(8)}   ${arrow} ${formatMetricDelta(r.key, r.delta)}`,
    );
  }
  if (onlyCurrent.length)
    console.log(`\n仅当前 run 有(baseline 缺,跳过):${onlyCurrent.join(', ')}`);
  if (onlyBaseline.length)
    console.log(`仅 baseline 有(当前缺,跳过):${onlyBaseline.join(', ')}`);

  console.log(
    regressed > 0
      ? `\n⚠ ${regressed} 个指标较 baseline 退化。确认是预期后再决定是否 promote。`
      : '\n✓ 无退化。',
  );
}

main();

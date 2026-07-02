// §4.2:把某次 eval run 显式晋升为新 baseline。必须显式动作,eval 不会自动覆盖 baseline
// (避免把退化当成新基线)。纯本地,不花额度。
// 用法:npm run eval:promote -- data/eval/runs/<id>.json

import { BASELINE_PATH, promote, readRun } from '../src/eval/run-store';

function main(): void {
  const runArg = process.argv[2];
  if (!runArg) {
    console.error('用法:npm run eval:promote -- data/eval/runs/<id>.json');
    process.exit(1);
  }
  const run = readRun(runArg);
  promote(run);
  console.log(`已晋升为 baseline → ${BASELINE_PATH}`);
  console.log(`  run id     : ${run.id}`);
  console.log(`  indexHash  : ${run.indexHash.slice(0, 16)}…`);
  for (const [key, val] of Object.entries(run.metrics).sort())
    console.log(`  ${key.padEnd(18)} ${(val * 100).toFixed(1)}%`);
}

main();

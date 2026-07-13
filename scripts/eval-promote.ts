// baseline 晋升入口。legacy-v1 以及结构不完整的 run 不允许晋升。
// 用法:npm run eval:promote -- <runId>

import { baselinePath } from '../src/eval/artifacts';
import { promoteRun } from '../src/eval/run-store';

function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    console.error('用法:npm run eval:promote -- <runId>');
    process.exit(1);
  }

  const baseline = promoteRun(runId);
  console.log(`已晋升 baseline → ${baselinePath(baseline.kind)}`);
  console.log(`source run: ${baseline.sourceRunId}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

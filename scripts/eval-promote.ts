// 显式将一个通过完整门禁的 run 晋升为 baseline。
// 用法: npm run eval:promote -- <runId>

import { baselinePath } from '../src/eval/artifacts';
import { promoteRun } from '../src/eval/run-store';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('用法: npm run eval:promote -- <runId>');
    process.exit(1);
  }
  const runId = args[0]!;

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

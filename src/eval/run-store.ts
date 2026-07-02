// §4.2 baseline/run 存储与对比(纯本地 IO,不碰网络/CORPUS)。
// 布局:
//   data/eval/baseline.json          晋升后的基线(入 git)
//   data/eval/runs/<id>.json         每次 eval 的结果(gitignore)
// eval 写 run,eval:compare 对 baseline 出 Δ,eval:promote 显式把某个 run 晋升为 baseline。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EvalRun {
  /** 时间戳 id,同时是 runs/<id>.json 文件名 */
  id: string;
  createdAt: string;
  corpusHash: string;
  indexHash: string;
  embeddingModel: string;
  rerankModel?: string;
  /** 检索类 eval 无作答模型,留空;Stage 4 生成类才填 */
  answerModel?: string;
  k: number;
  /** 跨 Stage 并集:Stage 2 只有检索类(如 serving.recall@3)。compare 只 diff 共有 key。 */
  metrics: Record<string, number>;
}

export const EVAL_DIR = join(process.cwd(), 'data', 'eval');
export const RUNS_DIR = join(EVAL_DIR, 'runs');
export const BASELINE_PATH = join(EVAL_DIR, 'baseline.json');

export function writeRun(run: EvalRun): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${run.id}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

export function readRun(path: string): EvalRun {
  return JSON.parse(readFileSync(path, 'utf8')) as EvalRun;
}

export function readBaseline(): EvalRun | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EvalRun;
}

/** 最近一次 run 的路径(按文件名即时间戳排序)。 */
export function latestRunPath(): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const last = files[files.length - 1];
  return last ? join(RUNS_DIR, last) : null;
}

export function promote(run: EvalRun): void {
  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(run, null, 2)}\n`);
}

export interface CompareRow {
  key: string;
  current: number;
  baseline: number;
  delta: number;
}

/** 只 diff 两边都存在的 metric key(缺失指标跳过,不报错)。 */
export function compareMetrics(
  current: Record<string, number>,
  baseline: Record<string, number>,
): CompareRow[] {
  return Object.keys(current)
    .filter((k) => k in baseline)
    .sort()
    .map((k) => ({
      key: k,
      current: current[k]!,
      baseline: baseline[k]!,
      delta: current[k]! - baseline[k]!,
    }));
}

// §4.2 baseline/run 存储与对比(纯本地 IO,不碰网络/CORPUS)。
// 布局:
//   data/eval/baseline.json          晋升后的基线(入 git)
//   data/eval/runs/<id>.json         每次 eval 的结果(gitignore)
// eval 写 run,eval:compare 对 baseline 出 Δ,eval:promote 显式把某个 run 晋升为 baseline。

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { QueryExpansionTrace } from '../retrieval/query-expansion-runtime';

/** eval 类型:不同任务的指标和 baseline 不混用。 */
export type EvalKind = 'retrieval' | 'faith' | 'judge' | 'generation' | 'fix';

export type EvalScope =
  | 'full'
  | 'policy'
  | 'smoke'
  | 'targeted'
  | 'calibration';

export interface EvalArtifactPaths {
  tracePath?: string;
}

export interface QueryExpansionRunConfig {
  enabled: boolean;
  registryHash?: string;
  reviewedAliasCount: number;
}

export interface FaithRunSelection {
  scope: 'full' | 'policy' | 'smoke';
  caseIds: string[];
}

export interface EvalRun {
  /** 时间戳 id,同时是 runs/<id>.json 文件名 */
  id: string;
  /** 旧 run 缺 kind 时按 retrieval 读取。 */
  kind?: EvalKind;
  createdAt: string;
  artifactPaths?: EvalArtifactPaths;
  scope?: EvalScope;
  caseIds?: string[];
  corpusHash?: string;
  indexHash?: string;
  /** retrieval case 指纹(id+question+expectedChunkIds)。变了说明标注改过,Δ 含标注变更、非纯模型改进。 */
  evalSetHash?: string;
  /** 全量 retrieval case 版本指纹;faith 子集 run 用它区分 selection hash 与全量版本闸。 */
  evalSetVersionHash?: string;
  embeddingModel?: string;
  rerankModel?: string;
  /** 检索类 eval 无作答模型,留空;Stage 4 生成类才填 */
  answerModel?: string;
  judgeModel?: string;
  faithSelection?: FaithRunSelection;
  /** 生成该 run 时共享检索入口使用的 query expansion 配置。 */
  queryExpansion?: QueryExpansionRunConfig;
  k?: number;
  /** 跨 Stage 并集:Stage 2 只有检索类(如 serving.recall@3)。compare 只 diff 共有 key。 */
  metrics: Record<string, number>;
}

export function queryExpansionRunConfig(
  trace: QueryExpansionTrace,
): QueryExpansionRunConfig {
  return {
    enabled: trace.enabled,
    registryHash: trace.registryHash,
    reviewedAliasCount: trace.reviewedAliasCount ?? 0,
  };
}

/** retrieval case 指纹:按 id 排序拼接 id+question+expectedChunkIds,取 sha256。标注任一变化即变化。 */
export function computeEvalSetHash(
  cases: Array<{ id: string; question: string; expectedChunkIds: string[] }>,
): string {
  const h = createHash('sha256');
  for (const c of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(c.id);
    h.update('\n');
    h.update(c.question);
    h.update('\n');
    h.update([...c.expectedChunkIds].sort().join(','));
    h.update('\n');
  }
  return h.digest('hex');
}

export const EVAL_DIR = join(process.cwd(), 'data', 'eval');
export const RUNS_DIR = join(EVAL_DIR, 'runs');
export const BASELINE_PATH = join(EVAL_DIR, 'baseline.json'); // retrieval baseline(兼容旧)

/** run 的 kind,旧 run 文件缺 kind 视作 retrieval。 */
export function runKind(run: EvalRun): EvalKind {
  return run.kind ?? 'retrieval';
}

/** 按 kind 取 baseline 文件:retrieval=baseline.json(兼容旧)。 */
export function baselinePathFor(kind: EvalKind): string {
  return kind === 'retrieval'
    ? BASELINE_PATH
    : join(EVAL_DIR, `baseline.${kind}.json`);
}

export function writeRun(run: EvalRun): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${run.id}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

export function readRun(path: string): EvalRun {
  return JSON.parse(readFileSync(path, 'utf8')) as EvalRun;
}

export function readBaseline(kind: EvalKind = 'retrieval'): EvalRun | null {
  const path = baselinePathFor(kind);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as EvalRun;
}

/** 最近一次 run 路径(按文件名即时间戳排序);传 kind 则只在该类型 run 里取最新。 */
export function latestRunPath(kind?: EvalKind): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  let files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (kind) {
    files = files.filter((f) => {
      try {
        const r = JSON.parse(
          readFileSync(join(RUNS_DIR, f), 'utf8'),
        ) as EvalRun;
        return runKind(r) === kind;
      } catch {
        return false;
      }
    });
  }
  const last = files[files.length - 1];
  return last ? join(RUNS_DIR, last) : null;
}

export function promote(run: EvalRun): void {
  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(
    baselinePathFor(runKind(run)),
    `${JSON.stringify(run, null, 2)}\n`,
  );
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

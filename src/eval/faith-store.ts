// 生成层评估(faithfulness)的逐条明细落盘。对齐检索侧 traces.jsonl 的"逐条 NDJSON"分工:
//   run-store  = 汇总指标(可对比 baseline)
//   faith/<id> = 本模块,逐条明细(检索命中 + 答案 + 裁判判定 + 归因),供读盘诊断/分析
//   bad-cases  = 失败用例回灌(后续步骤接入)
// 每次全量跑产出一个 data/eval/faith/<runId>.jsonl,runId 与 run-store 的 EvalRun.id 对应,便于关联。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict } from './judge';
import { EVAL_DIR } from './run-store';

/** 单条归因,读盘即可分类。 */
export type FaithOutcome =
  | 'faithful_hit' // 可答:检索命中 + 忠实
  | 'faithful_miss' // 可答:检索未命中 但仍忠实(基于错料老实/拒答)
  | 'hallucination' // 可答:检索命中 却不忠实 = 真幻觉
  | 'dual_cause' // 可答:检索未命中 且不忠实 = 检索漏 + 没守拒答边界
  | 'refused_correctly' // 拒答:忠实
  | 'refused_wrong' // 拒答:编造
  | 'judge_failed' // 裁判两次未给有效 JSON
  | 'error'; // 网络/异常失败(重试后仍失败)

export interface FaithTrace {
  /** eval case id(对齐 eval-set,便于和检索 Recall 交叉对照) */
  id: string;
  question: string;
  answerable: boolean;
  resource?: string;
  retrieval: {
    routed?: string;
    /** 应召回的 chunk(可答用例);拒答用例为空 */
    expectedChunkIds: string[];
    /** 实际喂给生成的 context chunk(rerank 后 top-K) */
    topIds: string[];
    foundCount: number;
    /** 仅 answerable 有意义:expected 是否全在 topIds 里 */
    fullRecall: boolean;
  };
  answer: string;
  /** 裁判判定:answer vs 检索 context;null=判定失败 */
  verdict: Verdict | null;
  outcome: FaithOutcome;
}

export const FAITH_DIR = join(EVAL_DIR, 'faith'); // 复用 run-store 的 EVAL_DIR,单一真相源

/** 写一次全量跑的逐条明细到 data/eval/faith/<runId>.jsonl,返回路径。 */
export function writeFaithTraces(runId: string, details: FaithTrace[]): string {
  mkdirSync(FAITH_DIR, { recursive: true });
  const path = join(FAITH_DIR, `${runId}.jsonl`);
  writeFileSync(path, details.map((d) => JSON.stringify(d)).join('\n') + '\n');
  return path;
}

/** 读回一次跑的逐条明细(供分析脚本/后续 faith compare 复用)。 */
export function readFaithTraces(runId: string): FaithTrace[] {
  const path = join(FAITH_DIR, `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FaithTrace);
}

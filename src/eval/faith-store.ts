import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Verdict } from './judge';

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
  /** retrieval case id,便于和检索 Recall 交叉对照。 */
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

export function writeFaithTraces(
  path: string,
  details: FaithTrace[],
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, details.map((d) => JSON.stringify(d)).join('\n') + '\n');
  return path;
}

export function readFaithTraces(path: string): FaithTrace[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FaithTrace);
}

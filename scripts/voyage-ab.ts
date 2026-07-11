// A2:voyage-3 vs voyage-4 A/B。对真实 bad-case + policy conflict 统计 Recall/MRR。
// 前置:VOYAGE_EMBEDDING_MODEL=voyage-4 INDEX_DIR=data/index-ab npm run index:build
// 用法:npm run voyage:ab

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETRIEVAL_CASES } from '../src/eval/cases/retrieval-cases';
import { embed } from '../src/retrieval/embeddings';
import { readIndex } from '../src/retrieval/index-store';
import { COARSE_N, rerank } from '../src/retrieval/rerank';
import { inferResource } from '../src/retrieval/router';
import { denseSearch, type IndexedChunk } from '../src/retrieval/retrieve';

interface ABCase {
  label: string;
  question: string;
  expectedChunkIds: string[];
}

interface BadCaseRow {
  id: string;
  input?: { question?: string };
  expected?: { sourceIds?: string[] };
  failure?: { type?: string };
}

interface CaseResult {
  label: string;
  recall3: number;
  recall5: number;
  reciprocalRank: number;
  top5: string[];
}

interface ModelResult {
  recall3: number;
  recall5: number;
  mrr: number;
  cases: CaseResult[];
}

function loadABCases(): ABCase[] {
  const badCases = readFileSync(
    join(process.cwd(), 'data', 'eval', 'bad-cases.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BadCaseRow)
    .filter(
      (row) =>
        row.failure?.type === 'retrieval_miss' &&
        row.input?.question &&
        row.expected?.sourceIds?.length,
    )
    .map((row) => ({
      label: row.id,
      question: row.input!.question!,
      expectedChunkIds: row.expected!.sourceIds!,
    }));

  const conflictCases = RETRIEVAL_CASES.filter(
    (c) => c.id === 'policy-conflict-latest' || c.id === 'policy-conflict-nodeport',
  ).map((c) => ({
    label: c.id,
    question: c.question,
    expectedChunkIds: c.expectedChunkIds,
  }));

  return [...badCases, ...conflictCases];
}

function recallAt(ids: string[], expected: string[], k: number): number {
  const topK = ids.slice(0, k);
  const found = expected.filter((id) => topK.includes(id)).length;
  return found / expected.length;
}

async function evaluateModel(
  label: string,
  model: string,
  indexDir: string,
  cases: ABCase[],
): Promise<ModelResult> {
  const index = readIndex(indexDir);
  if (!index) throw new Error(`索引缺失:${indexDir}`);
  if (index.manifest.embeddingModel !== model) {
    throw new Error(
      `${label} 索引模型不匹配: manifest=${index.manifest.embeddingModel}, expected=${model}`,
    );
  }

  const queryEmbeddings = await embed(
    cases.map((c) => c.question),
    'query',
    model,
  );

  const caseResults: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const ec = cases[i]!;
    const qv = queryEmbeddings[i];
    if (!qv) throw new Error(`${label}: query embedding 缺失 ${ec.label}`);

    const routed = inferResource(ec.question) ?? undefined;
    const coarse = denseSearch(qv, index.chunks as IndexedChunk[], COARSE_N, routed);
    const rr = await rerank(
      ec.question,
      coarse.map((h) => h.chunk.text),
      coarse.length,
    );
    const rankedIds = rr.map((r) => coarse[r.index]!.chunk.id);
    const firstIdx = rankedIds.findIndex((id) => ec.expectedChunkIds.includes(id));
    const result: CaseResult = {
      label: ec.label,
      recall3: recallAt(rankedIds, ec.expectedChunkIds, 3),
      recall5: recallAt(rankedIds, ec.expectedChunkIds, 5),
      reciprocalRank: firstIdx >= 0 ? 1 / (firstIdx + 1) : 0,
      top5: rankedIds.slice(0, 5),
    };
    caseResults.push(result);
    console.error(
      `[${label}] ${result.recall3 === 1 ? '✓' : '✗'} ${ec.label} ` +
        `R@3=${result.recall3.toFixed(2)} R@5=${result.recall5.toFixed(2)} MRR=${result.reciprocalRank.toFixed(3)}`,
    );
  }

  const n = caseResults.length;
  return {
    recall3: caseResults.reduce((sum, c) => sum + c.recall3, 0) / n,
    recall5: caseResults.reduce((sum, c) => sum + c.recall5, 0) / n,
    mrr: caseResults.reduce((sum, c) => sum + c.reciprocalRank, 0) / n,
    cases: caseResults,
  };
}

function printDiff(v3: ModelResult, v4: ModelResult): void {
  const v3Hits = new Set(v3.cases.filter((c) => c.recall3 === 1).map((c) => c.label));
  const v4Hits = new Set(v4.cases.filter((c) => c.recall3 === 1).map((c) => c.label));
  const gained = [...v4Hits].filter((id) => !v3Hits.has(id));
  const lost = [...v3Hits].filter((id) => !v4Hits.has(id));

  console.error('\n━━━━━━ A/B 汇总 ━━━━━━');
  console.error(
    `voyage-3: R@3 ${(v3.recall3 * 100).toFixed(1)}% | R@5 ${(v3.recall5 * 100).toFixed(1)}% | MRR ${v3.mrr.toFixed(3)}`,
  );
  console.error(
    `voyage-4: R@3 ${(v4.recall3 * 100).toFixed(1)}% | R@5 ${(v4.recall5 * 100).toFixed(1)}% | MRR ${v4.mrr.toFixed(3)}`,
  );
  console.error(`voyage-4 新命中(R@3): ${gained.join(', ') || '无'}`);
  console.error(`voyage-4 回退(R@3): ${lost.join(', ') || '无'}`);
}

async function main(): Promise<void> {
  const cases = loadABCases();
  console.error(`A/B cases: ${cases.length} 条`);

  console.error('\n=== voyage-3 (data/index) ===');
  const v3 = await evaluateModel(
    'voyage-3',
    'voyage-3',
    join(process.cwd(), 'data', 'index'),
    cases,
  );

  console.error('\n=== voyage-4 (data/index-ab) ===');
  const v4 = await evaluateModel(
    'voyage-4',
    'voyage-4',
    join(process.cwd(), 'data', 'index-ab'),
    cases,
  );

  printDiff(v3, v4);
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

//
// 用法: npm run eval        (k=3)
//       npm run eval -- 5   (k=5)
//
// 指标:
//   Recall@k —— 平均"召回的正确 chunk 占应召回的比例"(支持多 chunk 答案)。低 → 检索/切片层问题。
//   MRR      —— 第一个正确 chunk 排名倒数的均值。反映"排得够不够前"。

import { config } from 'dotenv';
config({ override: true });
import { embed, EMBEDDING_MODEL } from '../retrieval/embeddings';
import { CORPUS } from '../knowledge/corpus';
import { chunkResources } from '../knowledge/chunk';
import { RETRIEVAL_CASES } from './cases/retrieval-cases';
import { inferResource, RESOURCE_BOOST } from '../retrieval/router';
import { getCorpusIndex, searchCorpusTraced } from '../retrieval/retrieve';
import { appendTraceToPath, toTraceHit } from '../retrieval/trace';
import { RERANK_MODEL } from '../retrieval/rerank';
import { computeCorpusHash, computeIndexHash } from '../retrieval/index-store';
import {
  writeRun,
  computeEvalSetHash,
  queryExpansionRunConfig,
  type EvalRun,
  type QueryExpansionRunConfig,
} from './run-store';
import { tracePathForRun } from './artifacts';
import { retrievalMiss, upsertBadCases, type BadCase } from './bad-cases';

type Mode = 'none' | 'oracle' | 'auto';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

interface Result {
  recall: number;
  mrr: number;
}

/**
 * 跑一遍评估。
 * @param mode none=不过滤;oracle=按标注的 resource 过滤(理想上限);auto=按关键词路由过滤(真实运行时)
 */
function evaluate(
  queryEmb: number[][],
  corpusEmb: number[][],
  k: number,
  mode: Mode,
): Result {
  let recallSum = 0;
  let mrrSum = 0;
  let n = 0; // 可答用例数(分母);拒答用例不进检索指标

  for (let i = 0; i < RETRIEVAL_CASES.length; i++) {
    const ec = RETRIEVAL_CASES[i]!;
    if (!ec.answerable) continue; // 拒答用例无 expectedChunkIds,不算 Recall/MRR
    n++;
    const qv = queryEmb[i]!;

    // 决定本次过滤到哪个 resource(null=不过滤)
    const filterRes: string | null =
      mode === 'oracle'
        ? (ec.resource ?? null)
        : mode === 'auto'
          ? inferResource(ec.question)
          : null;

    const ranked = CORPUS.map((c, j) => ({
      id: c.id,
      resources: chunkResources(c),
      // ② 软加权:命中路由资源的 chunk 加分,但保留所有资源(误路由不会删掉正确答案)
      score:
        cosine(qv, corpusEmb[j]!) +
        (filterRes && chunkResources(c).includes(filterRes)
          ? RESOURCE_BOOST
          : 0),
    })).sort((a, b) => b.score - a.score);

    const topK = ranked.slice(0, k);
    const found = ec.expectedChunkIds.filter((id) =>
      topK.some((r) => r.id === id),
    );
    const recall = found.length / ec.expectedChunkIds.length;

    const firstIdx = ranked.findIndex((r) =>
      ec.expectedChunkIds.includes(r.id),
    );
    const rank = firstIdx >= 0 ? firstIdx + 1 : 0;

    recallSum += recall;
    mrrSum += rank > 0 ? 1 / rank : 0;
  }

  return {
    recall: recallSum / n,
    mrr: mrrSum / n,
  };
}

interface ServingResult extends Result {
  /** recall<1 的用例明细,供沉淀 bad-cases。 */
  misses: BadCase[];
  queryExpansion: QueryExpansionRunConfig;
}

async function evaluateServing(params: {
  k: number;
  runId: string;
  tracePath: string;
}): Promise<ServingResult> {
  const { k, runId, tracePath } = params;
  let recallSum = 0;
  let mrrSum = 0;
  let n = 0; // 可答用例数(分母)
  const misses: BadCase[] = [];
  let queryExpansion: QueryExpansionRunConfig | undefined;

  for (const ec of RETRIEVAL_CASES) {
    if (!ec.answerable) continue; // 拒答用例不进检索指标
    n++;
    const routed = inferResource(ec.question) ?? undefined;
    const { hits: ranked, trace: st } = await searchCorpusTraced(ec.question, {
      boostResource: routed,
    });
    if (!queryExpansion && st.queryExpansion) {
      queryExpansion = queryExpansionRunConfig(st.queryExpansion);
    }

    const ids = ranked.map((r) => r.chunk.id);
    const topK = ids.slice(0, k);
    const found = ec.expectedChunkIds.filter((id) => topK.includes(id));
    const recall = found.length / ec.expectedChunkIds.length;
    const firstIdx = ids.findIndex((id) => ec.expectedChunkIds.includes(id));
    const rank = firstIdx >= 0 ? firstIdx + 1 : 0;

    recallSum += recall;
    mrrSum += rank > 0 ? 1 / rank : 0;

    appendTraceToPath(tracePath, {
      ...st,
      question: ec.question,
      mode: 'free',
      resourceHint: routed,
      fieldPathHint: undefined,
      path: 'search',
      finalHits: ranked.slice(0, k).map((h) => toTraceHit(h.chunk, h.score)),
      createdAt: new Date().toISOString(),
    });

    if (recall < 1) {
      misses.push(
        retrievalMiss({
          evalCaseId: ec.id,
          runId,
          question: ec.question,
          resource: ec.resource!, // 已过 answerable 守卫,可答用例必有 resource
          expectedChunkIds: ec.expectedChunkIds,
          actualTopIds: topK,
          rankedIds: ids,
          k,
        }),
      );
    }
  }

  if (!queryExpansion) {
    throw new Error('serving eval 未产生 query expansion trace');
  }

  return {
    recall: recallSum / n,
    mrr: mrrSum / n,
    misses,
    queryExpansion,
  };
}

async function main(): Promise<void> {
  const k = Number(process.argv[2]) || 3;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const tracePath = tracePathForRun(runId, 'retrieval');
  const answerable = RETRIEVAL_CASES.filter((c) => c.answerable).length;
  console.error(
    `评估(k=${k},语料 ${CORPUS.length} 段,标注 ${RETRIEVAL_CASES.length} 条 / 可答 ${answerable} 条,检索指标仅算可答)\n`,
  );

  const index = await getCorpusIndex();
  const corpusEmb = index.map((c) => c.embedding);
  const queryEmb = await embed(
    RETRIEVAL_CASES.map((c) => c.question),
    'query',
  );

  const none = evaluate(queryEmb, corpusEmb, k, 'none');
  const oracle = evaluate(queryEmb, corpusEmb, k, 'oracle');
  const auto = evaluate(queryEmb, corpusEmb, k, 'auto');
  const reranked = await evaluateServing({ k, runId, tracePath });

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.error('━━━━━━ 汇总 对比 ━━━━━━');
  console.error('模式            Recall   MRR');
  console.error(`① 无过滤        ${pct(none.recall)}   ${none.mrr.toFixed(3)}`);
  console.error(
    `② oracle 过滤   ${pct(oracle.recall)}   ${oracle.mrr.toFixed(3)}   ← 理想上限(路由全对)`,
  );
  console.error(
    `③ auto 路由     ${pct(auto.recall)}   ${auto.mrr.toFixed(3)}   ← 诊断:纯向量软加权(无 rerank)`,
  );
  console.error(
    `④ serving 路径  ${pct(reranked.recall)}   ${reranked.mrr.toFixed(3)}   ← == 线上(searchCorpusTraced,官方指标)`,
  );
  console.error(
    '\n说明:①②③ 是同一索引上的诊断对照;④ 与线上 retrieveContext 走同一段 searchCorpusTraced 代码,是预测线上的官方指标。',
  );

  // 落 run 文件(§4.2):serving 为官方指标,同时记诊断三档便于回溯。compare 只 diff 共有 key。
  const metrics: Record<string, number> = {
    [`serving.recall@${k}`]: reranked.recall,
    [`serving.mrr@${k}`]: reranked.mrr,
    [`auto.recall@${k}`]: auto.recall,
    [`auto.mrr@${k}`]: auto.mrr,
    [`oracle.recall@${k}`]: oracle.recall,
    [`oracle.mrr@${k}`]: oracle.mrr,
    [`none.recall@${k}`]: none.recall,
    [`none.mrr@${k}`]: none.mrr,
  };
  const corpusHash = computeCorpusHash(CORPUS);
  const run: EvalRun = {
    id: runId,
    kind: 'retrieval',
    createdAt: new Date().toISOString(),
    artifactPaths: { tracePath },
    corpusHash,
    indexHash: computeIndexHash(corpusHash, EMBEDDING_MODEL),
    evalSetHash: computeEvalSetHash(RETRIEVAL_CASES),
    embeddingModel: EMBEDDING_MODEL,
    rerankModel: RERANK_MODEL,
    queryExpansion: reranked.queryExpansion,
    k,
    metrics,
  };
  const runPath = writeRun(run);

  // §4.5:沉淀 serving 未命中用例到 bad-cases.jsonl。
  const added = upsertBadCases(reranked.misses);
  console.error(
    `\n运行结果已写入 ${runPath}` +
      `\nserving 未命中 ${reranked.misses.length} 条,新沉淀 bad-cases ${added} 条` +
      `\n对比 baseline:npm run eval:compare\n晋升为 baseline:npm run eval:promote -- ${runPath}`,
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

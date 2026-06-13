// 迭代 3 路线(测量 → 逐个优化,每步都重跑 eval 对比)

// ① 评估基线(Recall@k / MRR)        ← 刚建好,先跑出基线数字 ✅
// ② 元数据过滤(按 resource 类型)     ← 干掉 PVC/快照跨域串味
// ③ Hybrid(向量 + 关键词 BM25)       ← 字段名精确匹配兜底
// ④ Rerank(粗召回→精排)             ← 解决近义项抢位,提升 MRR
// ⑤ 结构化切片 + 真向量库(pgvector)  ← 语料规模化

// 检索评估。迭代3:一次跑两遍 —— ①无过滤基线 vs ②元数据过滤,直接对比指标。
// 只用 embedding(2 次批量请求:语料 + 所有问题),不调作答 LLM,便宜且避开 Voyage 限流。
//
// 用法: npm run eval        (k=3)
//       npm run eval -- 5   (k=5)
//
// 指标:
//   Recall@k —— 平均"召回的正确 chunk 占应召回的比例"(支持多 chunk 答案)。低 → 检索/切片层问题。
//   MRR      —— 第一个正确 chunk 排名倒数的均值。反映"排得够不够前"。

import { config } from 'dotenv';
config({ override: true });
import { embed } from './embeddings';
import { CORPUS } from './corpus';
import { EVAL_SET } from './eval-set';
import { inferResource, RESOURCE_BOOST } from './router';
import { rerank, COARSE_N } from './rerank';

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
  lines: string[];
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
  const lines: string[] = [];

  for (let i = 0; i < EVAL_SET.length; i++) {
    const ec = EVAL_SET[i]!;
    const qv = queryEmb[i]!;

    // 决定本次过滤到哪个 resource(null=不过滤)
    const filterRes: string | null =
      mode === 'oracle'
        ? ec.resource
        : mode === 'auto'
          ? inferResource(ec.question)
          : null;

    const ranked = CORPUS.map((c, j) => ({
      id: c.id,
      resource: c.resource,
      // ② 软加权:命中路由资源的 chunk 加分,但保留所有资源(误路由不会删掉正确答案)
      score: cosine(qv, corpusEmb[j]!) + (filterRes && c.resource === filterRes ? RESOURCE_BOOST : 0),
    }))
      .sort((a, b) => b.score - a.score);

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

    lines.push(
      `${recall === 1 ? '✓' : '✗'} recall=${found.length}/${ec.expectedChunkIds.length} rank=${rank || '未召回'} [→${filterRes ?? '全量'}] | ${ec.question}`,
    );
  }

  return {
    recall: recallSum / EVAL_SET.length,
    mrr: mrrSum / EVAL_SET.length,
    lines,
  };
}

/** ④ rerank:向量粗召回 top-N → Voyage rerank 精排。逐条调用 rerank API(每问一次)。 */
async function evaluateRerank(
  queryEmb: number[][],
  corpusEmb: number[][],
  k: number,
  coarseN: number,
): Promise<Result> {
  let recallSum = 0;
  let mrrSum = 0;
  const lines: string[] = [];

  for (let i = 0; i < EVAL_SET.length; i++) {
    const ec = EVAL_SET[i]!;
    const qv = queryEmb[i]!;

    // 粗召回:向量 top-N(不过滤,隔离出 rerank 的纯贡献)
    const coarse = CORPUS.map((c, j) => ({ id: c.id, text: c.text, score: cosine(qv, corpusEmb[j]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, coarseN);

    // 精排:rerank 全部候选(top_k=coarseN,拿到完整重排序才好算 MRR)
    const rr = await rerank(ec.question, coarse.map((c) => c.text), coarseN);
    const rankedIds = rr.map((r) => coarse[r.index]!.id);

    const topK = rankedIds.slice(0, k);
    const found = ec.expectedChunkIds.filter((id) => topK.includes(id));
    const recall = found.length / ec.expectedChunkIds.length;
    const firstIdx = rankedIds.findIndex((id) => ec.expectedChunkIds.includes(id));
    const rank = firstIdx >= 0 ? firstIdx + 1 : 0;

    recallSum += recall;
    mrrSum += rank > 0 ? 1 / rank : 0;
    lines.push(
      `${recall === 1 ? '✓' : '✗'} recall=${found.length}/${ec.expectedChunkIds.length} rank=${rank || '未召回'} [rerank] | ${ec.question}`,
    );
  }

  return { recall: recallSum / EVAL_SET.length, mrr: mrrSum / EVAL_SET.length, lines };
}

async function main(): Promise<void> {
  const k = Number(process.argv[2]) || 3;
  console.error(
    `评估(k=${k},语料 ${CORPUS.length} 段,标注 ${EVAL_SET.length} 条)\n`,
  );

  const corpusEmb = await embed(
    CORPUS.map((c) => c.text),
    'document',
  );
  const queryEmb = await embed(
    EVAL_SET.map((c) => c.question),
    'query',
  );

  const none = evaluate(queryEmb, corpusEmb, k, 'none');
  const oracle = evaluate(queryEmb, corpusEmb, k, 'oracle');
  const auto = evaluate(queryEmb, corpusEmb, k, 'auto');
  console.error(`(④ rerank:逐条调用 Voyage rerank,共 ${EVAL_SET.length} 次,稍候...)\n`);
  const reranked = await evaluateRerank(queryEmb, corpusEmb, k, COARSE_N);

  console.error('━━━━━━ ① 无过滤基线 ━━━━━━');
  console.error(none.lines.join('\n'));
  console.error(
    `Recall@${k} = ${(none.recall * 100).toFixed(1)}%   MRR = ${none.mrr.toFixed(3)}\n`,
  );

  console.error('━━━━━━ ② oracle 过滤(标注 resource,理想上限)━━━━━━');
  console.error(oracle.lines.join('\n'));
  console.error(
    `Recall@${k} = ${(oracle.recall * 100).toFixed(1)}%   MRR = ${oracle.mrr.toFixed(3)}\n`,
  );

  console.error('━━━━━━ ③ auto 路由(关键词,真实运行时)━━━━━━');
  console.error(auto.lines.join('\n'));
  console.error(
    `Recall@${k} = ${(auto.recall * 100).toFixed(1)}%   MRR = ${auto.mrr.toFixed(3)}\n`,
  );

  console.error(`━━━━━━ ④ rerank(向量粗召回 top-${COARSE_N} → 精排)━━━━━━`);
  console.error(reranked.lines.join('\n'));
  console.error(
    `Recall@${k} = ${(reranked.recall * 100).toFixed(1)}%   MRR = ${reranked.mrr.toFixed(3)}\n`,
  );

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.error('━━━━━━ 汇总对比 ━━━━━━');
  console.error('模式            Recall   MRR');
  console.error(`① 无过滤        ${pct(none.recall)}   ${none.mrr.toFixed(3)}`);
  console.error(
    `② oracle 过滤   ${pct(oracle.recall)}   ${oracle.mrr.toFixed(3)}   ← 理想上限(路由全对)`,
  );
  console.error(
    `③ auto 路由     ${pct(auto.recall)}   ${auto.mrr.toFixed(3)}   ← 关键词路由实际`,
  );
  console.error(
    `④ rerank       ${pct(reranked.recall)}   ${reranked.mrr.toFixed(3)}   ← 粗召回+精排(不靠路由)`,
  );
  console.error(
    '\n看点:④ 能不能把"必填字段"那条多 chunk 召回救起来(① 里它一直 recall=1/2)。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

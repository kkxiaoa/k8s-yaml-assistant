// 生成层评估:Faithfulness(忠于检索 context / 防幻觉)。Stage 5(§7.2)。
// 用法: npm run eval:faith        全量(逐条 rerank,~25-30min)
//       npm run eval:faith -- 2   冒烟:可答/拒答各前 2 条

import { config } from 'dotenv';
config({ override: true });
import type Anthropic from '@anthropic-ai/sdk';
import { searchCorpusTraced } from '../retrieval/retrieve';
import { formatSources } from '../retrieval/sources';
import { inferResource } from '../retrieval/router';
import { getClient } from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';
import { MODEL, generateAnswer } from './answer';
import { EVAL_SET, type EvalCase } from './eval-set';
import { CORPUS } from '../knowledge/corpus';
import { EMBEDDING_MODEL } from '../retrieval/embeddings';
import { RERANK_MODEL } from '../retrieval/rerank';
import { computeCorpusHash, computeIndexHash } from '../retrieval/index-store';
import { writeRun, computeEvalSetHash, type EvalRun } from './run-store';
import {
  writeFaithTraces,
  type FaithTrace,
  type FaithOutcome,
} from './faith-store';

/** 上下文取 rerank 后 top-3,与 serving Recall@3 baseline 对齐,归因才干净。 */
const CONTEXT_K = 3;

/** 冒烟子集:可答/拒答各取前 n 条,覆盖两条分支。不传 = 全量 EVAL_SET。 */
function selectCases(smokeN: number | null): EvalCase[] {
  if (smokeN === null) return EVAL_SET;
  const answerable = EVAL_SET.filter((c) => c.answerable).slice(0, smokeN);
  const refusal = EVAL_SET.filter((c) => !c.answerable).slice(0, smokeN);
  return [...answerable, ...refusal];
}

async function processCase(
  client: Anthropic,
  ec: EvalCase,
): Promise<FaithTrace> {
  const routed = inferResource(ec.question) ?? undefined;
  const { hits } = await searchCorpusTraced(ec.question, {
    boostResource: routed,
  });
  const top = hits.slice(0, CONTEXT_K);
  const { context } = formatSources(top.map((h) => h.chunk));
  const topIds = top.map((h) => h.chunk.id);
  const foundCount = ec.answerable
    ? ec.expectedChunkIds.filter((id) => topIds.includes(id)).length
    : 0;
  const fullRecall = ec.answerable && foundCount === ec.expectedChunkIds.length;

  const answer = await generateAnswer(client, context, ec.question);
  const v = await judge(client, context, answer);

  // 归因 = faithful × fullRecall:检索✓+不忠=真幻觉;检索✗+不忠=检索漏+没守拒答边界
  const outcome: FaithOutcome =
    v === null
      ? 'judge_failed'
      : !ec.answerable
        ? v.faithful
          ? 'refused_correctly'
          : 'refused_wrong'
        : v.faithful
          ? fullRecall
            ? 'faithful_hit'
            : 'faithful_miss'
          : fullRecall
            ? 'hallucination'
            : 'dual_cause';

  return {
    id: ec.id,
    question: ec.question,
    answerable: ec.answerable,
    resource: ec.resource,
    retrieval: {
      routed,
      expectedChunkIds: ec.expectedChunkIds,
      topIds,
      foundCount,
      fullRecall,
    },
    answer,
    verdict: v,
    outcome,
  };
}

/** 重试整条:遇网络/异常先短延迟重试,retries 次后仍失败则抛(交给上层记 error)。 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();

  const smokeArg = process.argv[2];
  const smokeN = smokeArg ? Number(smokeArg) : null;
  const cases = selectCases(smokeN);
  console.error(
    `Faithfulness 评估(${cases.length} 条${smokeN ? `,冒烟:可答/拒答各 ${smokeN}` : ''}:检索→生成→裁判,逐条调用,稍候)\n`,
  );

  let faithfulCount = 0; // 忠于检索 context(faithfulness 分子)
  let judgedCount = 0; // 判定成功数(分母)
  let hallucination = 0; // 检索✓ 却不忠 = 真幻觉
  let dualCause = 0; // 检索✗ 且不忠 = 检索漏 + 没守拒答边界
  let refusalTotal = 0;
  let refusedCorrectly = 0; // 拒答用例里正确拒答(忠实=没编造)数
  let judgeFailed = 0; // 裁判两次未给有效 JSON
  let errorCount = 0; // 网络/异常失败(重试后仍失败)
  const traces: FaithTrace[] = []; // 逐条明细,循环后写盘

  for (const ec of cases) {
    const tag = ec.answerable ? '[可答]' : '[应拒答]';
    // 整条(检索→生成→裁判)当一个单元:失败先重试一次,仍失败记 error 继续,不炸全批
    let trace: FaithTrace;
    try {
      trace = await withRetry(() => processCase(client, ec), 1, 2000);
    } catch (e) {
      errorCount++;
      trace = {
        id: ec.id,
        question: ec.question,
        answerable: ec.answerable,
        resource: ec.resource,
        retrieval: {
          expectedChunkIds: ec.expectedChunkIds,
          topIds: [],
          foundCount: 0,
          fullRecall: false,
        },
        answer: '',
        verdict: null,
        outcome: 'error',
      };
      traces.push(trace);
      continue;
    }
    traces.push(trace);

    const { verdict: v, retrieval } = trace;
    const { fullRecall, foundCount, expectedChunkIds } = retrieval;
    const retr = ec.answerable
      ? ` 检索${fullRecall ? '✓' : '✗'}${expectedChunkIds.length > 1 ? ` ${foundCount}/${expectedChunkIds.length}` : ''}`
      : '';
    const ans = trace.answer.replace(/\s+/g, ' ').slice(0, 90);

    if (v === null) {
      judgeFailed++;
      console.error(
        `⚠ 判定失败(裁判两次未给有效 JSON) ${tag}${retr} | ${ec.question}`,
      );
      console.error(`   回答: ${ans}...`);
      continue;
    }

    judgedCount++;
    if (v.faithful) faithfulCount++;
    if (!ec.answerable) {
      refusalTotal++;
      if (v.faithful) refusedCorrectly++; // 不可答 + 忠实(没编造)= 正确拒答
    } else if (!v.faithful) {
      if (fullRecall) hallucination++;
      else dualCause++;
    }

    console.error(
      `${v.faithful ? '✓忠实' : '✗不忠'} ${tag}${retr} | ${ec.question}`,
    );
    console.error(`   回答: ${ans}...`);
    if (!v.faithful)
      console.error(`   未支持: ${v.unsupported.join(' / ')}  (${v.reason})`);
  }

  console.error('\n━━━━━━ 汇总 ━━━━━━');
  console.error(
    `Faithfulness 率 = ${judgedCount ? ((faithfulCount / judgedCount) * 100).toFixed(1) : '—'}%  (${faithfulCount}/${judgedCount})`,
  );
  console.error(
    `拒答正确率(应拒答的)= ${refusalTotal ? ((refusedCorrectly / refusalTotal) * 100).toFixed(1) : '—'}%  (${refusedCorrectly}/${refusalTotal})`,
  );
  console.error(
    `归因(可答不忠实)= 真幻觉(检索✓却瞎编)${hallucination} 条 / 检索漏+编造(检索✗)${dualCause} 条`,
  );
  console.error(
    `判定失败= ${judgeFailed} 条 / 网络异常= ${errorCount} 条(均不计入)`,
  );
  console.error(
    `注:被测=${MODEL}(flash),裁判=${JUDGE_MODEL}(pro)。Faithfulness=只忠于检索 context,不等于事实正确。`,
  );

  // 落盘:逐条明细(faith/<id>.jsonl)+ 汇总(runs/<id>.json,kind=faith,可对比 baseline)。冒烟带 -smoke。
  const id =
    new Date().toISOString().replace(/[:.]/g, '-') + (smokeN ? '-smoke' : '');
  const tracePath = writeFaithTraces(id, traces);
  const corpusHash = computeCorpusHash(CORPUS);
  const run: EvalRun = {
    id,
    kind: 'faith',
    createdAt: new Date().toISOString(),
    corpusHash,
    indexHash: computeIndexHash(corpusHash, EMBEDDING_MODEL),
    evalSetHash: computeEvalSetHash(EVAL_SET),
    embeddingModel: EMBEDDING_MODEL,
    rerankModel: RERANK_MODEL,
    answerModel: MODEL,
    k: CONTEXT_K,
    metrics: {
      'faith.faithful_rate': judgedCount ? faithfulCount / judgedCount : 0,
      'faith.refusal_correct_rate': refusalTotal
        ? refusedCorrectly / refusalTotal
        : 0,
      'faith.hallucination': hallucination,
      'faith.dual_cause': dualCause,
      'faith.judged': judgedCount,
      'faith.judge_failed': judgeFailed,
      'faith.error': errorCount,
    },
  };
  const runPath = writeRun(run);
  console.error(
    `\n逐条明细 → ${tracePath}\n汇总 run → ${runPath}` +
      (smokeN ? '  (冒烟,带 -smoke 标记,勿晋升 baseline)' : ''),
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

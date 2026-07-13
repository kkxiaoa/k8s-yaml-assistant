// 用法: npm run eval        (k=3)
//       npm run eval -- 5   (k=5)

import { config } from 'dotenv';
import { embed } from '../retrieval/embeddings';
import { CORPUS } from '../knowledge/corpus';
import { chunkResources } from '../knowledge/chunk';
import type { RetrievalEvalCase } from './cases/retrieval-cases';
import { inferResource, RESOURCE_BOOST } from '../retrieval/router';
import { getCorpusIndex, searchCorpusTraced } from '../retrieval/retrieve';
import { toTraceHit, type RetrievalTrace } from '../retrieval/trace';
import { retrievalMiss, upsertBadCases, type BadCase } from './bad-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import { metricObservation } from './protocol';
import {
  LEGACY_METRIC_DEFINITION_VERSION,
  buildRetrievalEvalTracePayload,
  isDirectExecution,
  retrievalDatasetIdentity,
  retrievalEvalConfig,
  selectRetrievalCases,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
  type EvalRunSession,
} from './run-session';

type Mode = 'none' | 'oracle' | 'auto';

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

interface Result {
  recall: number | null;
  mrr: number | null;
  recallNumerator: number;
  mrrNumerator: number;
  caseCount: number;
}

function result(recallNumerator: number, mrrNumerator: number, n: number): Result {
  return {
    recall: n ? recallNumerator / n : null,
    mrr: n ? mrrNumerator / n : null,
    recallNumerator,
    mrrNumerator,
    caseCount: n,
  };
}

function evaluate(
  cases: readonly RetrievalEvalCase[],
  queryEmbeddings: number[][],
  corpusEmbeddings: number[][],
  k: number,
  mode: Mode,
): Result {
  let recallSum = 0;
  let mrrSum = 0;

  for (let index = 0; index < cases.length; index++) {
    const evalCase = cases[index]!;
    const queryEmbedding = queryEmbeddings[index]!;
    const filterResource =
      mode === 'oracle'
        ? (evalCase.resource ?? null)
        : mode === 'auto'
          ? inferResource(evalCase.question)
          : null;

    const ranked = CORPUS.map((chunk, chunkIndex) => ({
      id: chunk.id,
      score:
        cosine(queryEmbedding, corpusEmbeddings[chunkIndex]!) +
        (filterResource && chunkResources(chunk).includes(filterResource)
          ? RESOURCE_BOOST
          : 0),
    })).sort((left, right) => right.score - left.score);
    const topK = ranked.slice(0, k);
    const foundCount = evalCase.expectedChunkIds.filter((id) =>
      topK.some((item) => item.id === id),
    ).length;
    const firstIndex = ranked.findIndex((item) =>
      evalCase.expectedChunkIds.includes(item.id),
    );

    recallSum += foundCount / evalCase.expectedChunkIds.length;
    mrrSum += firstIndex < 0 ? 0 : 1 / (firstIndex + 1);
  }

  return result(recallSum, mrrSum, cases.length);
}

interface ServingResult extends Result {
  misses: BadCase[];
}

async function evaluateServing(params: {
  cases: readonly RetrievalEvalCase[];
  k: number;
  runId: string;
  session: EvalRunSession;
}): Promise<ServingResult> {
  const { cases, k, runId, session } = params;
  let recallSum = 0;
  let mrrSum = 0;
  const misses: BadCase[] = [];

  for (const evalCase of cases) {
    const routed = inferResource(evalCase.question) ?? undefined;
    const stage = `case:${evalCase.id}:retrieval`;
    let rankedIds: string[];
    let payload: ReturnType<typeof buildRetrievalEvalTracePayload>;
    try {
      const { hits: ranked, trace } = await searchCorpusTraced(
        evalCase.question,
        { boostResource: routed },
      );
      rankedIds = ranked.map((item) => item.chunk.id);
      const retrievalTrace = toPersistedPayload({
          ...trace,
          question: evalCase.question,
          mode: 'free',
          resourceHint: routed,
          path: 'search',
          finalHits: ranked
            .slice(0, k)
            .map((item) => toTraceHit(item.chunk, item.score)),
          createdAt: new Date().toISOString(),
        }) satisfies RetrievalTrace;
      payload = buildRetrievalEvalTracePayload({
        trace: retrievalTrace,
        expectedChunkIds: evalCase.expectedChunkIds,
        rankedIds,
        k,
      });
    } catch (error) {
      session.appendCase(
        createErrorTraceEnvelope({
          runId,
          evalCaseId: evalCase.id,
          kind: 'retrieval',
          payload: {
            expected: { chunkIds: evalCase.expectedChunkIds, k },
          },
          stage,
          error,
        }),
      );
      throw error;
    }

    const envelope = createTraceEnvelope({
      runId,
      evalCaseId: evalCase.id,
      kind: 'retrieval',
      outcome: payload.ranking.recall === 1 ? 'success' : 'failed',
      payload,
    });
    session.appendCase(envelope);
    recallSum += payload.ranking.recall;
    mrrSum += payload.ranking.reciprocalRank;

    if (payload.ranking.recall < 1) {
      misses.push(
        retrievalMiss({
          evalCaseId: evalCase.id,
          runId,
          traceId: envelope.traceId,
          question: evalCase.question,
          resource: evalCase.resource!,
          expectedChunkIds: evalCase.expectedChunkIds,
          actualTopIds: payload.ranking.topKIds,
          rankedIds,
          k,
        }),
      );
    }
  }

  return { ...result(recallSum, mrrSum, cases.length), misses };
}

function formatRate(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatMrr(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(3);
}

async function main(): Promise<void> {
  const k = Number(process.argv[2]) || 3;
  const cases = selectRetrievalCases();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runConfig = retrievalEvalConfig(k);
  const session = startEvalRun({
    id: runId,
    kind: 'retrieval',
    scope: 'full',
    dataset: retrievalDatasetIdentity(cases),
    metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
    config: runConfig,
  });
  let stage = 'initialize';
  let serving: ServingResult;

  try {
    console.error(
      `评估(k=${k},语料 ${CORPUS.length} 段,标注 ${cases.length} 条,检索指标仅算可答)\n`,
    );
    stage = 'index';
    const index = await getCorpusIndex();
    const corpusEmbeddings = index.map((chunk) => chunk.embedding);
    stage = 'query_embedding';
    const queryEmbeddings = await embed(
      cases.map((evalCase) => evalCase.question),
      'query',
      runConfig.embeddingModel,
    );

    const none = evaluate(cases, queryEmbeddings, corpusEmbeddings, k, 'none');
    const oracle = evaluate(
      cases,
      queryEmbeddings,
      corpusEmbeddings,
      k,
      'oracle',
    );
    const auto = evaluate(cases, queryEmbeddings, corpusEmbeddings, k, 'auto');
    stage = 'serving_retrieval';
    serving = await evaluateServing({ cases, k, runId, session });

    console.error('━━━━━━ 汇总 对比 ━━━━━━');
    console.error('模式            Recall   MRR');
    console.error(
      `① 无过滤        ${formatRate(none.recall)}   ${formatMrr(none.mrr)}`,
    );
    console.error(
      `② oracle 过滤   ${formatRate(oracle.recall)}   ${formatMrr(oracle.mrr)}   ← 理想上限(路由全对)`,
    );
    console.error(
      `③ auto 路由     ${formatRate(auto.recall)}   ${formatMrr(auto.mrr)}   ← 诊断:纯向量软加权(无 rerank)`,
    );
    console.error(
      `④ serving 路径  ${formatRate(serving.recall)}   ${formatMrr(serving.mrr)}   ← == 线上(searchCorpusTraced,官方指标)`,
    );
    console.error(
      '\n说明:①②③ 是同一索引上的诊断对照;④ 与线上 retrieveContext 走同一段 searchCorpusTraced 代码,是预测线上的官方指标。',
    );

    stage = 'complete';
    session.complete({
      [`serving.recall@${k}`]: metricObservation(
        serving.recall,
        serving.recallNumerator,
        serving.caseCount,
      ),
      [`serving.mrr@${k}`]: metricObservation(
        serving.mrr,
        serving.mrrNumerator,
        serving.caseCount,
      ),
      [`auto.recall@${k}`]: metricObservation(
        auto.recall,
        auto.recallNumerator,
        auto.caseCount,
      ),
      [`auto.mrr@${k}`]: metricObservation(
        auto.mrr,
        auto.mrrNumerator,
        auto.caseCount,
      ),
      [`oracle.recall@${k}`]: metricObservation(
        oracle.recall,
        oracle.recallNumerator,
        oracle.caseCount,
      ),
      [`oracle.mrr@${k}`]: metricObservation(
        oracle.mrr,
        oracle.mrrNumerator,
        oracle.caseCount,
      ),
      [`none.recall@${k}`]: metricObservation(
        none.recall,
        none.recallNumerator,
        none.caseCount,
      ),
      [`none.mrr@${k}`]: metricObservation(
        none.mrr,
        none.mrrNumerator,
        none.caseCount,
      ),
    });
  } catch (error) {
    session.fail(stage, error);
    throw error;
  }

  const added = upsertBadCases(serving.misses);
  const tracePath = evalArtifactPath(traceRelativePath(runId, 'retrieval'));
  console.error(
    `\n逐条 trace → ${tracePath}` +
      `\n运行结果 → ${runPath(runId)}` +
      `\nserving 未命中 ${serving.misses.length} 条,新沉淀 bad-cases ${added} 条` +
      '\n指标仍使用 legacy-v1 定义,当前 run 不可晋升 baseline。',
  );
}

if (isDirectExecution(import.meta.url)) {
  config({ override: true });
  main().catch((error: unknown) => {
    console.error('错误:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

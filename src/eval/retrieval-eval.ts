// 用法: npm run eval        (k=3)
//       npm run eval -- 5   (k=5)

import { config } from 'dotenv';
import { CORPUS } from '../knowledge/corpus';
import type { SemanticRetrievalCase } from './cases/retrieval-cases';
import { inferResource } from '../retrieval/router';
import { searchCorpusTraced } from '../retrieval/retrieve';
import { toTraceHit, type RetrievalTrace } from '../retrieval/trace';
import { retrievalMiss, upsertBadCases, type BadCase } from './bad-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import { metricObservation, type TraceEnvelope } from './protocol';
import {
  LEGACY_METRIC_DEFINITION_VERSION,
  buildRetrievalEvalTracePayload,
  harnessErrorMetrics,
  isDirectExecution,
  retrievalDatasetIdentity,
  retrievalExecutionError,
  retrievalEvalConfig,
  selectRetrievalCases,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  executeEvalCaseStage,
  executeEvalCases,
  executeEvalRunStage,
  failEvalRunSession,
  startEvalRun,
  type EvalRunSession,
} from './run-session';

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

interface SemanticResult extends Result {
  misses: BadCase[];
  harnessErrorCount: number;
}

interface SemanticCaseResult {
  evalCase: SemanticRetrievalCase;
  rankedIds: string[];
  payload: ReturnType<typeof buildRetrievalEvalTracePayload>;
  envelope: TraceEnvelope<
    'retrieval',
    ReturnType<typeof buildRetrievalEvalTracePayload>
  >;
}

async function evaluateSemanticSearch(params: {
  cases: readonly SemanticRetrievalCase[];
  k: number;
  runId: string;
  session: EvalRunSession;
}): Promise<SemanticResult> {
  const { cases, k, runId, session } = params;
  const batch = await executeEvalCases({
    cases,
    evaluate: async (evalCase): Promise<SemanticCaseResult> => {
      const routed = inferResource(evalCase.question) ?? undefined;
      const errorPayload = {
        expected: { chunkIds: evalCase.expectedChunkIds, k },
      };
      let ranked: Awaited<ReturnType<typeof searchCorpusTraced>>['hits'];
      let trace: Awaited<ReturnType<typeof searchCorpusTraced>>['trace'];
      try {
        ({ hits: ranked, trace } = await searchCorpusTraced(
          evalCase.question,
          { boostResource: routed },
        ));
      } catch (error) {
        throw retrievalExecutionError(error, () => errorPayload);
      }

      return executeEvalCaseStage(
        'trace_payload',
        () => {
          const rankedIds = ranked.map((item) => item.chunk.id);
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
          const payload = buildRetrievalEvalTracePayload({
            trace: retrievalTrace,
            expectedChunkIds: evalCase.expectedChunkIds,
            rankedIds,
            k,
          });
          const envelope = createTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'retrieval',
            outcome: payload.ranking.recall === 1 ? 'success' : 'failed',
            payload,
          });
          return { evalCase, rankedIds, payload, envelope };
        },
        errorPayload,
      );
    },
    appendSuccess: (_evalCase, value) => session.appendCase(value.envelope),
    appendError: (evalCase, failure) => {
      session.appendCase(
        createErrorTraceEnvelope({
          runId,
          evalCaseId: evalCase.id,
          kind: 'retrieval',
          payload:
            failure.payload ?? {
              expected: { chunkIds: evalCase.expectedChunkIds, k },
            },
          stage: failure.stage,
          error: failure.originalError,
        }),
      );
    },
  });

  let recallSum = 0;
  let mrrSum = 0;
  const misses: BadCase[] = [];
  for (const value of batch.results) {
    recallSum += value.payload.ranking.recall;
    mrrSum += value.payload.ranking.reciprocalRank;
    if (value.payload.ranking.recall < 1) {
      misses.push(
        retrievalMiss({
          evalCaseId: value.evalCase.id,
          runId,
          traceId: value.envelope.traceId,
          question: value.evalCase.question,
          resource: value.evalCase.target.kind,
          expectedChunkIds: value.evalCase.expectedChunkIds,
          actualTopIds: value.payload.ranking.topKIds,
          rankedIds: value.rankedIds,
          k,
        }),
      );
    }
  }

  return {
    ...result(recallSum, mrrSum, batch.results.length),
    misses,
    harnessErrorCount: batch.harnessErrors.length,
  };
}

function formatRate(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatMrr(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(3);
}

async function main(): Promise<void> {
  const k = Number(process.argv[2]) || 3;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const setup = await executeEvalRunStage('dataset_preflight', () => {
    const cases = selectRetrievalCases();
    return {
      cases,
      dataset: retrievalDatasetIdentity(cases),
      config: retrievalEvalConfig(k),
    };
  });
  const { cases } = setup;
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'retrieval',
      scope: 'full',
      dataset: setup.dataset,
      metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
      config: setup.config,
    }),
  );
  let semantic: SemanticResult;
  let added = 0;
  let completed = false;

  try {
    console.error(
      `评估(k=${k},语料 ${CORPUS.length} 段,语义检索标注 ${cases.length} 条)\n`,
    );
    semantic = await evaluateSemanticSearch({ cases, k, runId, session });

    console.error('━━━━━━ 语义检索汇总 ━━━━━━');
    console.error(
      `Recall@${k}=${formatRate(semantic.recall)}  MRR@${k}=${formatMrr(semantic.mrr)}`,
    );
    console.error(
      `quality fail=${semantic.misses.length} 条；skipped=0 条；harness error=${semantic.harnessErrorCount} 条；质量分母=${semantic.caseCount}/${cases.length}`,
    );
    console.error(
      'EditorContext exact-field 分流由独立确定性测试覆盖。',
    );

    const metrics = await executeEvalRunStage('metric_aggregation', () => ({
      'retrieval.semantic.recall': metricObservation(
        semantic.recall,
        semantic.recallNumerator,
        semantic.caseCount,
      ),
      'retrieval.semantic.mrr': metricObservation(
        semantic.mrr,
        semantic.mrrNumerator,
        semantic.caseCount,
      ),
      ...harnessErrorMetrics('retrieval', semantic.harnessErrorCount),
    }));
    added = await executeEvalRunStage('artifact_write', () =>
      upsertBadCases(semantic.misses),
    );
    await executeEvalRunStage('artifact_write', () => session.complete(metrics));
    completed = true;
  } catch (error) {
    if (!completed) failEvalRunSession(session, error);
    throw error;
  }

  const tracePath = evalArtifactPath(traceRelativePath(runId, 'retrieval'));
  console.error(
    `\n逐条 trace → ${tracePath}` +
      `\n运行结果 → ${runPath(runId)}` +
      `\n语义检索未命中 ${semantic.misses.length} 条,新沉淀 bad-cases ${added} 条` +
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

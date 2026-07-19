// 用法: npm run eval                       (tuning, k=3)
//       npm run eval -- 5                  (tuning, k=5)
//       npm run eval -- --holdout          (holdout, k=3)
//       npm run eval -- 5 --full           (full, k=5)

import { config } from 'dotenv';
import { CORPUS } from '../knowledge/corpus';
import type { SemanticRetrievalCase } from './cases/retrieval-cases';
import { inferResource } from '../retrieval/router';
import { searchCorpusTraced } from '../retrieval/retrieve';
import { toTraceHit, type RetrievalTrace } from '../retrieval/trace';
import { retrievalMiss, upsertBadCases, type BadCase } from './bad-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import type { TraceEnvelope } from './protocol';
import type { EvalSuite } from './cases/governance';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import {
  buildGovernanceReport,
  formatGovernanceReport,
  type GovernanceDisplayMetric,
} from './governance-report';
import {
  buildRetrievalEvalTracePayload,
  harnessErrorMetrics,
  isDirectExecution,
  retrievalDatasetIdentity,
  retrievalExecutionError,
  retrievalEvalConfig,
  retrievalMetricsRecord,
  type RetrievalMetricCounts,
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
  type EvalHarnessError,
  type EvalRunSession,
} from './run-session';

interface SemanticResult {
  caseResults: SemanticCaseResult[];
  misses: BadCase[];
  harnessErrors: EvalHarnessError[];
}

interface SemanticCaseResult {
  evalCase: SemanticRetrievalCase;
  rankedIds: string[];
  payload: ReturnType<typeof buildRetrievalEvalTracePayload>;
  envelope: TraceEnvelope<
    'retrieval',
    ReturnType<typeof buildRetrievalEvalTracePayload>
  >;
  miss?: BadCase;
}

function retrievalMetricCounts(
  results: readonly SemanticCaseResult[],
): RetrievalMetricCounts {
  return {
    recallNumerator: results.reduce(
      (sum, value) => sum + value.payload.ranking.recall,
      0,
    ),
    mrrNumerator: results.reduce(
      (sum, value) => sum + value.payload.ranking.reciprocalRank,
      0,
    ),
    caseCount: results.length,
    retrievalMissCount: results.filter(
      (value) => value.miss?.failure.type === 'retrieval_miss',
    ).length,
    rerankMissCount: results.filter(
      (value) => value.miss?.failure.type === 'rerank_miss',
    ).length,
  };
}

function retrievalGovernanceMetrics(
  results: readonly SemanticCaseResult[],
  k: number,
): GovernanceDisplayMetric[] {
  const metrics = retrievalMetricsRecord(retrievalMetricCounts(results));
  return [
    {
      label: `Recall@${k}`,
      unit: 'ratio',
      observation: metrics['retrieval.semantic.recall'],
    },
    {
      label: `MRR@${k}`,
      unit: 'ratio',
      observation: metrics['retrieval.semantic.mrr'],
    },
  ];
}

async function evaluateSemanticSearch(params: {
  cases: readonly SemanticRetrievalCase[];
  k: number;
  scope: EvalSuite;
  runId: string;
  session: EvalRunSession;
}): Promise<SemanticResult> {
  const { cases, k, scope, runId, session } = params;
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
            governance: evalCase.governance,
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
          governance: evalCase.governance,
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

  const caseResults = batch.results.map((value): SemanticCaseResult => {
    if (value.payload.ranking.recall === 1) return value;
    return {
      ...value,
      miss: retrievalMiss({
        evalCaseId: value.evalCase.id,
        runId,
        traceId: value.envelope.traceId,
        question: value.evalCase.question,
        resource: value.evalCase.target.kind,
        expectedChunkIds: value.evalCase.expectedChunkIds,
        actualTopIds: value.payload.ranking.topKIds,
        rankedIds: value.rankedIds,
        k,
        scope,
      }),
    };
  });

  return {
    caseResults,
    misses: caseResults.flatMap((value) =>
      value.miss === undefined ? [] : [value.miss],
    ),
    harnessErrors: batch.harnessErrors,
  };
}

function formatRate(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatMrr(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(3);
}

async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const setup = await executeEvalRunStage('dataset_preflight', () => {
    const selection = selectRetrievalCases(process.argv.slice(2));
    return {
      selection,
      dataset: retrievalDatasetIdentity(selection.cases),
      config: retrievalEvalConfig(selection.k),
    };
  });
  const { cases, k, scope } = setup.selection;
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'retrieval',
      scope,
      dataset: setup.dataset,
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      config: setup.config,
    }),
  );
  let semantic: SemanticResult;
  let added = 0;
  let completed = false;

  try {
    console.error(
      `评估(scope=${scope},k=${k},语料 ${CORPUS.length} 段,语义检索标注 ${cases.length} 条)\n`,
    );
    semantic = await evaluateSemanticSearch({
      cases,
      k,
      scope,
      runId,
      session,
    });
    const retrievalCounts = retrievalMetricCounts(semantic.caseResults);
    const metrics = await executeEvalRunStage('metric_aggregation', () => ({
      ...retrievalMetricsRecord(retrievalCounts),
      ...harnessErrorMetrics('retrieval', semantic.harnessErrors.length),
    }));

    console.error('━━━━━━ 语义检索汇总 ━━━━━━');
    console.error(
      `Recall@${k}=${formatRate(metrics['retrieval.semantic.recall'].value)}  MRR@${k}=${formatMrr(metrics['retrieval.semantic.mrr'].value)}`,
    );
    console.error(
      `quality fail=${semantic.misses.length} 条；skipped=0 条；harness error=${semantic.harnessErrors.length} 条；质量分母=${retrievalCounts.caseCount}/${cases.length}`,
    );
    console.error(
      'EditorContext exact-field 分流由独立确定性测试覆盖。',
    );
    console.error(
      formatGovernanceReport(
        buildGovernanceReport({
          cases,
          results: semantic.caseResults,
          harnessErrors: semantic.harnessErrors,
          resultCaseId: (value) => value.evalCase.id,
          aggregate: (values) => retrievalGovernanceMetrics(values, k),
        }),
      ),
    );

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
      `\n指标定义版本 → ${METRIC_DEFINITION_VERSION}`,
  );
}

if (isDirectExecution(import.meta.url)) {
  config({ override: true });
  main().catch((error: unknown) => {
    console.error('错误:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// 生成层评估:Faithfulness(忠于检索 context / 防幻觉)。Stage 5(§7.2)。
// 用法: npm run eval:faith             全量
//       npm run eval:faith -- 2        冒烟:检索引用/独立拒答各前 2 条
//       npm run eval:faith -- --policy 只跑 Stage 6 policy 用例

import { config } from 'dotenv';
import type Anthropic from '@anthropic-ai/sdk';
import { searchCorpusTraced } from '../retrieval/retrieve';
import { formatSources, selectContextHits } from '../retrieval/sources';
import { inferResource } from '../retrieval/router';
import { judge, JUDGE_MODEL } from './judge';
import type { JudgeAttempt } from './judge-votes';
import { MODEL, generateAnswer } from './answer';
import {
  evaluateSourceExpectation,
  type ResolvedGroundedAnswerCase,
} from './cases/grounded-answer-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import {
  decodeFaithTrace,
  FaithSearchTraceSchema,
  type FaithContextSnapshot,
  type FaithErrorPhase,
  type FaithOutcome,
  type FaithSearchTrace,
  type FaithTrace,
} from './faith-store';
import type { FaithEvalConfig } from './protocol';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import {
  FAITH_CONTEXT_K,
  faithMetricsRecord,
  faithEnvelopeOutcome,
  faithEvalConfig,
  harnessErrorMetrics,
  isDirectExecution,
  prepareFaithDataset,
  retrievalExecutionError,
  selectFaithCases,
  toPersistedPayload,
} from './runner-protocol';
import {
  EvalRunExecutionError,
  createErrorTraceEnvelope,
  createTraceEnvelope,
  executeEvalCaseStage,
  executeEvalCases,
  executeEvalRunStage,
  failEvalRunSession,
  startEvalRun,
} from './run-session';

interface FaithErrorTraceInput {
  resolved: ResolvedGroundedAnswerCase;
  runConfig: FaithEvalConfig;
  phase: FaithErrorPhase;
  routed?: string;
  searchTrace?: FaithSearchTrace;
  context?: FaithContextSnapshot;
  answer?: string;
  judgeAttempts?: JudgeAttempt[];
}

function errorTrace(params: FaithErrorTraceInput): FaithTrace {
  const {
    resolved,
    runConfig,
    phase,
    routed,
    searchTrace,
    context,
    answer = '',
    judgeAttempts = [],
  } = params;
  const topIds = context?.chunks.map((chunk) => chunk.id) ?? [];
  const foundCount = resolved.expectedChunkIds.filter((id) =>
    topIds.includes(id),
  ).length;
  const sourceCoverage = evaluateSourceExpectation(
    resolved.sourceExpectation,
    context?.chunks.map((chunk) => chunk.sourceType) ?? [],
  );

  return decodeFaithTrace(
    toPersistedPayload({
      id: resolved.id,
      input: resolved.input,
      question: resolved.question,
      expectedBehavior: resolved.expectedBehavior,
      sourceExpectation: resolved.sourceExpectation,
      sourceCoverage: context === undefined ? undefined : sourceCoverage,
      target: resolved.target,
      context,
      retrieval: {
        routed,
        expectedChunkIds: resolved.expectedChunkIds,
        topIds,
        foundCount,
        fullRecall:
          resolved.expectedChunkIds.length > 0 &&
          foundCount === resolved.expectedChunkIds.length,
        queryExpansionConfig: runConfig.queryExpansion,
        searchTrace,
      },
      answer,
      judgeAttempts,
      verdict: null,
      outcome: 'error' as const,
      errorPhase: phase,
    }),
  );
}

async function processCase(
  client: Anthropic,
  resolved: ResolvedGroundedAnswerCase,
  runConfig: FaithEvalConfig,
): Promise<FaithTrace> {
  const isRefusal =
    resolved.expectedBehavior === 'refuse_insufficient_context';
  const routed = inferResource(resolved.question) ?? undefined;
  let hits: Awaited<ReturnType<typeof searchCorpusTraced>>['hits'];
  let rawSearchTrace: Awaited<ReturnType<typeof searchCorpusTraced>>['trace'];
  try {
    ({ hits, trace: rawSearchTrace } = await searchCorpusTraced(
      resolved.question,
      {
        boostResource: routed,
        queryExpansion: runConfig.queryExpansion.enabled,
      },
    ));
  } catch (error) {
    throw retrievalExecutionError(error, (phase) =>
      ({ resolved, runConfig, phase, routed } satisfies FaithErrorTraceInput),
    );
  }

  const searchTrace = await executeEvalCaseStage(
    'trace_payload',
    () => FaithSearchTraceSchema.parse(rawSearchTrace),
    {
      resolved,
      runConfig,
      phase: 'trace_payload',
      routed,
    } satisfies FaithErrorTraceInput,
  );
  const contextResult = await executeEvalCaseStage(
    'context_selection',
    () => {
      const top = selectContextHits(hits, {
        k: runConfig.k,
        taskType: 'faith',
      });
      const contextChunks = top.map((hit) => hit.chunk);
      const { context, sources } = formatSources(contextChunks);
      const topIds = top.map((hit) => hit.chunk.id);
      const foundCount = !isRefusal
        ? resolved.expectedChunkIds.filter((id) => topIds.includes(id)).length
        : 0;
      return {
        context,
        contextSnapshot: {
          text: context,
          chunks: contextChunks,
          sources,
        } satisfies FaithContextSnapshot,
        topIds,
        foundCount,
        fullRecall:
          !isRefusal && foundCount === resolved.expectedChunkIds.length,
        sourceCoverage: evaluateSourceExpectation(
          resolved.sourceExpectation,
          contextChunks.map((chunk) => chunk.sourceType),
        ),
      };
    },
    {
      resolved,
      runConfig,
      phase: 'context_selection',
      routed,
      searchTrace,
    } satisfies FaithErrorTraceInput,
  );
  const {
    context,
    contextSnapshot,
    topIds,
    foundCount,
    fullRecall,
    sourceCoverage,
  } = contextResult;

  const answer = await executeEvalCaseStage(
    'answer_model',
    () => generateAnswer(client, context, resolved.question),
    {
      resolved,
      runConfig,
      phase: 'answer_model',
      routed,
      searchTrace,
      context: contextSnapshot,
    } satisfies FaithErrorTraceInput,
  );
  const { attempts: judgeAttempts, verdict } = await executeEvalCaseStage(
    'judge_request',
    () =>
      judge(
        client,
        context,
        answer,
        runConfig.judgeAttemptLimit,
      ),
    {
      resolved,
      runConfig,
      phase: 'judge_request',
      routed,
      searchTrace,
      context: contextSnapshot,
      answer,
    } satisfies FaithErrorTraceInput,
  );
  const outcome: FaithOutcome =
    verdict === null
      ? 'judge_failed'
      : isRefusal
        ? verdict.faithful
          ? 'refused_correctly'
          : 'refused_wrong'
        : verdict.faithful
          ? fullRecall
            ? 'faithful_hit'
            : 'faithful_miss'
          : fullRecall
            ? 'hallucination'
            : 'dual_cause';

  return executeEvalCaseStage(
    'trace_payload',
    () =>
      decodeFaithTrace(
        toPersistedPayload({
          id: resolved.id,
          input: resolved.input,
          question: resolved.question,
          expectedBehavior: resolved.expectedBehavior,
          sourceExpectation: resolved.sourceExpectation,
          sourceCoverage,
          target: resolved.target,
          context: contextSnapshot,
          retrieval: {
            routed,
            expectedChunkIds: resolved.expectedChunkIds,
            topIds,
            foundCount,
            fullRecall,
            queryExpansionConfig: runConfig.queryExpansion,
            searchTrace,
          },
          answer,
          judgeAttempts,
          verdict,
          outcome,
        }),
      ),
    {
      resolved,
      runConfig,
      phase: 'trace_payload',
      routed,
      searchTrace,
      context: contextSnapshot,
      answer,
      judgeAttempts,
    } satisfies FaithErrorTraceInput,
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EvalRunExecutionError) throw error;
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const setup = await executeEvalRunStage('dataset_preflight', () => {
    const selection = selectFaithCases(process.argv[2]);
    const prepared = prepareFaithDataset(selection.cases);
    return {
      selection,
      cases: prepared.cases,
      dataset: prepared.identity,
      config: faithEvalConfig(FAITH_CONTEXT_K),
    };
  });
  const { selection, cases, config: runConfig } = setup;
  const runId =
    new Date().toISOString().replace(/[:.]/g, '-') + selection.suffix;
  const session = await executeEvalRunStage('artifact_write', () =>
    startEvalRun({
      id: runId,
      kind: 'faith',
      scope: selection.scope,
      dataset: setup.dataset,
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      config: runConfig,
    }),
  );
  let completed = false;

  try {
    const client = await executeEvalRunStage(
      'runner_initialization',
      async () => {
        if (!process.env.DEEPSEEK_API_KEY) {
          throw new Error('DEEPSEEK_API_KEY 未设置');
        }
        const { getClient } = await import('../server/pipeline');
        return getClient();
      },
    );
    console.error(
      `Faithfulness 评估(${cases.length} 条${selection.label}:检索→生成→裁判,逐条调用,稍候)\n`,
    );

    const batch = await executeEvalCases({
      cases,
      evaluate: (evalCase) =>
        withRetry(() => processCase(client, evalCase, runConfig), 1, 2_000),
      appendSuccess: (evalCase, trace) => {
        session.appendCase(
          createTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'faith',
            outcome: faithEnvelopeOutcome(trace),
            payload: trace,
          }),
        );
      },
      appendError: (evalCase, failure) => {
        let traceInput: FaithErrorTraceInput;
        if (failure.payload === undefined) {
          traceInput = {
            resolved: evalCase,
            runConfig,
            phase: 'trace_payload',
            routed: inferResource(evalCase.question) ?? undefined,
          };
        } else {
          traceInput = failure.payload as FaithErrorTraceInput;
        }
        const payload = errorTrace(traceInput);
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'faith',
            payload,
            stage: failure.stage,
            error: failure.originalError,
          }),
        );
        console.error(`⚠ harness error [${failure.stage}] ${evalCase.id}`);
      },
    });

    let faithfulCount = 0;
    let judgedCount = 0;
    let hallucination = 0;
    let dualCause = 0;
    let refusalTotal = 0;
    let refusedCorrectly = 0;
    let judgeFailed = 0;
    let judgeInvalidAttempts = 0;
    let judgeErrorAttempts = 0;
    for (const trace of batch.results) {
      const isRefusal =
        trace.expectedBehavior === 'refuse_insufficient_context';
      const tag = isRefusal ? '[应拒答]' : '[应回答]';
      const { verdict, retrieval } = trace;
      judgeInvalidAttempts += trace.judgeAttempts.filter(
        (attempt) => attempt.status === 'invalid',
      ).length;
      judgeErrorAttempts += trace.judgeAttempts.filter(
        (attempt) => attempt.status === 'error',
      ).length;
      const { fullRecall, foundCount, expectedChunkIds } = retrieval;
      const retrievalLabel = !isRefusal
        ? ` 检索${fullRecall ? '✓' : '✗'}${expectedChunkIds.length > 1 ? ` ${foundCount}/${expectedChunkIds.length}` : ''}`
        : '';
      const answer = trace.answer.replace(/\s+/g, ' ').slice(0, 90);

      if (verdict === null) {
        judgeFailed++;
        const invalidAttempts = trace.judgeAttempts.filter(
          (attempt) => attempt.status === 'invalid',
        ).length;
        const errorAttempts = trace.judgeAttempts.filter(
          (attempt) => attempt.status === 'error',
        ).length;
        console.error(
          `⚠ 判定失败(valid=0, invalid=${invalidAttempts}, error=${errorAttempts}) ${tag}${retrievalLabel} | ${trace.question}`,
        );
        console.error(`   回答: ${answer}...`);
        continue;
      }

      judgedCount++;
      if (verdict.faithful) faithfulCount++;
      if (isRefusal) {
        refusalTotal++;
        if (verdict.faithful) refusedCorrectly++;
      } else if (!verdict.faithful) {
        if (fullRecall) hallucination++;
        else dualCause++;
      }

      console.error(
        `${verdict.faithful ? '✓忠实' : '✗不忠'} ${tag}${retrievalLabel} | ${trace.question}`,
      );
      console.error(`   回答: ${answer}...`);
      if (!verdict.faithful) {
        console.error(
          `   未支持: ${verdict.unsupported.join(' / ')}  (${verdict.reason})`,
        );
      }
    }

    const metrics = await executeEvalRunStage('metric_aggregation', () => ({
      ...faithMetricsRecord({
        faithfulCount,
        judgedCount,
        refusedCorrectlyCount: refusedCorrectly,
        refusalJudgedCount: refusalTotal,
        hallucinationCount: hallucination,
        dualCauseCount: dualCause,
        judgeIndeterminateCount: judgeFailed,
        judgeInvalidAttemptCount: judgeInvalidAttempts,
        judgeErrorAttemptCount: judgeErrorAttempts,
        caseCount: batch.results.length,
      }),
      ...harnessErrorMetrics('faith', batch.harnessErrors.length),
    }));
    const faithfulRate = metrics['faith.faithful_rate'].value;
    const refusalCorrectRate = metrics['faith.refusal_correct_rate'].value;

    console.error('\n━━━━━━ 汇总 ━━━━━━');
    console.error(
      `Faithfulness 率 = ${faithfulRate === null ? 'N/A' : `${(faithfulRate * 100).toFixed(1)}%`}  (${faithfulCount}/${judgedCount})`,
    );
    console.error(
      `拒答正确率(应拒答的)= ${refusalCorrectRate === null ? 'N/A' : `${(refusalCorrectRate * 100).toFixed(1)}%`}  (${refusedCorrectly}/${refusalTotal})`,
    );
    console.error(
      `归因(可答不忠实)= 真幻觉(检索✓却瞎编)${hallucination} 条 / 检索漏+编造(检索✗)${dualCause} 条`,
    );
    console.error(
      `judge indeterminate=${judgeFailed} 条(invalid attempts=${judgeInvalidAttempts}, request error attempts=${judgeErrorAttempts})`,
    );
    console.error(
      `quality fail=${judgedCount - faithfulCount} 条；harness error=${batch.harnessErrors.length} 条；质量分母=${judgedCount}；已完成 case=${batch.results.length}/${cases.length}`,
    );
    console.error(
      `注:被测=${MODEL}(flash),裁判=${JUDGE_MODEL}(pro)。Faithfulness=只忠于检索 context,不等于事实正确。`,
    );

    await executeEvalRunStage('artifact_write', () => session.complete(metrics));
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'faith'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}` +
        (selection.suffix
          ? `  (${selection.suffix.slice(1)} 子集,勿晋升 baseline)`
          : ''),
    );
  } catch (error) {
    if (!completed) failEvalRunSession(session, error);
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  config({ override: true });
  main().catch((error: unknown) => {
    console.error('错误:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

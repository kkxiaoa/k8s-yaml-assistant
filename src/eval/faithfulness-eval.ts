// 生成层评估:Faithfulness(忠于检索 context / 防幻觉)。Stage 5(§7.2)。
// 用法: npm run eval:faith             tuning 套件
//       npm run eval:faith -- --holdout Holdout 留出集
//       npm run eval:faith -- --full    完整集
//       npm run eval:faith -- 2        冒烟:检索引用/独立拒答各前 2 条
//       npm run eval:faith -- --policy 只跑非 Holdout policy 用例
//       npm run eval:faith -- --case <case-id> [--case <case-id> ...] 定向非 Holdout 用例

import { config } from 'dotenv';
import type Anthropic from '@anthropic-ai/sdk';
import { inferResource } from '../retrieval/router';
import {
  ANSWER_MODEL,
  prepareAsk,
  type AskMode,
} from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';
import type { JudgeAttempt } from './judge-votes';
import { textOfRequest } from './llm';
import {
  evaluateSourceExpectation,
  groundedAnswerAskMode,
  type ResolvedGroundedAnswerCase,
} from './cases/grounded-answer-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import {
  assessFaith,
  currentFaithOutcome,
  decodeFaithTrace,
  FaithSearchTraceSchema,
  type FaithContextSnapshot,
  type FaithErrorPhase,
  type FaithSearchTrace,
  type FaithTrace,
} from './faith-store';
import type { FaithEvalConfig } from './protocol';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import {
  buildGovernanceReport,
  formatGovernanceReport,
  type GovernanceDisplayMetric,
} from './governance-report';
import {
  FAITH_CONTEXT_K,
  faithMetricsRecord,
  faithEnvelopeOutcome,
  faithEvalConfig,
  harnessErrorMetrics,
  isDirectExecution,
  retrievalExecutionError,
  selectFaithCases,
  toPersistedPayload,
  type FaithMetricCounts,
} from './runner-protocol';
import {
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
      governance: resolved.governance,
      input: resolved.input,
      question: resolved.question,
      expectedBehavior: resolved.expectedBehavior,
      sourceExpectation: resolved.sourceExpectation,
      sourceCoverage: context === undefined ? undefined : sourceCoverage,
      target: resolved.target,
      editorContext: resolved.editorContext,
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
  const mode: AskMode = groundedAnswerAskMode(resolved.input);
  let prepared: Awaited<ReturnType<typeof prepareAsk>>;
  try {
    prepared = await prepareAsk({
      question: resolved.question,
      k: runConfig.k,
      editorContext: resolved.editorContext,
      mode,
      retrievalOptions: {
        queryExpansion: runConfig.queryExpansion.enabled,
      },
    });
  } catch (error) {
    throw retrievalExecutionError(error, (phase) =>
      ({
        resolved,
        runConfig,
        phase,
        routed:
          resolved.editorContext?.kind ??
          inferResource(resolved.question) ??
          undefined,
      } satisfies FaithErrorTraceInput),
    );
  }

  const routed = prepared.trace.resourceHint;
  const searchTrace = await executeEvalCaseStage(
    'trace_payload',
    () => FaithSearchTraceSchema.parse(prepared.trace),
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
      const contextChunks = prepared.hits.map(({ score: _score, ...chunk }) =>
        chunk,
      );
      const userMessage = prepared.request.messages[0]?.content;
      if (typeof userMessage !== 'string') {
        throw new TypeError('Ask user message must be text');
      }
      const topIds = contextChunks.map((chunk) => chunk.id);
      const foundCount = !isRefusal
        ? resolved.expectedChunkIds.filter((id) => topIds.includes(id)).length
        : 0;
      return {
        contextSnapshot: {
          text: userMessage,
          chunks: contextChunks,
          sources: prepared.sources,
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
    contextSnapshot,
    topIds,
    foundCount,
    fullRecall,
    sourceCoverage,
  } = contextResult;

  const answer = await executeEvalCaseStage(
    'answer_model',
    () => textOfRequest(client, prepared.request),
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
        {
          question: resolved.question,
          context: contextSnapshot.text,
          answer,
        },
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
  const outcome = currentFaithOutcome({
    expectedBehavior: resolved.expectedBehavior,
    sourceCoverage,
    retrieval: { fullRecall },
    verdict,
  });

  return executeEvalCaseStage(
    'trace_payload',
    () =>
      decodeFaithTrace(
        toPersistedPayload({
          id: resolved.id,
          governance: resolved.governance,
          input: resolved.input,
          question: resolved.question,
          expectedBehavior: resolved.expectedBehavior,
          sourceExpectation: resolved.sourceExpectation,
          sourceCoverage,
          target: resolved.target,
          editorContext: resolved.editorContext,
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

function faithMetricCounts(traces: readonly FaithTrace[]): FaithMetricCounts {
  let faithfulCount = 0;
  let judgedCount = 0;
  let expectedBehaviorSatisfiedCount = 0;
  let behaviorJudgedCount = 0;
  let groundedSuccessCount = 0;
  let refusedCorrectlyCount = 0;
  let refusalJudgedCount = 0;
  let unsupportedResponseCount = 0;
  let behaviorMismatchCount = 0;
  let retrievalIncompleteCount = 0;
  let sourceIncompleteCount = 0;
  let judgeIndeterminateCount = 0;
  let judgeInvalidAttemptCount = 0;
  let judgeErrorAttemptCount = 0;

  for (const trace of traces) {
    judgeInvalidAttemptCount += trace.judgeAttempts.filter(
      (attempt) => attempt.status === 'invalid',
    ).length;
    judgeErrorAttemptCount += trace.judgeAttempts.filter(
      (attempt) => attempt.status === 'error',
    ).length;
    const assessment = assessFaith(trace);
    if (!assessment.retrievalSatisfied) retrievalIncompleteCount++;
    if (!assessment.sourceCoverageSatisfied) sourceIncompleteCount++;
    if (trace.verdict === null) {
      judgeIndeterminateCount++;
      continue;
    }

    judgedCount++;
    if (trace.verdict.faithful) faithfulCount++;
    else unsupportedResponseCount++;
    if (assessment.expectedBehaviorSatisfied !== null) {
      behaviorJudgedCount++;
      if (assessment.expectedBehaviorSatisfied) {
        expectedBehaviorSatisfiedCount++;
      } else {
        behaviorMismatchCount++;
      }
      if (assessment.passed) groundedSuccessCount++;
    }
    if (trace.expectedBehavior === 'refuse_insufficient_context') {
      if (assessment.responseBehavior !== null) {
        refusalJudgedCount++;
        if (
          trace.verdict.faithful &&
          assessment.responseBehavior === 'refusal'
        ) {
          refusedCorrectlyCount++;
        }
      }
    }
  }

  return {
    faithfulCount,
    judgedCount,
    expectedBehaviorSatisfiedCount,
    behaviorJudgedCount,
    groundedSuccessCount,
    refusedCorrectlyCount,
    refusalJudgedCount,
    unsupportedResponseCount,
    behaviorMismatchCount,
    retrievalIncompleteCount,
    sourceIncompleteCount,
    judgeIndeterminateCount,
    judgeInvalidAttemptCount,
    judgeErrorAttemptCount,
    caseCount: traces.length,
  };
}

function faithGovernanceMetrics(
  traces: readonly FaithTrace[],
): GovernanceDisplayMetric[] {
  const metrics = faithMetricsRecord(faithMetricCounts(traces));
  return [
    {
      label: 'faithful',
      unit: 'ratio',
      observation: metrics['faith.faithful_rate'],
    },
    {
      label: 'grounded-success',
      unit: 'ratio',
      observation: metrics['faith.grounded_success_rate'],
    },
    {
      label: 'refusal-correct',
      unit: 'ratio',
      observation: metrics['faith.refusal_correct_rate'],
    },
    {
      label: 'judge-indeterminate',
      unit: 'count',
      observation: metrics['faith.judge_indeterminate'],
    },
  ];
}

async function main(): Promise<void> {
  const setup = await executeEvalRunStage('dataset_preflight', () => {
    const selection = selectFaithCases(process.argv.slice(2));
    return {
      selection,
      cases: selection.cases,
      dataset: selection.identity,
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
      evaluate: (evalCase) => processCase(client, evalCase, runConfig),
      appendSuccess: (evalCase, trace) => {
        session.appendCase(
          createTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            governance: evalCase.governance,
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
            routed:
              evalCase.editorContext?.kind ??
              inferResource(evalCase.question) ??
              undefined,
          };
        } else {
          traceInput = failure.payload as FaithErrorTraceInput;
        }
        const payload = errorTrace(traceInput);
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            governance: evalCase.governance,
            kind: 'faith',
            payload,
            stage: failure.stage,
            error: failure.originalError,
          }),
        );
        console.error(`⚠ harness error [${failure.stage}] ${evalCase.id}`);
      },
    });

    const faithCounts = faithMetricCounts(batch.results);
    const {
      faithfulCount,
      judgedCount,
      expectedBehaviorSatisfiedCount,
      behaviorJudgedCount,
      groundedSuccessCount,
      refusalJudgedCount: refusalTotal,
      refusedCorrectlyCount: refusedCorrectly,
      unsupportedResponseCount,
      behaviorMismatchCount,
      retrievalIncompleteCount,
      sourceIncompleteCount,
      judgeIndeterminateCount: judgeFailed,
      judgeInvalidAttemptCount: judgeInvalidAttempts,
      judgeErrorAttemptCount: judgeErrorAttempts,
    } = faithCounts;
    for (const trace of batch.results) {
      const isRefusal =
        trace.expectedBehavior === 'refuse_insufficient_context';
      const tag = isRefusal ? '[应拒答]' : '[应回答]';
      const { verdict, retrieval } = trace;
      const { fullRecall, foundCount, expectedChunkIds } = retrieval;
      const retrievalLabel = !isRefusal
        ? ` 检索${fullRecall ? '✓' : '✗'}${expectedChunkIds.length > 1 ? ` ${foundCount}/${expectedChunkIds.length}` : ''}`
        : '';
      const answer = trace.answer.replace(/\s+/g, ' ').slice(0, 90);

      if (verdict === null) {
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

      const assessment = assessFaith(trace);
      console.error(
        `${trace.outcome === 'passed' ? '✓通过' : '✗未通过'} ${verdict.faithful ? '忠实' : '不忠实'} 行为=${verdict.responseBehavior} ${tag}${retrievalLabel} | ${trace.question}`,
      );
      console.error(`   回答: ${answer}...`);
      if (!verdict.faithful) {
        console.error(
          `   未支持: ${verdict.unsupported.join(' / ')}  (${verdict.reason})`,
        );
      }
      const diagnostics = [
        assessment.expectedBehaviorSatisfied === false
          ? '回答行为不符合用例契约'
          : null,
        !assessment.retrievalSatisfied ? '检索不完整' : null,
        !assessment.sourceCoverageSatisfied ? '必需来源不完整' : null,
      ].filter((value): value is string => value !== null);
      if (diagnostics.length > 0) {
        console.error(`   诊断: ${diagnostics.join(' / ')}`);
      }
    }

    const metrics = await executeEvalRunStage('metric_aggregation', () => ({
      ...faithMetricsRecord(faithCounts),
      ...harnessErrorMetrics('faith', batch.harnessErrors.length),
    }));
    const faithfulRate = metrics['faith.faithful_rate'].value;
    const behaviorComplianceRate =
      metrics['faith.behavior_compliance_rate'].value;
    const groundedSuccessRate = metrics['faith.grounded_success_rate'].value;
    const refusalCorrectRate = metrics['faith.refusal_correct_rate'].value;

    console.error('\n━━━━━━ 汇总 ━━━━━━');
    console.error(
      `Faithfulness（忠实度）率 = ${faithfulRate === null ? 'N/A' : `${(faithfulRate * 100).toFixed(1)}%`}  (${faithfulCount}/${judgedCount})`,
    );
    console.error(
      `期望行为满足率 = ${behaviorComplianceRate === null ? 'N/A' : `${(behaviorComplianceRate * 100).toFixed(1)}%`}  (${expectedBehaviorSatisfiedCount}/${behaviorJudgedCount})`,
    );
    console.error(
      `Grounded success（有依据完整通过）= ${groundedSuccessRate === null ? 'N/A' : `${(groundedSuccessRate * 100).toFixed(1)}%`}  (${groundedSuccessCount}/${behaviorJudgedCount})`,
    );
    console.error(
      `拒答正确率(应拒答且行为已判定)= ${refusalCorrectRate === null ? 'N/A' : `${(refusalCorrectRate * 100).toFixed(1)}%`}  (${refusedCorrectly}/${refusalTotal})`,
    );
    console.error(
      `并列诊断: 无依据回答=${unsupportedResponseCount} / 行为不符=${behaviorMismatchCount} / 检索不完整=${retrievalIncompleteCount} / 来源不完整=${sourceIncompleteCount}`,
    );
    console.error(
      `judge indeterminate=${judgeFailed} 条(invalid attempts=${judgeInvalidAttempts}, request error attempts=${judgeErrorAttempts})`,
    );
    console.error(
      `quality fail=${behaviorJudgedCount - groundedSuccessCount} 条；harness error=${batch.harnessErrors.length} 条；质量分母=${behaviorJudgedCount}；已完成 case=${batch.results.length}/${cases.length}`,
    );
    console.error(
      `注:被测=${ANSWER_MODEL}(flash),裁判=${JUDGE_MODEL}(pro)。Faithfulness=只忠于 Ask 输入证据,不等于事实正确。`,
    );
    console.error(
      formatGovernanceReport(
        buildGovernanceReport({
          cases,
          results: batch.results,
          harnessErrors: batch.harnessErrors,
          resultCaseId: (trace) => trace.id,
          aggregate: faithGovernanceMetrics,
        }),
      ),
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

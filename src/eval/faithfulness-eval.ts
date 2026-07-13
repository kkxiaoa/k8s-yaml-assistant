// 生成层评估:Faithfulness(忠于检索 context / 防幻觉)。Stage 5(§7.2)。
// 用法: npm run eval:faith             全量
//       npm run eval:faith -- 2        冒烟:可答/拒答各前 2 条
//       npm run eval:faith -- --policy 只跑 Stage 6 policy 用例

import { config } from 'dotenv';
import type Anthropic from '@anthropic-ai/sdk';
import { searchCorpusTraced } from '../retrieval/retrieve';
import { formatSources, selectContextHits } from '../retrieval/sources';
import { inferResource } from '../retrieval/router';
import { judge, JUDGE_MODEL } from './judge';
import { MODEL, generateAnswer } from './answer';
import type { RetrievalEvalCase } from './cases/retrieval-cases';
import { evalArtifactPath, runPath, traceRelativePath } from './artifacts';
import { type FaithOutcome, type FaithTrace } from './faith-store';
import { metricObservation } from './protocol';
import {
  FAITH_CONTEXT_K,
  LEGACY_METRIC_DEFINITION_VERSION,
  faithDatasetIdentity,
  faithEnvelopeOutcome,
  faithEvalConfig,
  isDirectExecution,
  selectFaithCases,
  toPersistedPayload,
} from './runner-protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
} from './run-session';

async function processCase(
  client: Anthropic,
  evalCase: RetrievalEvalCase,
): Promise<FaithTrace> {
  const routed = inferResource(evalCase.question) ?? undefined;
  const { hits } = await searchCorpusTraced(evalCase.question, {
    boostResource: routed,
  });
  const top = selectContextHits(hits, {
    k: FAITH_CONTEXT_K,
    taskType: 'faith',
  });
  const { context } = formatSources(top.map((hit) => hit.chunk));
  const topIds = top.map((hit) => hit.chunk.id);
  const foundCount = evalCase.answerable
    ? evalCase.expectedChunkIds.filter((id) => topIds.includes(id)).length
    : 0;
  const fullRecall =
    evalCase.answerable && foundCount === evalCase.expectedChunkIds.length;

  const answer = await generateAnswer(client, context, evalCase.question);
  const verdict = await judge(client, context, answer);
  const outcome: FaithOutcome =
    verdict === null
      ? 'judge_failed'
      : !evalCase.answerable
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

  return toPersistedPayload({
      id: evalCase.id,
      question: evalCase.question,
      answerable: evalCase.answerable,
      resource: evalCase.resource,
      retrieval: {
        routed,
        expectedChunkIds: evalCase.expectedChunkIds,
        topIds,
        foundCount,
        fullRecall,
      },
      answer,
      verdict,
      outcome,
    }) satisfies FaithTrace;
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
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const selection = selectFaithCases(process.argv[2]);
  const { cases } = selection;
  const runId =
    new Date().toISOString().replace(/[:.]/g, '-') + selection.suffix;
  const session = startEvalRun({
    id: runId,
    kind: 'faith',
    scope: selection.scope,
    dataset: faithDatasetIdentity(cases),
    metricDefinitionVersion: LEGACY_METRIC_DEFINITION_VERSION,
    config: faithEvalConfig(FAITH_CONTEXT_K),
  });
  let stage = 'initialize';
  let completed = false;

  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY 未设置');
    }
    const { getClient } = await import('../server/pipeline');
    const client = getClient();
    console.error(
      `Faithfulness 评估(${cases.length} 条${selection.label}:检索→生成→裁判,逐条调用,稍候)\n`,
    );

    let faithfulCount = 0;
    let judgedCount = 0;
    let hallucination = 0;
    let dualCause = 0;
    let refusalTotal = 0;
    let refusedCorrectly = 0;
    let judgeFailed = 0;
    let errorCount = 0;

    for (const evalCase of cases) {
      const tag = evalCase.answerable ? '[可答]' : '[应拒答]';
      stage = `case:${evalCase.id}:faith`;
      let trace: FaithTrace;
      try {
        trace = await withRetry(() => processCase(client, evalCase), 1, 2_000);
      } catch (error) {
        errorCount++;
        trace = toPersistedPayload({
            id: evalCase.id,
            question: evalCase.question,
            answerable: evalCase.answerable,
            resource: evalCase.resource,
            retrieval: {
              expectedChunkIds: evalCase.expectedChunkIds,
              topIds: [],
              foundCount: 0,
              fullRecall: false,
            },
            answer: '',
            verdict: null,
            outcome: 'error' as const,
          }) satisfies FaithTrace;
        session.appendCase(
          createErrorTraceEnvelope({
            runId,
            evalCaseId: evalCase.id,
            kind: 'faith',
            payload: trace,
            stage,
            error,
          }),
        );
        continue;
      }

      session.appendCase(
        createTraceEnvelope({
          runId,
          evalCaseId: evalCase.id,
          kind: 'faith',
          outcome: faithEnvelopeOutcome(trace),
          payload: trace,
        }),
      );

      const { verdict, retrieval } = trace;
      const { fullRecall, foundCount, expectedChunkIds } = retrieval;
      const retrievalLabel = evalCase.answerable
        ? ` 检索${fullRecall ? '✓' : '✗'}${expectedChunkIds.length > 1 ? ` ${foundCount}/${expectedChunkIds.length}` : ''}`
        : '';
      const answer = trace.answer.replace(/\s+/g, ' ').slice(0, 90);

      if (verdict === null) {
        judgeFailed++;
        console.error(
          `⚠ 判定失败(裁判两次未给有效 JSON) ${tag}${retrievalLabel} | ${evalCase.question}`,
        );
        console.error(`   回答: ${answer}...`);
        continue;
      }

      judgedCount++;
      if (verdict.faithful) faithfulCount++;
      if (!evalCase.answerable) {
        refusalTotal++;
        if (verdict.faithful) refusedCorrectly++;
      } else if (!verdict.faithful) {
        if (fullRecall) hallucination++;
        else dualCause++;
      }

      console.error(
        `${verdict.faithful ? '✓忠实' : '✗不忠'} ${tag}${retrievalLabel} | ${evalCase.question}`,
      );
      console.error(`   回答: ${answer}...`);
      if (!verdict.faithful) {
        console.error(
          `   未支持: ${verdict.unsupported.join(' / ')}  (${verdict.reason})`,
        );
      }
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

    stage = 'complete';
    session.complete({
      'faith.faithful_rate': metricObservation(
        judgedCount ? faithfulCount / judgedCount : null,
        faithfulCount,
        judgedCount,
      ),
      'faith.refusal_correct_rate': metricObservation(
        refusalTotal ? refusedCorrectly / refusalTotal : null,
        refusedCorrectly,
        refusalTotal,
      ),
      'faith.hallucination': metricObservation(hallucination),
      'faith.dual_cause': metricObservation(dualCause),
      'faith.judged': metricObservation(judgedCount),
      'faith.judge_failed': metricObservation(judgeFailed),
      'faith.error': metricObservation(errorCount),
    });
    completed = true;
    const tracePath = evalArtifactPath(traceRelativePath(runId, 'faith'));
    console.error(
      `\n逐条 trace → ${tracePath}\n汇总 run → ${runPath(runId)}` +
        (selection.suffix
          ? `  (${selection.suffix.slice(1)} 子集,勿晋升 baseline)`
          : ''),
    );
  } catch (error) {
    if (!completed) session.fail(stage, error);
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

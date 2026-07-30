import { pathToFileURL } from 'node:url';
import {
  AGENT_MAX_TOKENS,
  ANSWER_MODEL,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
} from '../server/agent-contract';
import {
  ASK_MAX_TOKENS,
  ASK_SYSTEM,
  buildAskUserMessage,
} from '../server/pipeline';
import {
  buildCorpusManifest,
  SCHEMA_CORPUS_PROVIDER,
} from '../knowledge/corpus';
import { resolveEmbeddingModel } from '../retrieval/embeddings';
import { computeIndexHash } from '../retrieval/index-store';
import {
  loadAliasRegistrySnapshot,
  resolveQueryExpansionEnabled,
} from '../retrieval/query-expansion-runtime';
import { RERANK_MODEL } from '../retrieval/rerank';
import { RetrievalPipelineError } from '../retrieval/retrieve';
import type { RetrievalTrace } from '../retrieval/trace';
import { VALIDATION_LOGIC_REVISION } from '../validation/validate';
import {
  FIX_CASES,
  type FixCase,
} from './cases/fix-cases';
import {
  GENERATION_CASES,
  type GenerationEvalCase,
} from './cases/generation-cases';
import {
  GROUNDED_ANSWER_CASES,
  resolveGroundedAnswerCase,
  type GroundedAnswerCase,
  type ResolvedGroundedAnswerCase,
} from './cases/grounded-answer-cases';
import {
  RETRIEVAL_CASES,
  type SemanticRetrievalCase,
} from './cases/retrieval-cases';
import {
  parseEvalSuiteArgs,
  selectCasesForSuite,
  type EvalCaseGovernance,
  type EvalSuite,
  type GovernedEvalCase,
} from './cases/governance';
import type { FaithTrace } from './faith-store';
import {
  FAITH_JUDGE_ATTEMPT_LIMIT,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_SYSTEM,
  JUDGE_USER_MESSAGE_TEMPLATE,
} from './judge';
import type {
  FixCaseResult,
  GenerationCaseResult,
} from './metrics/generation-metrics';
import type {
  JudgeCalibrationCase,
  JudgeCalibrationTrace,
} from './metrics/judge-metrics';
import {
  EvalCaseExecutionError,
  EvalRunExecutionError,
} from './run-session';
import {
  EvalDatasetIdentitySchema,
  computeCanonicalHash,
  computeDatasetHash,
  metricObservation,
  ratioObservation,
  type EvalDatasetIdentity,
  type EvalKind,
  type EvalScope,
  type FaithEvalConfig,
  type FixEvalConfig,
  type GenerationEvalConfig,
  type JudgeEvalConfig,
  type MetricObservation,
  type RetrievalEvalConfig,
  type TraceEnvelope,
} from './protocol';

export const FAITH_CONTEXT_K = 3;
export const JUDGE_CALIBRATION_VOTES = 5;

export function harnessErrorMetrics(
  kind: EvalKind,
  count: number,
): Record<string, MetricObservation> {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError('harness error count must be a non-negative integer');
  }
  return {
    [`${kind}.harness_error_count`]: metricObservation(count),
  };
}

export interface RetrievalMetricCounts {
  recallNumerator: number;
  mrrNumerator: number;
  caseCount: number;
  retrievalMissCount: number;
  rerankMissCount: number;
}

export function retrievalMetricsRecord(counts: RetrievalMetricCounts) {
  return {
    'retrieval.semantic.recall': ratioObservation(
      counts.recallNumerator,
      counts.caseCount,
    ),
    'retrieval.semantic.mrr': ratioObservation(
      counts.mrrNumerator,
      counts.caseCount,
    ),
    'retrieval.semantic.case_count': metricObservation(counts.caseCount),
    'retrieval.retrieval_miss_count': metricObservation(
      counts.retrievalMissCount,
    ),
    'retrieval.rerank_miss_count': metricObservation(counts.rerankMissCount),
  } satisfies Record<string, MetricObservation>;
}

export interface FaithMetricCounts {
  faithfulCount: number;
  judgedCount: number;
  expectedBehaviorSatisfiedCount: number;
  behaviorJudgedCount: number;
  groundedSuccessCount: number;
  refusedCorrectlyCount: number;
  refusalJudgedCount: number;
  unsupportedResponseCount: number;
  behaviorMismatchCount: number;
  retrievalIncompleteCount: number;
  sourceIncompleteCount: number;
  judgeIndeterminateCount: number;
  judgeInvalidAttemptCount: number;
  judgeErrorAttemptCount: number;
  caseCount: number;
}

export function faithMetricsRecord(counts: FaithMetricCounts) {
  return {
    'faith.faithful_rate': ratioObservation(
      counts.faithfulCount,
      counts.judgedCount,
    ),
    'faith.behavior_compliance_rate': ratioObservation(
      counts.expectedBehaviorSatisfiedCount,
      counts.behaviorJudgedCount,
    ),
    'faith.grounded_success_rate': ratioObservation(
      counts.groundedSuccessCount,
      counts.behaviorJudgedCount,
    ),
    'faith.refusal_correct_rate': ratioObservation(
      counts.refusedCorrectlyCount,
      counts.refusalJudgedCount,
    ),
    'faith.unsupported_response_count': metricObservation(
      counts.unsupportedResponseCount,
    ),
    'faith.behavior_mismatch_count': metricObservation(
      counts.behaviorMismatchCount,
    ),
    'faith.retrieval_incomplete_count': metricObservation(
      counts.retrievalIncompleteCount,
    ),
    'faith.source_incomplete_count': metricObservation(
      counts.sourceIncompleteCount,
    ),
    'faith.judged': metricObservation(counts.judgedCount),
    'faith.behavior_judged': metricObservation(counts.behaviorJudgedCount),
    'faith.refusal_judged': metricObservation(counts.refusalJudgedCount),
    'faith.case_count': metricObservation(counts.caseCount),
    'faith.judge_indeterminate': metricObservation(
      counts.judgeIndeterminateCount,
    ),
    'faith.judge_invalid_attempt': metricObservation(
      counts.judgeInvalidAttemptCount,
    ),
    'faith.judge_error_attempt': metricObservation(
      counts.judgeErrorAttemptCount,
    ),
  } satisfies Record<string, MetricObservation>;
}

export function generatedResultEvaluationStage(result: {
  attempts: readonly { parseOk: boolean }[];
}): 'yaml_parse' | 'schema_validation' {
  // Normal invalid output remains a quality result; this only classifies an unexpected evaluator exception.
  return result.attempts.at(-1)?.parseOk === false
    ? 'yaml_parse'
    : 'schema_validation';
}

type RetrievalCaseErrorStage = 'embedding' | 'retrieval' | 'rerank';

export function retrievalExecutionError<TPayload>(
  error: unknown,
  payload: (stage: RetrievalCaseErrorStage) => TPayload,
): EvalCaseExecutionError<TPayload> | EvalRunExecutionError {
  if (error instanceof RetrievalPipelineError) {
    if (error.stage === 'index') {
      return new EvalRunExecutionError('index', error.originalError);
    }
    return new EvalCaseExecutionError(
      error.stage,
      error.originalError,
      payload(error.stage),
    );
  }
  return new EvalCaseExecutionError(
    'retrieval',
    error,
    payload('retrieval'),
  );
}

type EnvelopeOutcome = TraceEnvelope['outcome'];

export interface FaithCaseSelection {
  cases: ResolvedGroundedAnswerCase[];
  identity: EvalDatasetIdentity;
  suffix: '' | '-holdout' | '-full' | '-smoke' | '-policy';
  label: string;
  scope: EvalScope;
}

export interface EvalSuiteCaseSelection<T> {
  cases: T[];
  suite: EvalSuite;
  scope: EvalSuite;
}

export interface RetrievalCaseSelection
  extends EvalSuiteCaseSelection<SemanticRetrievalCase> {
  k: number;
}

export interface JudgeCaseSelection {
  cases: JudgeCalibrationCase[];
  scope: 'calibration' | 'targeted';
  suffix: '' | '-targeted';
  label: string;
}

export interface RetrievalEvalTracePayload {
  trace: RetrievalTrace;
  expected: {
    chunkIds: string[];
    k: number;
  };
  ranking: {
    topKIds: string[];
    foundIds: string[];
    firstRelevantRank: number | null;
    recall: number;
    reciprocalRank: number;
  };
}

export function toPersistedPayload<T>(value: T): T {
  const serialized = JSON.stringify(value, function (_key, item: unknown) {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError('trace payload contains a non-finite number');
    }
    if (
      typeof item === 'bigint' ||
      typeof item === 'function' ||
      typeof item === 'symbol'
    ) {
      throw new TypeError(`trace payload contains ${typeof item}`);
    }
    if (item === undefined && Array.isArray(this)) {
      throw new TypeError('trace payload contains an undefined array item');
    }
    return item;
  });
  if (serialized === undefined) {
    throw new TypeError('trace payload is not JSON-serializable');
  }
  return JSON.parse(serialized) as T;
}

function datasetIdentity<
  T extends { id: string; governance: EvalCaseGovernance },
>(
  id: string,
  cases: readonly T[],
  snapshot: (evalCase: T) => unknown,
): EvalDatasetIdentity {
  return EvalDatasetIdentitySchema.parse({
    id,
    hash: computeDatasetHash(cases.map(snapshot)),
    cases: cases.map((evalCase) => ({
      id: evalCase.id,
      governance: evalCase.governance,
    })),
    caseCount: cases.length,
  });
}

function retrievalCaseSnapshot(evalCase: SemanticRetrievalCase): unknown {
  return {
    id: evalCase.id,
    question: evalCase.question,
    expectedChunkIds: [...evalCase.expectedChunkIds].sort(),
    target: evalCase.target,
    governance: evalCase.governance,
  };
}

function groundedAnswerCaseSnapshot(
  resolved: ResolvedGroundedAnswerCase,
): unknown {
  const { sourceExpectation } = resolved;
  return {
    id: resolved.id,
    input: resolved.input,
    expectedBehavior: resolved.expectedBehavior,
    sourceExpectation:
      sourceExpectation === undefined
        ? null
        : {
            mode: sourceExpectation.mode,
            types: [...sourceExpectation.types].sort(),
          },
    question: resolved.question,
    expectedChunkIds: [...resolved.expectedChunkIds].sort(),
    target: resolved.target ?? null,
    editorContext: resolved.editorContext ?? null,
    governance: resolved.governance,
  };
}

function faithTraceCaseSnapshot(trace: FaithTrace): unknown {
  return {
    id: trace.id,
    input: trace.input,
    expectedBehavior: trace.expectedBehavior,
    sourceExpectation:
      trace.sourceExpectation === undefined
        ? null
        : {
            mode: trace.sourceExpectation.mode,
            types: [...trace.sourceExpectation.types].sort(),
          },
    question: trace.question,
    expectedChunkIds: [...trace.retrieval.expectedChunkIds].sort(),
    target: trace.target ?? null,
    editorContext: trace.editorContext ?? null,
    governance: trace.governance,
  };
}

function generationCaseSnapshot(evalCase: GenerationEvalCase): unknown {
  return {
    id: evalCase.id,
    requirement: evalCase.requirement,
    expectedResources: evalCase.expectedResources,
    relations: evalCase.relations ?? [],
    governance: evalCase.governance,
  };
}

function fixCaseSnapshot(evalCase: FixCase): unknown {
  return {
    id: evalCase.id,
    defectType: evalCase.defectType,
    brokenYaml: evalCase.brokenYaml,
    target: evalCase.target,
    preserve: evalCase.preserve,
    expectedCorrections: evalCase.expectedCorrections,
    governance: evalCase.governance,
  };
}

function judgeCaseSnapshot(evalCase: JudgeCalibrationCase): unknown {
  return {
    id: evalCase.id,
    category: evalCase.category,
    sourceFaithRunId: evalCase.sourceFaithRunId,
    sourceFaithTraceId: evalCase.sourceFaithTraceId,
    question: evalCase.question,
    context: evalCase.context,
    sources: evalCase.sources,
    answer: evalCase.answer,
    human: evalCase.human,
    governance: evalCase.governance,
  };
}

export function selectEvalSuiteCases<T extends GovernedEvalCase>(
  argv: readonly string[],
  cases: readonly T[],
): EvalSuiteCaseSelection<T> {
  const parsed = parseEvalSuiteArgs(argv);
  if (parsed.remainingArgs.length > 0) {
    throw new Error(
      `unexpected eval arguments: ${parsed.remainingArgs.join(' ')}`,
    );
  }
  return {
    cases: selectCasesForSuite(cases, parsed.suite),
    suite: parsed.suite,
    scope: parsed.suite,
  };
}

export function selectJudgeCases(
  argv: readonly string[] = [],
  cases: readonly JudgeCalibrationCase[],
): JudgeCaseSelection {
  if (argv.length === 0) {
    return {
      cases: [...cases],
      scope: 'calibration',
      suffix: '',
      label: '完整校准集',
    };
  }

  const requestedIds = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--case') {
      throw new Error(
        '用法: npm run eval:judge -- [--case <case-id>]...',
      );
    }
    const id = argv[index + 1];
    if (id === undefined || id.startsWith('--')) {
      throw new Error(
        '用法: npm run eval:judge -- [--case <case-id>]...',
      );
    }
    if (requestedIds.has(id)) {
      throw new Error(`duplicate judge case ID: ${id}`);
    }
    requestedIds.add(id);
    index++;
  }

  const knownIds = new Set(cases.map((evalCase) => evalCase.id));
  const unknownIds = [...requestedIds].filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`unknown judge case ID: ${unknownIds.join(', ')}`);
  }
  const selected = cases.filter((evalCase) =>
    requestedIds.has(evalCase.id),
  );
  return {
    cases: selected,
    scope: 'targeted',
    suffix: '-targeted',
    label: `定向校准集: ${selected.map((evalCase) => evalCase.id).join(', ')}`,
  };
}

export function selectRetrievalCases(
  argv: readonly string[] = [],
  cases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): RetrievalCaseSelection {
  const parsed = parseEvalSuiteArgs(argv);
  if (parsed.remainingArgs.length > 1) {
    throw new Error(
      '用法: npm run eval -- [<k>] [--tuning|--holdout|--full]',
    );
  }
  const rawK = parsed.remainingArgs[0];
  const k = rawK === undefined ? 3 : Number(rawK);
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(
      '用法: npm run eval -- [<k>] [--tuning|--holdout|--full]',
    );
  }
  return {
    cases: selectCasesForSuite(cases, parsed.suite),
    suite: parsed.suite,
    scope: parsed.suite,
    k,
  };
}

export function selectFaithCases(
  argv: readonly string[] = [],
  cases: readonly GroundedAnswerCase[] = GROUNDED_ANSWER_CASES,
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
  fixCases: readonly FixCase[] = FIX_CASES,
): FaithCaseSelection {
  const parsed = parseEvalSuiteArgs(argv);
  const prepared = prepareFaithDataset(cases, retrievalCases, fixCases);
  if (parsed.remainingArgs.length > 0 && parsed.explicit) {
    throw new Error(
      'faith diagnostic mode cannot be combined with a suite flag',
    );
  }
  if (parsed.remainingArgs.length > 1) {
    throw new Error(
      '用法: npm run eval:faith -- [<N>|--policy|--tuning|--holdout|--full]',
    );
  }

  const diagnosticArg = parsed.remainingArgs[0];
  const tuningCases = selectCasesForSuite(prepared.cases, 'tuning');
  if (diagnosticArg === '--policy') {
    const selected = tuningCases.filter((evalCase) =>
      evalCase.id.startsWith('policy-'),
    );
    return {
      cases: selected,
      identity: resolvedFaithDatasetIdentity(selected),
      suffix: '-policy',
      label: ',policy 子集',
      scope: 'policy',
    };
  }
  if (diagnosticArg === undefined) {
    const selected = selectCasesForSuite(prepared.cases, parsed.suite);
    return {
      cases: selected,
      identity: resolvedFaithDatasetIdentity(selected),
      suffix:
        parsed.suite === 'tuning'
          ? ''
          : parsed.suite === 'holdout'
            ? '-holdout'
            : '-full',
      label:
        parsed.suite === 'tuning'
          ? ',tuning 套件'
          : parsed.suite === 'holdout'
            ? ',Holdout 留出集'
            : ',full 完整集',
      scope: parsed.suite,
    };
  }

  const smokeN = Number(diagnosticArg);
  if (!Number.isInteger(smokeN) || smokeN <= 0) {
    throw new Error(
      '用法: npm run eval:faith -- [<N>|--policy|--tuning|--holdout|--full]',
    );
  }
  const referenced = tuningCases
    .filter((evalCase) => evalCase.input.kind === 'retrieval_case')
    .slice(0, smokeN);
  const standalone = tuningCases
    .filter((evalCase) => evalCase.input.kind === 'standalone_question')
    .slice(0, smokeN);
  const selected = [...referenced, ...standalone];
  return {
    cases: selected,
    identity: resolvedFaithDatasetIdentity(selected),
    suffix: '-smoke',
    label: `,冒烟:检索引用/独立拒答各 ${smokeN}`,
    scope: 'smoke',
  };
}

export function retrievalDatasetIdentity(
  cases: readonly SemanticRetrievalCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'retrieval/semantic',
    cases,
    retrievalCaseSnapshot,
  );
}

export function faithDatasetIdentity(
  cases: readonly GroundedAnswerCase[],
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
  fixCases: readonly FixCase[] = FIX_CASES,
): EvalDatasetIdentity {
  return prepareFaithDataset(cases, retrievalCases, fixCases).identity;
}

function resolvedFaithDatasetIdentity(
  cases: readonly ResolvedGroundedAnswerCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'faith/grounded-answer-selection',
    cases,
    groundedAnswerCaseSnapshot,
  );
}

export function prepareFaithDataset(
  cases: readonly GroundedAnswerCase[],
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
  fixCases: readonly FixCase[] = FIX_CASES,
): {
  cases: ResolvedGroundedAnswerCase[];
  identity: EvalDatasetIdentity;
} {
  const resolvedCases = cases.map((evalCase) =>
    resolveGroundedAnswerCase(evalCase, retrievalCases, fixCases),
  );
  return {
    cases: resolvedCases,
    identity: resolvedFaithDatasetIdentity(resolvedCases),
  };
}

export function faithTraceDatasetIdentity(
  traces: readonly FaithTrace[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'faith/grounded-answer-selection',
    traces,
    faithTraceCaseSnapshot,
  );
}

export function judgeDatasetIdentity(
  cases: readonly JudgeCalibrationCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'judge/calibration',
    cases,
    judgeCaseSnapshot,
  );
}

export function generationDatasetIdentity(
  cases: readonly GenerationEvalCase[] = GENERATION_CASES,
): EvalDatasetIdentity {
  return datasetIdentity(
    'generation/cases',
    cases,
    generationCaseSnapshot,
  );
}

export function fixDatasetIdentity(
  cases: readonly FixCase[] = FIX_CASES,
): EvalDatasetIdentity {
  return datasetIdentity(
    'fix/cases',
    cases,
    fixCaseSnapshot,
  );
}

function queryExpansionConfig(): RetrievalEvalConfig['queryExpansion'] {
  const enabled = resolveQueryExpansionEnabled(undefined);
  if (!enabled) {
    return { enabled, registryHash: null, reviewedAliasCount: 0 };
  }

  const registry = loadAliasRegistrySnapshot();
  return registry.ok
    ? {
        enabled,
        registryHash: registry.snapshot.registryHash,
        reviewedAliasCount: registry.snapshot.reviewedAliasCount,
      }
    : { enabled, registryHash: null, reviewedAliasCount: 0 };
}

function retrievalConfigShape(k: number) {
  const corpus = buildCorpusManifest();
  const embeddingModel = resolveEmbeddingModel();
  return {
    corpusManifestHash: corpus.manifestHash,
    indexHash: computeIndexHash(corpus, embeddingModel),
    embeddingModel,
    rerankModel: RERANK_MODEL,
    queryExpansion: queryExpansionConfig(),
    k,
  };
}

function answerPromptHash(): string {
  return computeCanonicalHash({
    system: ASK_SYSTEM,
    userMessages: [
      buildAskUserMessage({
        question: '<question>',
        context: '<docs>',
        mode: 'free',
      }),
      buildAskUserMessage({
        question: '<question>',
        context: '<docs>',
        mode: 'explain_error',
        editorContext: {
          yaml: '<current_yaml>',
          kind: '<kind>',
          apiVersion: '<apiVersion>',
          cursorPath: '<cursorPath>',
          selectedText: '<selectedText>',
          errors: [
            { path: '<error_path>', message: '<error_message>' },
          ],
        },
      }),
    ],
    request: { model: ANSWER_MODEL, maxTokens: ASK_MAX_TOKENS },
  });
}

function judgePromptHash(): string {
  return computeCanonicalHash({
    system: JUDGE_SYSTEM,
    userMessageTemplate: JUDGE_USER_MESSAGE_TEMPLATE,
    request: { model: JUDGE_MODEL, maxTokens: JUDGE_MAX_TOKENS },
  });
}

function validationSchemaIdentity(): string {
  return computeCanonicalHash({
    logicRevision: VALIDATION_LOGIC_REVISION,
    schemaProviderManifestHash:
      SCHEMA_CORPUS_PROVIDER.manifest().manifestHash,
  });
}

function agentConfig(
  system: string,
): GenerationEvalConfig | FixEvalConfig {
  return {
    answerModel: ANSWER_MODEL,
    systemPromptHash: computeCanonicalHash({
      system,
      request: { model: ANSWER_MODEL, maxTokens: AGENT_MAX_TOKENS },
      maxRepairRounds: MAX_REPAIR_ROUNDS,
    }),
    toolSchemaIdentity: computeCanonicalHash(SUBMIT_YAML_TOOL),
    validationSchemaIdentity: validationSchemaIdentity(),
  };
}

export function retrievalEvalConfig(k: number): RetrievalEvalConfig {
  return retrievalConfigShape(k);
}

export function faithEvalConfig(k = FAITH_CONTEXT_K): FaithEvalConfig {
  return {
    ...retrievalConfigShape(k),
    answerModel: ANSWER_MODEL,
    judgeModel: JUDGE_MODEL,
    answerPromptHash: answerPromptHash(),
    judgePromptHash: judgePromptHash(),
    judgeParserSchemaIdentity: JUDGE_PARSER_SCHEMA_IDENTITY,
    judgeAttemptLimit: FAITH_JUDGE_ATTEMPT_LIMIT,
  };
}

export function judgeEvalConfig(
  voteCount = JUDGE_CALIBRATION_VOTES,
): JudgeEvalConfig {
  return {
    judgeModel: JUDGE_MODEL,
    voteCount,
    promptHash: judgePromptHash(),
    parserSchemaIdentity: JUDGE_PARSER_SCHEMA_IDENTITY,
  };
}

export function generationEvalConfig(): GenerationEvalConfig {
  return agentConfig(GENERATION_SYSTEM);
}

export function fixEvalConfig(): FixEvalConfig {
  return agentConfig(FIX_SYSTEM);
}

export function buildRetrievalEvalTracePayload(params: {
  trace: RetrievalTrace;
  expectedChunkIds: readonly string[];
  rankedIds: readonly string[];
  k: number;
}): RetrievalEvalTracePayload {
  const { trace, expectedChunkIds, rankedIds, k } = params;
  const topKIds = rankedIds.slice(0, k);
  const foundIds = expectedChunkIds.filter((id) => topKIds.includes(id));
  const firstIndex = rankedIds.findIndex((id) => expectedChunkIds.includes(id));
  const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1;

  return toPersistedPayload({
    trace,
    expected: { chunkIds: [...expectedChunkIds], k },
    ranking: {
      topKIds,
      foundIds,
      firstRelevantRank,
      recall: foundIds.length / expectedChunkIds.length,
      reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    },
  });
}

export function faithEnvelopeOutcome(trace: FaithTrace): EnvelopeOutcome {
  switch (trace.outcome) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'judge_failed':
      return 'skipped';
    case 'error':
      return 'error';
  }
}

export function judgeEnvelopeOutcome(
  trace: JudgeCalibrationTrace,
): EnvelopeOutcome {
  if (trace.majority.agree === null) return 'skipped';
  if (!trace.majority.agree) return 'failed';
  if (trace.responseBehavior?.agree === null) return 'skipped';
  if (trace.responseBehavior?.agree === false) return 'failed';
  return 'success';
}

export function generationEnvelopeOutcome(
  result: GenerationCaseResult,
): EnvelopeOutcome {
  return result.contentPass ? 'success' : 'failed';
}

export function fixEnvelopeOutcome(result: FixCaseResult): EnvelopeOutcome {
  return result.contentPass ? 'success' : 'failed';
}

export function isDirectExecution(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}

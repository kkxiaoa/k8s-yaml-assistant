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
import { ANSWER_SYSTEM, MODEL } from './answer';
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
import type { FaithTrace } from './faith-store';
import {
  FAITH_JUDGE_ATTEMPT_LIMIT,
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_SYSTEM,
} from './judge';
import { TEXT_MAX_TOKENS } from './llm';
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
  type EvalDatasetIdentity,
  type EvalKind,
  type FaithEvalConfig,
  type FixEvalConfig,
  type GenerationEvalConfig,
  type JudgeEvalConfig,
  type MetricObservation,
  type RetrievalEvalConfig,
  type TraceEnvelope,
} from './protocol';

export const LEGACY_METRIC_DEFINITION_VERSION = 'legacy-v1';
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
  cases: GroundedAnswerCase[];
  suffix: '' | '-smoke' | '-policy';
  label: string;
  scope: 'full' | 'policy' | 'smoke';
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

function datasetIdentity<T>(
  id: string,
  cases: readonly T[],
  caseId: (evalCase: T) => string,
  snapshot: (evalCase: T) => unknown,
): EvalDatasetIdentity {
  return EvalDatasetIdentitySchema.parse({
    id,
    hash: computeDatasetHash(cases.map(snapshot)),
    caseIds: cases.map(caseId),
    caseCount: cases.length,
  });
}

function retrievalCaseSnapshot(evalCase: SemanticRetrievalCase): unknown {
  return {
    id: evalCase.id,
    question: evalCase.question,
    expectedChunkIds: [...evalCase.expectedChunkIds].sort(),
    target: evalCase.target,
    source: evalCase.source,
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
  };
}

function generationCaseSnapshot(evalCase: GenerationEvalCase): unknown {
  return {
    id: evalCase.id,
    requirement: evalCase.requirement,
    expectedResources: evalCase.expectedResources,
    relations: evalCase.relations ?? [],
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
  };
}

export function selectRetrievalCases(
  cases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): SemanticRetrievalCase[] {
  return [...cases];
}

export function selectFaithCases(
  arg: string | undefined,
  cases: readonly GroundedAnswerCase[] = GROUNDED_ANSWER_CASES,
): FaithCaseSelection {
  if (arg === '--policy') {
    return {
      cases: cases.filter((evalCase) => evalCase.id.startsWith('policy-')),
      suffix: '-policy',
      label: ',policy 子集',
      scope: 'policy',
    };
  }
  if (!arg) {
    return { cases: [...cases], suffix: '', label: '', scope: 'full' };
  }

  const smokeN = Number(arg);
  if (!Number.isFinite(smokeN) || smokeN <= 0) {
    throw new Error('用法: npm run eval:faith [-- <N>|--policy]');
  }
  const referenced = cases
    .filter((evalCase) => evalCase.input.kind === 'retrieval_case')
    .slice(0, smokeN);
  const standalone = cases
    .filter((evalCase) => evalCase.input.kind === 'standalone_question')
    .slice(0, smokeN);
  return {
    cases: [...referenced, ...standalone],
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
    (evalCase) => evalCase.id,
    retrievalCaseSnapshot,
  );
}

export function faithDatasetIdentity(
  cases: readonly GroundedAnswerCase[],
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): EvalDatasetIdentity {
  return prepareFaithDataset(cases, retrievalCases).identity;
}

export function prepareFaithDataset(
  cases: readonly GroundedAnswerCase[],
  retrievalCases: readonly SemanticRetrievalCase[] = RETRIEVAL_CASES,
): {
  cases: ResolvedGroundedAnswerCase[];
  identity: EvalDatasetIdentity;
} {
  const resolvedCases = cases.map((evalCase) =>
    resolveGroundedAnswerCase(evalCase, retrievalCases),
  );
  return {
    cases: resolvedCases,
    identity: datasetIdentity(
      'faith/grounded-answer-selection',
      resolvedCases,
      (evalCase) => evalCase.id,
      groundedAnswerCaseSnapshot,
    ),
  };
}

export function faithTraceDatasetIdentity(
  traces: readonly FaithTrace[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'faith/grounded-answer-selection',
    traces,
    (trace) => trace.id,
    faithTraceCaseSnapshot,
  );
}

export function judgeDatasetIdentity(
  cases: readonly JudgeCalibrationCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'judge/calibration',
    cases,
    (evalCase) => evalCase.id,
    judgeCaseSnapshot,
  );
}

export function generationDatasetIdentity(
  cases: readonly GenerationEvalCase[] = GENERATION_CASES,
): EvalDatasetIdentity {
  return datasetIdentity(
    'generation/cases',
    cases,
    (evalCase) => evalCase.id,
    generationCaseSnapshot,
  );
}

export function fixDatasetIdentity(
  cases: readonly FixCase[] = FIX_CASES,
): EvalDatasetIdentity {
  return datasetIdentity(
    'fix/cases',
    cases,
    (evalCase) => evalCase.id,
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
    corpusContentHash: corpus.contentHash,
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
    system: ANSWER_SYSTEM,
    request: { model: MODEL, maxTokens: TEXT_MAX_TOKENS },
  });
}

function judgePromptHash(): string {
  return computeCanonicalHash({
    system: JUDGE_SYSTEM,
    request: { model: JUDGE_MODEL, maxTokens: TEXT_MAX_TOKENS },
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
    answerModel: MODEL,
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
    case 'faithful_hit':
    case 'refused_correctly':
      return 'success';
    case 'judge_failed':
      return 'skipped';
    case 'error':
      return 'error';
    default:
      return 'failed';
  }
}

export function judgeEnvelopeOutcome(
  trace: JudgeCalibrationTrace,
): EnvelopeOutcome {
  return trace.majority.agree === null
    ? 'skipped'
    : trace.majority.agree
      ? 'success'
      : 'failed';
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

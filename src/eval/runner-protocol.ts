import { pathToFileURL } from 'node:url';
import {
  AGENT_MAX_TOKENS,
  ANSWER_MODEL,
  FIX_SYSTEM,
  GENERATION_SYSTEM,
  MAX_REPAIR_ROUNDS,
  SUBMIT_YAML_TOOL,
} from '../server/agent-contract';
import { CORPUS } from '../knowledge/corpus';
import { SCHEMA_DEFINITIONS, SCHEMA_DOCS } from '../knowledge/schemas';
import { resolveEmbeddingModel } from '../retrieval/embeddings';
import { computeCorpusHash, computeIndexHash } from '../retrieval/index-store';
import {
  loadAliasRegistrySnapshot,
  resolveQueryExpansionEnabled,
} from '../retrieval/query-expansion-runtime';
import { RERANK_MODEL } from '../retrieval/rerank';
import type { RetrievalTrace } from '../retrieval/trace';
import { VALIDATION_LOGIC_REVISION } from '../validation/validate';
import { ANSWER_SYSTEM, MODEL } from './answer';
import {
  FIX_CASES,
  type FixEvalCase,
} from './cases/fix-cases';
import {
  GENERATION_CASES,
  type GenerationEvalCase,
} from './cases/generation-cases';
import {
  RETRIEVAL_CASES,
  type RetrievalEvalCase,
} from './cases/retrieval-cases';
import type { FaithTrace } from './faith-store';
import {
  JUDGE_MODEL,
  JUDGE_PARSER_SCHEMA_IDENTITY,
  JUDGE_PARSE_ATTEMPTS,
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
  EvalDatasetIdentitySchema,
  computeCanonicalHash,
  computeDatasetHash,
  type EvalDatasetIdentity,
  type FaithEvalConfig,
  type FixEvalConfig,
  type GenerationEvalConfig,
  type JudgeEvalConfig,
  type RetrievalEvalConfig,
  type TraceEnvelope,
} from './protocol';

export const LEGACY_METRIC_DEFINITION_VERSION = 'legacy-v1';
export const FAITH_CONTEXT_K = 3;
export const JUDGE_CALIBRATION_VOTES = 5;

type EnvelopeOutcome = TraceEnvelope['outcome'];

export interface FaithCaseSelection {
  cases: RetrievalEvalCase[];
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

function retrievalCaseSnapshot(evalCase: RetrievalEvalCase): unknown {
  return {
    id: evalCase.id,
    taskType: evalCase.taskType,
    question: evalCase.question,
    expectedChunkIds: [...evalCase.expectedChunkIds].sort(),
    resource: evalCase.resource ?? null,
    answerable: evalCase.answerable,
    source: evalCase.source,
    apiVersion: evalCase.apiVersion ?? null,
    path: evalCase.path ?? null,
  };
}

function generationCaseSnapshot(evalCase: GenerationEvalCase): unknown {
  return {
    id: evalCase.id,
    requirement: evalCase.requirement,
    expectedKinds: [...evalCase.expectedKinds].sort(),
    mustHavePaths: [...evalCase.mustHavePaths].sort(),
    consistencyChecks: [...(evalCase.consistencyChecks ?? [])].sort(),
  };
}

function fixCaseSnapshot(evalCase: FixEvalCase): unknown {
  return {
    id: evalCase.id,
    defect: evalCase.defect,
    defectType: evalCase.defectType,
    brokenYaml: evalCase.brokenYaml,
    expectedKind: evalCase.expectedKind,
    mustPreserve: evalCase.mustPreserve,
  };
}

function judgeCaseSnapshot(evalCase: JudgeCalibrationCase): unknown {
  return {
    id: evalCase.id,
    category: evalCase.category,
    question: evalCase.question,
    context: evalCase.context,
    answer: evalCase.answer,
    human: evalCase.human,
  };
}

export function selectRetrievalCases(
  cases: readonly RetrievalEvalCase[] = RETRIEVAL_CASES,
): RetrievalEvalCase[] {
  return cases.filter((evalCase) => evalCase.answerable);
}

export function selectFaithCases(
  arg: string | undefined,
  cases: readonly RetrievalEvalCase[] = RETRIEVAL_CASES,
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
  const answerable = cases
    .filter((evalCase) => evalCase.answerable)
    .slice(0, smokeN);
  const refusal = cases
    .filter((evalCase) => !evalCase.answerable)
    .slice(0, smokeN);
  return {
    cases: [...answerable, ...refusal],
    suffix: '-smoke',
    label: `,冒烟:可答/拒答各 ${smokeN}`,
    scope: 'smoke',
  };
}

export function retrievalDatasetIdentity(
  cases: readonly RetrievalEvalCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'retrieval/answerable',
    cases,
    (evalCase) => evalCase.id,
    retrievalCaseSnapshot,
  );
}

export function faithDatasetIdentity(
  cases: readonly RetrievalEvalCase[],
): EvalDatasetIdentity {
  return datasetIdentity(
    'faith/retrieval-selection',
    cases,
    (evalCase) => evalCase.id,
    retrievalCaseSnapshot,
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
  cases: readonly FixEvalCase[] = FIX_CASES,
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
  const corpusHash = computeCorpusHash(CORPUS);
  const embeddingModel = resolveEmbeddingModel();
  return {
    corpusHash,
    indexHash: computeIndexHash(corpusHash, embeddingModel),
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
    parseAttempts: JUDGE_PARSE_ATTEMPTS,
  });
}

function validationSchemaIdentity(): string {
  const resources = [...SCHEMA_DOCS].sort((left, right) =>
    `${left.apiVersion}/${left.kind ?? left.resource}`.localeCompare(
      `${right.apiVersion}/${right.kind ?? right.resource}`,
    ),
  );
  const definitions = [...SCHEMA_DEFINITIONS.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return computeCanonicalHash({
    logicRevision: VALIDATION_LOGIC_REVISION,
    resources,
    definitions,
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
  return result.validYaml && result.kindKept && result.intentPreserved
    ? 'success'
    : 'failed';
}

export function isDirectExecution(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}

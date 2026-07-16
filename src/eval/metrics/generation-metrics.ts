// 生成和修复评估的纯度量函数；import 不触发 runner 或模型调用。

import type { GenerationEvalCase } from '../cases/generation-cases';
import type { GenerateResult } from '../../server/agent';
import { validateYamlDocuments } from '../../validation/validate';
import {
  evaluateExpectedResource,
  evaluateFixResourceSet,
  evaluateGenerationAssertions,
  parseKubernetesDocuments,
  type DefectType,
  type ExpectedResource,
  type ExpectedResourceResult,
  type FieldAssertion,
  type FieldAssertionResult,
  type FixCase,
  type FixFixturePreflight,
  type FixResourceSetResult,
  type KubernetesDocument,
  type ResourceIdentity,
  type ResourceMatchResult,
  type ResourceRelation,
  type ResourceRelationResult,
} from '../assertions';
import {
  metricObservation,
  type MetricObservation,
} from '../protocol';

/** 从每次 submit 的结构化 attempts 汇总多轮行为(gen/fix 共用)。 */
export interface AttemptStats {
  n: number;
  firstParseOk: number; // 首轮 parse 成功率
  firstValidationOk: number; // 首轮校验通过率
  repairAttempted: number; // 首轮失败 → 尝试修复 的比例
  failedFirst: number; // 首轮失败的用例数(下面比率的分母)
  repairSuccessAfterFail: number; // 首轮失败者中最终修成的比例
  maxRoundFailure: number; // 达上限仍失败(yaml=null)的比例
  avgSubmits: number;
  avgRounds: number;
}

export function attemptStats(results: GenerateResult[]): AttemptStats {
  const n = results.length || 1;
  let firstParse = 0;
  let firstVal = 0;
  let repairAtt = 0;
  let failedFirst = 0;
  let repairedFromFail = 0;
  let capFail = 0;
  let submitsSum = 0;
  let roundsSum = 0;
  for (const r of results) {
    const a0 = r.attempts[0];
    if (a0?.parseOk) firstParse++;
    if (a0?.validationOk) firstVal++;
    const firstFailed = a0 ? !a0.validationOk : true;
    if (r.attempts.length > 1) repairAtt++;
    if (firstFailed) {
      failedFirst++;
      if (r.yaml !== null) repairedFromFail++;
    }
    if (r.yaml === null) capFail++;
    submitsSum += r.attempts.length;
    roundsSum += r.rounds;
  }
  return {
    n: results.length,
    firstParseOk: firstParse / n,
    firstValidationOk: firstVal / n,
    repairAttempted: repairAtt / n,
    failedFirst,
    repairSuccessAfterFail: failedFirst ? repairedFromFail / failedFirst : 1,
    maxRoundFailure: capFail / n,
    avgSubmits: submitsSum / n,
    avgRounds: roundsSum / n,
  };
}

export interface AttemptSummary {
  submitIndex: number;
  parseOk: boolean;
  validationOk: boolean;
  errorCount: number;
}

export interface GenerationCaseResult {
  id: string;
  requirement: string;
  expectedResources: ExpectedResource[];
  relations: ResourceRelation[];
  rationale: string[];
  finalYaml: string | null;
  attempts: GenerateResult['attempts'];
  attemptSummary: AttemptSummary[];
  diagnostics: GenerateResult['diagnostics'];
  rounds: number;
  submitCount: number;
  validYaml: boolean;
  finalKinds: string[];
  resourceResults: ExpectedResourceResult[];
  relationResults: ResourceRelationResult[];
  expectedResourceCount: number;
  matchedResourceCount: number;
  resourceMatchPass: boolean;
  resourceAssertionPassCount: number;
  resourceAssertionTotal: number;
  resourceAssertionPass: boolean;
  relationPassCount: number;
  relationTotal: number;
  relationPass: boolean | null;
  contentPass: boolean;
  validationErrorSummary: string[];
}

export interface FixCaseResult {
  id: string;
  defectType: DefectType;
  target: ResourceIdentity;
  preserve: FieldAssertion[];
  expectedCorrections: FieldAssertion[];
  finalYaml: string | null;
  attempts: GenerateResult['attempts'];
  attemptSummary: AttemptSummary[];
  diagnostics: GenerateResult['diagnostics'];
  rounds: number;
  submitCount: number;
  validYaml: boolean;
  finalKinds: string[];
  targetMatch: ResourceMatchResult;
  preserveResults: FieldAssertionResult[];
  preservePassCount: number;
  preserveTotal: number;
  preservePass: boolean;
  correctionResults: FieldAssertionResult[];
  correctionPassCount: number;
  correctionTotal: number;
  correctionPass: boolean;
  resourceSet: FixResourceSetResult;
  sideEffectFree: boolean;
  contentPass: boolean;
  validationErrorSummary: string[];
}

export interface GenerationEvalMetrics {
  caseCount: number;
  validYamlCount: number;
  resourceAssertionCount: number;
  resourceAssertionPassCount: number;
  relationCount: number;
  relationPassCount: number;
  contentPassCount: number;
  attemptStats: AttemptStats;
}

export interface FixEvalMetrics {
  caseCount: number;
  validYamlCount: number;
  correctionPassCount: number;
  preservePassCount: number;
  sideEffectFreePassCount: number;
  contentPassCount: number;
  attemptStats: AttemptStats;
  byDefectType: Record<DefectType, { total: number; fixed: number }>;
}

function attemptSummary(result: GenerateResult): AttemptSummary[] {
  return result.attempts.map((attempt) => ({
    submitIndex: attempt.submitIndex,
    parseOk: attempt.parseOk,
    validationOk: attempt.validationOk,
    errorCount: attempt.errors.length,
  }));
}

function validationErrorSummary(result: GenerateResult): string[] {
  const lastErrors = result.attempts.at(-1)?.errors ?? [];
  return lastErrors.map((error) => `${error.path || '(根)'}: ${error.message}`);
}

export function buildGenerationCaseResult(
  evalCase: GenerationEvalCase,
  result: GenerateResult,
): GenerationCaseResult {
  const validation = result.yaml
    ? validateYamlDocuments(result.yaml)
    : { errors: [], parseFailed: true };
  const validYaml = result.yaml !== null && validation.errors.length === 0;
  const docs = result.yaml ? parseKubernetesDocuments(result.yaml) : [];
  const finalKinds = docs
    .map((doc) => doc.kind)
    .filter((kind): kind is string => typeof kind === 'string');
  const assertionResult = evaluateGenerationAssertions(evalCase, docs);
  const fieldResults = assertionResult.resources.flatMap(
    (resource) => resource.assertions,
  );
  const resourceAssertionPassCount = fieldResults.filter(
    (assertion) => assertion.pass,
  ).length;
  const relationPassCount = assertionResult.relations.filter(
    (relation) => relation.pass,
  ).length;

  return {
    id: evalCase.id,
    requirement: evalCase.requirement,
    expectedResources: evalCase.expectedResources,
    relations: evalCase.relations ?? [],
    rationale: evalCase.rationale ?? [],
    finalYaml: result.yaml,
    attempts: result.attempts,
    attemptSummary: attemptSummary(result),
    diagnostics: result.diagnostics,
    rounds: result.rounds,
    submitCount: result.attempts.length,
    validYaml,
    finalKinds,
    resourceResults: assertionResult.resources,
    relationResults: assertionResult.relations,
    expectedResourceCount: assertionResult.resources.length,
    matchedResourceCount: assertionResult.resources.filter(
      (resource) => resource.match.status === 'matched',
    ).length,
    resourceMatchPass: assertionResult.resourceMatchPass,
    resourceAssertionPassCount,
    resourceAssertionTotal: fieldResults.length,
    resourceAssertionPass: assertionResult.resourceAssertionPass,
    relationPassCount,
    relationTotal: assertionResult.relations.length,
    relationPass: assertionResult.relationPass,
    contentPass: validYaml && assertionResult.pass,
    validationErrorSummary: validationErrorSummary(result),
  };
}

export function buildFixCaseResult(
  evalCase: FixCase,
  result: GenerateResult,
  fixture: FixFixturePreflight,
): FixCaseResult {
  if (fixture.caseId !== evalCase.id) {
    throw new Error(
      `fix fixture ${fixture.caseId} does not match case ${evalCase.id}`,
    );
  }
  const validation = result.yaml
    ? validateYamlDocuments(result.yaml)
    : { errors: [], parseFailed: true };
  const validYaml = result.yaml !== null && validation.errors.length === 0;
  const docs = result.yaml ? parseKubernetesDocuments(result.yaml) : [];
  const finalKinds = docs
    .map((doc) => doc.kind)
    .filter((kind): kind is string => typeof kind === 'string');
  const preserveResult = evaluateExpectedResource(
    {
      ref: 'fix-target',
      identity: evalCase.target,
      assertions: evalCase.preserve,
    },
    docs,
  );
  const correctionResult = evaluateExpectedResource(
    {
      ref: 'fix-target',
      identity: evalCase.target,
      assertions: evalCase.expectedCorrections,
    },
    docs,
  );
  const preservePassCount = preserveResult.assertions.filter(
    (assertion) => assertion.pass,
  ).length;
  const correctionPassCount = correctionResult.assertions.filter(
    (assertion) => assertion.pass,
  ).length;
  const resourceSet = evaluateFixResourceSet(fixture, docs);
  const targetMatch = correctionResult.match;
  const preservePass = preserveResult.pass;
  const correctionPass = correctionResult.pass;
  const sideEffectFree = resourceSet.pass;
  const contentPass =
    validYaml &&
    targetMatch.status === 'matched' &&
    preservePass &&
    correctionPass &&
    sideEffectFree;

  return {
    id: evalCase.id,
    defectType: evalCase.defectType,
    target: evalCase.target,
    preserve: evalCase.preserve,
    expectedCorrections: evalCase.expectedCorrections,
    finalYaml: result.yaml,
    attempts: result.attempts,
    attemptSummary: attemptSummary(result),
    diagnostics: result.diagnostics,
    rounds: result.rounds,
    submitCount: result.attempts.length,
    validYaml,
    finalKinds,
    targetMatch,
    preserveResults: preserveResult.assertions,
    preservePassCount,
    preserveTotal: preserveResult.assertions.length,
    preservePass,
    correctionResults: correctionResult.assertions,
    correctionPassCount,
    correctionTotal: correctionResult.assertions.length,
    correctionPass,
    resourceSet,
    sideEffectFree,
    contentPass,
    validationErrorSummary: validationErrorSummary(result),
  };
}

export function computeGenerationEvalMetrics(
  results: GenerationCaseResult[],
): GenerationEvalMetrics {
  return {
    caseCount: results.length,
    validYamlCount: results.filter((result) => result.validYaml).length,
    resourceAssertionCount: results.reduce(
      (sum, result) => sum + result.resourceAssertionTotal,
      0,
    ),
    resourceAssertionPassCount: results.reduce(
      (sum, result) => sum + result.resourceAssertionPassCount,
      0,
    ),
    relationCount: results.reduce(
      (sum, result) => sum + result.relationTotal,
      0,
    ),
    relationPassCount: results.reduce(
      (sum, result) => sum + result.relationPassCount,
      0,
    ),
    contentPassCount: results.filter((result) => result.contentPass).length,
    attemptStats: attemptStats(
      results.map((result) => ({
        yaml: result.finalYaml,
        rounds: result.rounds,
        attempts: result.attempts,
        diagnostics: result.diagnostics,
      })),
    ),
  };
}

export function computeFixEvalMetrics(
  results: FixCaseResult[],
): FixEvalMetrics {
  const byDefectType = {} as FixEvalMetrics['byDefectType'];
  for (const result of results) {
    const current = byDefectType[result.defectType] ?? { total: 0, fixed: 0 };
    current.total++;
    if (result.contentPass) current.fixed++;
    byDefectType[result.defectType] = current;
  }
  return {
    caseCount: results.length,
    validYamlCount: results.filter((result) => result.validYaml).length,
    correctionPassCount: results.filter((result) => result.correctionPass)
      .length,
    preservePassCount: results.filter((result) => result.preservePass).length,
    sideEffectFreePassCount: results.filter(
      (result) => result.sideEffectFree,
    ).length,
    contentPassCount: results.filter((result) => result.contentPass).length,
    attemptStats: attemptStats(
      results.map((result) => ({
        yaml: result.finalYaml,
        rounds: result.rounds,
        attempts: result.attempts,
        diagnostics: result.diagnostics,
      })),
    ),
    byDefectType,
  };
}

function attemptMetricsRecord(
  prefix: string,
  stats: AttemptStats,
): Record<string, MetricObservation> {
  const n = stats.n;
  return {
    [`${prefix}.first_parse_ok_rate`]: metricObservation(
      n ? stats.firstParseOk : null,
      stats.firstParseOk * n,
      n,
    ),
    [`${prefix}.first_validation_ok_rate`]: metricObservation(
      n ? stats.firstValidationOk : null,
      stats.firstValidationOk * n,
      n,
    ),
    [`${prefix}.repair_attempted_rate`]: metricObservation(
      n ? stats.repairAttempted : null,
      stats.repairAttempted * n,
      n,
    ),
    [`${prefix}.repair_success_after_fail_rate`]: metricObservation(
      stats.failedFirst ? stats.repairSuccessAfterFail : null,
      stats.failedFirst ? stats.repairSuccessAfterFail * stats.failedFirst : 0,
      stats.failedFirst,
    ),
    [`${prefix}.max_round_failure_rate`]: metricObservation(
      n ? stats.maxRoundFailure : null,
      stats.maxRoundFailure * n,
      n,
    ),
    [`${prefix}.avg_submits`]: metricObservation(
      n ? stats.avgSubmits : null,
      stats.avgSubmits * n,
      n,
    ),
    [`${prefix}.avg_rounds`]: metricObservation(
      n ? stats.avgRounds : null,
      stats.avgRounds * n,
      n,
    ),
  };
}

export function generationMetricsRecord(
  metrics: GenerationEvalMetrics,
): Record<string, MetricObservation> {
  const record: Record<string, MetricObservation> = {
    'generation.valid_yaml_rate': metricObservation(
      metrics.caseCount ? metrics.validYamlCount / metrics.caseCount : null,
      metrics.validYamlCount,
      metrics.caseCount,
    ),
    'generation.resource_assertion_pass_rate': metricObservation(
      metrics.resourceAssertionCount
        ? metrics.resourceAssertionPassCount / metrics.resourceAssertionCount
        : null,
      metrics.resourceAssertionPassCount,
      metrics.resourceAssertionCount,
    ),
    'generation.relation_pass_rate': metricObservation(
      metrics.relationCount
        ? metrics.relationPassCount / metrics.relationCount
        : null,
      metrics.relationPassCount,
      metrics.relationCount,
    ),
    'generation.content_pass_rate': metricObservation(
      metrics.caseCount ? metrics.contentPassCount / metrics.caseCount : null,
      metrics.contentPassCount,
      metrics.caseCount,
    ),
    ...attemptMetricsRecord('generation', metrics.attemptStats),
  };
  return record;
}

export function fixMetricsRecord(
  metrics: FixEvalMetrics,
): Record<string, MetricObservation> {
  const record: Record<string, MetricObservation> = {
    'fix.valid_yaml_rate': metricObservation(
      metrics.caseCount ? metrics.validYamlCount / metrics.caseCount : null,
      metrics.validYamlCount,
      metrics.caseCount,
    ),
    'fix.expected_correction_pass_rate': metricObservation(
      metrics.caseCount
        ? metrics.correctionPassCount / metrics.caseCount
        : null,
      metrics.correctionPassCount,
      metrics.caseCount,
    ),
    'fix.preserve_pass_rate': metricObservation(
      metrics.caseCount ? metrics.preservePassCount / metrics.caseCount : null,
      metrics.preservePassCount,
      metrics.caseCount,
    ),
    'fix.side_effect_free_pass_rate': metricObservation(
      metrics.caseCount
        ? metrics.sideEffectFreePassCount / metrics.caseCount
        : null,
      metrics.sideEffectFreePassCount,
      metrics.caseCount,
    ),
    'fix.success_rate': metricObservation(
      metrics.caseCount ? metrics.contentPassCount / metrics.caseCount : null,
      metrics.contentPassCount,
      metrics.caseCount,
    ),
    ...attemptMetricsRecord('fix', metrics.attemptStats),
  };
  for (const [type, value] of Object.entries(metrics.byDefectType)) {
    record[`fix.defect.${type}.success_rate`] = metricObservation(
      value.total ? value.fixed / value.total : null,
      value.fixed,
      value.total,
    );
  }
  return record;
}

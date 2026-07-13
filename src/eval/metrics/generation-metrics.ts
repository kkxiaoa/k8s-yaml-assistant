// 生成评估的纯度量函数(无副作用、无网络):路径存在性 + 跨资源一致性检查。
// 独立成模块,便于单测/复用,且 import 不会触发 eval:gen 跑批(runner 的 main 在 generation-eval.ts)。

import { loadAll } from 'js-yaml';
import type {
  ConsistencyCheck,
  GenerationEvalCase,
} from '../cases/generation-cases';
import type { DefectType, FixEvalCase } from '../cases/fix-cases';
import type { GenerateResult } from '../../server/agent';
import { validateYamlDocuments } from '../../validation/validate';
import {
  metricObservation,
  type MetricObservation,
} from '../protocol';

export type Doc = Record<string, unknown>;

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

export interface ConsistencyResult {
  check: ConsistencyCheck;
  pass: boolean;
}

export interface GenerationCaseResult {
  id: string;
  requirement: string;
  expectedKinds: string[];
  mustHavePaths: string[];
  consistencyChecks: ConsistencyCheck[];
  finalYaml: string | null;
  attempts: GenerateResult['attempts'];
  attemptSummary: AttemptSummary[];
  diagnostics: GenerateResult['diagnostics'];
  rounds: number;
  submitCount: number;
  validYaml: boolean;
  finalKinds: string[];
  kindMatch: boolean;
  requiredPathHits: string[];
  requiredPathTotal: number;
  requiredPathCoverage: number;
  consistencyResults: ConsistencyResult[];
  consistencyPass: boolean | null;
  contentPass: boolean;
  validationErrorSummary: string[];
}

export interface FixCaseResult {
  id: string;
  defect: string;
  defectType: DefectType;
  expectedKind: string;
  mustPreserve: FixEvalCase['mustPreserve'];
  finalYaml: string | null;
  attempts: GenerateResult['attempts'];
  attemptSummary: AttemptSummary[];
  diagnostics: GenerateResult['diagnostics'];
  rounds: number;
  submitCount: number;
  validYaml: boolean;
  finalKinds: string[];
  kindKept: boolean;
  preserved: FixEvalCase['mustPreserve'];
  preserveTotal: number;
  preserveCoverage: number;
  intentPreserved: boolean;
  validationErrorSummary: string[];
}

export interface GenerationEvalMetrics {
  caseCount: number;
  validYamlCount: number;
  kindMatchCount: number;
  requiredPathCoverageAvg: number;
  consistencyCaseCount: number;
  consistencyPassCount: number;
  attemptStats: AttemptStats;
}

export interface FixEvalMetrics {
  caseCount: number;
  validYamlCount: number;
  kindKeptCount: number;
  intentPreservedCount: number;
  preserveCoverageAvg: number;
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

const WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
]);

function asObj(v: unknown): Doc | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : null;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function subsetMatch(sub: Doc, sup: Doc): boolean {
  const keys = Object.keys(sub);
  return keys.length > 0 && keys.every((k) => sup[k] === sub[k]);
}

/** path 存在性:数组段自动对元素展开(spec…containers.image 命中任一 container 即算有)。 */
export function hasPath(node: unknown, segs: string[]): boolean {
  if (segs.length === 0) return node !== undefined && node !== null;
  if (node == null) return false;
  if (Array.isArray(node)) return node.some((el) => hasPath(el, segs));
  if (typeof node === 'object') {
    const key = segs[0]!;
    if (!(key in (node as Doc))) return false;
    return hasPath((node as Doc)[key], segs.slice(1));
  }
  return false;
}

/** 收集 path 上的所有值(数组段展开)。供 fix 的"意图保留"检查。 */
export function pathValues(node: unknown, segs: string[]): unknown[] {
  if (segs.length === 0) return node === undefined ? [] : [node];
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap((el) => pathValues(el, segs));
  if (typeof node === 'object') {
    const key = segs[0]!;
    if (!(key in (node as Doc))) return [];
    return pathValues((node as Doc)[key], segs.slice(1));
  }
  return [];
}

/** 某 path 上是否存在等于 value 的值(修复后关键字段/值是否被保留)。 */
export function valuePreserved(
  docs: Doc[],
  path: string,
  value: unknown,
): boolean {
  return docs.some((d) =>
    pathValues(d, path.split('.')).some((v) => v === value),
  );
}

export function docsOf(yaml: string): Doc[] {
  try {
    return (loadAll(yaml) as unknown[]).filter(
      (d): d is Doc => d != null && typeof d === 'object',
    );
  } catch {
    return [];
  }
}

function templateLabels(doc: Doc): Doc {
  const t = asObj(asObj(doc.spec)?.template);
  return asObj(asObj(t?.metadata)?.labels) ?? {};
}

function selectorLabelMatch(docs: Doc[]): boolean {
  const workloads = docs.filter(
    (d) => WORKLOAD_KINDS.has(d.kind as string) && asObj(d.spec)?.template,
  );
  for (const w of workloads) {
    const sel = asObj(asObj(asObj(w.spec)?.selector)?.matchLabels);
    if (sel && !subsetMatch(sel, templateLabels(w))) return false;
  }
  for (const s of docs.filter((d) => d.kind === 'Service')) {
    const sel = asObj(asObj(s.spec)?.selector);
    if (!sel || Object.keys(sel).length === 0) continue; // headless 无 selector
    if (!workloads.some((w) => subsetMatch(sel, templateLabels(w)))) return false;
  }
  return true;
}

function containerPorts(docs: Doc[]): Set<number | string> {
  const ports = new Set<number | string>();
  for (const w of docs.filter((d) => WORKLOAD_KINDS.has(d.kind as string))) {
    const containers = asArr(
      asObj(asObj(asObj(w.spec)?.template)?.spec)?.containers,
    );
    for (const c of containers) {
      for (const p of asArr(asObj(c)?.ports)) {
        const cp = asObj(p);
        if (cp?.containerPort != null) ports.add(cp.containerPort as number);
        if (typeof cp?.name === 'string') ports.add(cp.name);
      }
    }
  }
  return ports;
}

function serviceTargetPortMatch(docs: Doc[]): boolean {
  const cports = containerPorts(docs);
  for (const s of docs.filter((d) => d.kind === 'Service')) {
    for (const p of asArr(asObj(s.spec)?.ports)) {
      const po = asObj(p);
      if (!po) continue;
      const target = po.targetPort ?? po.port; // 缺省 targetPort = port
      if (target != null && !cports.has(target as number | string)) return false;
    }
  }
  return true;
}

function ingressServiceMatch(docs: Doc[]): boolean {
  const svcNames = new Set(
    docs
      .filter((d) => d.kind === 'Service')
      .map((d) => asObj(d.metadata)?.name)
      .filter((n): n is string => typeof n === 'string'),
  );
  const refs: string[] = [];
  for (const ing of docs.filter((d) => d.kind === 'Ingress')) {
    const spec = asObj(ing.spec);
    const db = asObj(asObj(spec?.defaultBackend)?.service)?.name;
    if (typeof db === 'string') refs.push(db);
    for (const rule of asArr(spec?.rules)) {
      for (const p of asArr(asObj(asObj(rule)?.http)?.paths)) {
        const name = asObj(asObj(asObj(p)?.backend)?.service)?.name;
        if (typeof name === 'string') refs.push(name);
      }
    }
  }
  return refs.every((n) => svcNames.has(n));
}

export const CHECKS: Record<ConsistencyCheck, (docs: Doc[]) => boolean> = {
  selector_label_match: selectorLabelMatch,
  service_target_port_match: serviceTargetPortMatch,
  ingress_service_match: ingressServiceMatch,
};

export function buildGenerationCaseResult(
  evalCase: GenerationEvalCase,
  result: GenerateResult,
): GenerationCaseResult {
  const validation = result.yaml
    ? validateYamlDocuments(result.yaml)
    : { errors: [], parseFailed: true };
  const validYaml = result.yaml !== null && validation.errors.length === 0;
  const docs = result.yaml ? docsOf(result.yaml) : [];
  const finalKinds = docs
    .map((doc) => doc.kind)
    .filter((kind): kind is string => typeof kind === 'string');
  const kindMatch = evalCase.expectedKinds.every((kind) =>
    finalKinds.includes(kind),
  );
  const requiredPathHits = evalCase.mustHavePaths.filter((path) =>
    docs.some((doc) => hasPath(doc, path.split('.'))),
  );
  const requiredPathCoverage = evalCase.mustHavePaths.length
    ? requiredPathHits.length / evalCase.mustHavePaths.length
    : 1;
  const consistencyResults = (evalCase.consistencyChecks ?? []).map(
    (check) => ({
      check,
      pass: validYaml && CHECKS[check](docs),
    }),
  );
  const consistencyPass =
    consistencyResults.length === 0
      ? null
      : consistencyResults.every((item) => item.pass);

  return {
    id: evalCase.id,
    requirement: evalCase.requirement,
    expectedKinds: evalCase.expectedKinds,
    mustHavePaths: evalCase.mustHavePaths,
    consistencyChecks: evalCase.consistencyChecks ?? [],
    finalYaml: result.yaml,
    attempts: result.attempts,
    attemptSummary: attemptSummary(result),
    diagnostics: result.diagnostics,
    rounds: result.rounds,
    submitCount: result.attempts.length,
    validYaml,
    finalKinds,
    kindMatch: validYaml && kindMatch,
    requiredPathHits,
    requiredPathTotal: evalCase.mustHavePaths.length,
    requiredPathCoverage,
    consistencyResults,
    consistencyPass,
    contentPass:
      validYaml &&
      kindMatch &&
      requiredPathCoverage === 1 &&
      consistencyPass !== false,
    validationErrorSummary: validationErrorSummary(result),
  };
}

export function buildFixCaseResult(
  evalCase: FixEvalCase,
  result: GenerateResult,
): FixCaseResult {
  const validation = result.yaml
    ? validateYamlDocuments(result.yaml)
    : { errors: [], parseFailed: true };
  const validYaml = result.yaml !== null && validation.errors.length === 0;
  const docs = result.yaml ? docsOf(result.yaml) : [];
  const finalKinds = docs
    .map((doc) => doc.kind)
    .filter((kind): kind is string => typeof kind === 'string');
  const kindKept = validYaml && finalKinds.includes(evalCase.expectedKind);
  const preserved = evalCase.mustPreserve.filter((item) =>
    valuePreserved(docs, item.path, item.value),
  );
  const preserveCoverage = evalCase.mustPreserve.length
    ? preserved.length / evalCase.mustPreserve.length
    : 1;
  const intentPreserved =
    validYaml && preserved.length === evalCase.mustPreserve.length;

  return {
    id: evalCase.id,
    defect: evalCase.defect,
    defectType: evalCase.defectType,
    expectedKind: evalCase.expectedKind,
    mustPreserve: evalCase.mustPreserve,
    finalYaml: result.yaml,
    attempts: result.attempts,
    attemptSummary: attemptSummary(result),
    diagnostics: result.diagnostics,
    rounds: result.rounds,
    submitCount: result.attempts.length,
    validYaml,
    finalKinds,
    kindKept,
    preserved,
    preserveTotal: evalCase.mustPreserve.length,
    preserveCoverage,
    intentPreserved,
    validationErrorSummary: validationErrorSummary(result),
  };
}

export function computeGenerationEvalMetrics(
  results: GenerationCaseResult[],
): GenerationEvalMetrics {
  const validResults = results.filter((result) => result.validYaml);
  const consistencyResults = results.filter(
    (result) => result.consistencyPass !== null,
  );
  return {
    caseCount: results.length,
    validYamlCount: validResults.length,
    kindMatchCount: results.filter((result) => result.kindMatch).length,
    requiredPathCoverageAvg: validResults.length
      ? validResults.reduce(
          (sum, result) => sum + result.requiredPathCoverage,
          0,
        ) / validResults.length
      : 0,
    consistencyCaseCount: consistencyResults.length,
    consistencyPassCount: consistencyResults.filter(
      (result) => result.consistencyPass === true,
    ).length,
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
  const validResults = results.filter((result) => result.validYaml);
  const byDefectType = {} as FixEvalMetrics['byDefectType'];
  for (const result of results) {
    const current = byDefectType[result.defectType] ?? { total: 0, fixed: 0 };
    current.total++;
    if (result.validYaml) current.fixed++;
    byDefectType[result.defectType] = current;
  }
  return {
    caseCount: results.length,
    validYamlCount: validResults.length,
    kindKeptCount: results.filter((result) => result.kindKept).length,
    intentPreservedCount: results.filter((result) => result.intentPreserved)
      .length,
    preserveCoverageAvg: validResults.length
      ? validResults.reduce((sum, result) => sum + result.preserveCoverage, 0) /
        validResults.length
      : 0,
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
    'generation.kind_match_rate': metricObservation(
      metrics.validYamlCount
        ? metrics.kindMatchCount / metrics.validYamlCount
        : null,
      metrics.kindMatchCount,
      metrics.validYamlCount,
    ),
    'generation.required_path_coverage': metricObservation(
      metrics.validYamlCount ? metrics.requiredPathCoverageAvg : null,
      metrics.requiredPathCoverageAvg * metrics.validYamlCount,
      metrics.validYamlCount,
    ),
    'generation.consistency_pass_rate': metricObservation(
      metrics.consistencyCaseCount
        ? metrics.consistencyPassCount / metrics.consistencyCaseCount
        : null,
      metrics.consistencyPassCount,
      metrics.consistencyCaseCount,
    ),
    ...attemptMetricsRecord('generation', metrics.attemptStats),
  };
  return record;
}

export function fixMetricsRecord(
  metrics: FixEvalMetrics,
): Record<string, MetricObservation> {
  const record: Record<string, MetricObservation> = {
    'fix.success_rate': metricObservation(
      metrics.caseCount ? metrics.validYamlCount / metrics.caseCount : null,
      metrics.validYamlCount,
      metrics.caseCount,
    ),
    'fix.kind_kept_rate': metricObservation(
      metrics.validYamlCount
        ? metrics.kindKeptCount / metrics.validYamlCount
        : null,
      metrics.kindKeptCount,
      metrics.validYamlCount,
    ),
    'fix.intent_preserved_rate': metricObservation(
      metrics.validYamlCount
        ? metrics.intentPreservedCount / metrics.validYamlCount
        : null,
      metrics.intentPreservedCount,
      metrics.validYamlCount,
    ),
    'fix.preserve_coverage': metricObservation(
      metrics.validYamlCount ? metrics.preserveCoverageAvg : null,
      metrics.preserveCoverageAvg * metrics.validYamlCount,
      metrics.validYamlCount,
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

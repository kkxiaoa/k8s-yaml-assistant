// 生成评估的纯度量函数(无副作用、无网络):路径存在性 + 跨资源一致性检查。
// 独立成模块,便于单测/复用,且 import 不会触发 eval:gen 跑批(runner 的 main 在 generation-eval.ts)。

import { loadAll } from 'js-yaml';
import type { ConsistencyCheck } from './generation-cases';
import type { GenerateResult } from '../server/agent';

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

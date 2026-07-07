// Stage 6:平台 policy 知识源。data/policies.json → policy chunk(复用 Chunk 接口)。
// policy 混进同一 CORPUS 走同一检索;chunk text 末句显式标注,降低模型误当 schema 事实。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chunk } from './schema-corpus';

interface PolicyRule {
  id: string;
  rule: string;
  appliesTo: { resource: string; field?: string };
  severity: 'required' | 'forbidden' | 'recommended' | 'discouraged';
  scope: 'dev' | 'staging' | 'prod' | 'all';
  rationale: string;
  version?: string;
}

function loadPolicies(): PolicyRule[] {
  const raw = readFileSync(join(process.cwd(), 'data', 'policies.json'), 'utf8');
  return JSON.parse(raw) as PolicyRule[];
}

function policyText(p: PolicyRule): string {
  const scope = p.scope === 'all' ? '全部环境' : p.scope;
  return `[平台规范] ${p.rule}。级别:${p.severity}。适用:${scope}。理由:${p.rationale}。(组织策略/平台规范,非 K8s 官方强制)`;
}

/** data/policies.json → policy chunk[]。id=policy.id,resource/path 取 appliesTo 以吃软加权。 */
export function buildPolicyCorpus(): Chunk[] {
  return loadPolicies().map((p) => ({
    id: p.id,
    resource: p.appliesTo.resource,
    path: p.appliesTo.field ?? '',
    title: `平台规范 · ${p.appliesTo.resource} · ${p.appliesTo.field ?? '(资源级)'}`,
    text: policyText(p),
    sourceType: 'policy',
    version: p.version,
    trustLevel: 'org-policy',
  }));
}

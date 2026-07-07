# Stage 6 Policy Source 与冲突表达 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 K8s YAML Copilot 训练场接入第一类非 schema 知识源（policy 平台规范），让 RAG 问答能区分“K8s 官方事实”与“组织策略”，并在冲突时正确分层表达。

**Architecture:** policy 复用 `Chunk` 接口混入同一 `CORPUS`，走同一 `retrieve`（软加权粗召回 → rerank）。分叉只在四处：源头（`policy-corpus`）、检索加权（`POLICY_RELATED_BOOST`）、生成 prompt（冲突表达）、eval（分层）。policy 只进 Ask/解释/faithfulness answer，**不进** schema validation / YAML gen-fix。

**Tech Stack:** TypeScript（严格模式 `noUncheckedIndexedAccess`）、Anthropic SDK → DeepSeek 端点、Voyage embedding/rerank、tsx、node:test。

**Spec:** `docs/superpowers/specs/2026-07-06-stage6-multi-source-design.md`

---

## File Structure

**新建：**
- `data/policies.json` — 10-12 条业界公认真实生产规范（数据）
- `src/knowledge/policy-corpus.ts` — `buildPolicyCorpus(): Chunk[]`
- `src/knowledge/policy-corpus.test.ts` — buildPolicyCorpus 单测
- `src/retrieval/boost.ts` — `policyBoost()` 纯函数（可单测，denseSearch 调用）
- `src/retrieval/boost.test.ts` — policyBoost 单测
- `src/retrieval/sources.test.ts` — formatSources source label 单测

**修改：**
- `src/knowledge/schema-corpus.ts` — `Chunk` 接口扩 sourceType union + `sourceUri`/`version`/`trustLevel`；build 时填 schema 的 sourceUri/trustLevel
- `src/knowledge/corpus.ts` — `CORPUS` 合并 policy
- `src/retrieval/sources.ts` — `SourceInput`/`Source` 扩 union + 元数据 + source label；`extractSourceUri` 保留供构建期用
- `src/retrieval/retrieve.ts` — `denseSearch` 调 `policyBoost`
- `src/retrieval/router.ts` — `POLICY_RELATED_BOOST` 常量 + `RULES` 扩 policy 涉及资源
- `src/server/pipeline.ts` — `Hit.sourceType` union + 去 cast + `ASK_SYSTEM` 冲突规则
- `src/eval/answer.ts` — `ANSWER_SYSTEM` 冲突规则
- `src/eval/eval-set.ts` — 新增 policy 相关 EvalCase（纯 policy + 冲突）
- `src/eval/judge.ts` — `Verdict` 扩 policy detail + `JUDGE_SYSTEM` policy 判定段
- `src/eval/faithfulness-eval.ts` — policy detail 落 trace
- `scripts/build-calibration.ts` — policy 区分 calibration case

---

## Task 1: Chunk 接口扩 sourceType union + 元数据字段

把 `Chunk.sourceType` 从硬编码 `'schema'` 改成 union，并给所有 chunk 加 `sourceUri`/`version`/`trustLevel` 元数据字段（进接口，不靠 text 解析）。这是多源架构地基，policy 接入前先做。

**Files:**
- Modify: `src/knowledge/schema-corpus.ts`
- Modify: `src/retrieval/sources.ts`
- Modify: `src/server/pipeline.ts`

- [ ] **Step 1: 扩 Chunk 接口（schema-corpus.ts:9-16）**

```ts
export type SourceType = 'schema' | 'policy';
export type TrustLevel = 'k8s-official' | 'org-policy';

export interface Chunk {
  id: string;
  resource: string;
  path: string;
  title: string;
  text: string;
  sourceType: SourceType;
  /** 官方文档/规范链接 */
  sourceUri?: string;
  /** 版本/日期 */
  version?: string;
  /** 可信层级:区分官方事实与组织策略 */
  trustLevel?: TrustLevel;
}
```

- [ ] **Step 2: schema chunk 构建期填 sourceUri/trustLevel（schema-corpus.ts:57-64）**

`extractSourceUri` 从 `retrieval/sources.ts` 导入复用（该函数保留）。把 `out.push` 改为：

```ts
    out.push({
      id: `${resource}::${path}`,
      resource,
      path,
      title: `${resource} · ${path}`,
      text: chunkText(resource, path, forText, requiredSet.has(name)),
      sourceType: 'schema',
      sourceUri: extractSourceUri(node.description ?? ''),
      trustLevel: 'k8s-official',
    });
```

文件顶部加 `import { extractSourceUri } from '../retrieval/sources';`。

- [ ] **Step 3: sources.ts 扩 SourceInput/Source（sources.ts:4-20）**

```ts
import type { SourceType } from '../knowledge/schema-corpus';

export interface SourceInput {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  sourceUri?: string;
  trustLevel?: 'k8s-official' | 'org-policy';
}

export interface Source {
  n: number;
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUri?: string;
  trustLevel?: 'k8s-official' | 'org-policy';
}
```

`formatSources` 里 `sources` 映射改为优先用 chunk 上的 `sourceUri`（元数据字段），回退到 text 提取：

```ts
  const sources: Source[] = chunks.map((c, i) => ({
    n: i + 1,
    id: c.id,
    title: c.title,
    sourceType: c.sourceType,
    sourceUri: c.sourceUri ?? extractSourceUri(c.text),
    trustLevel: c.trustLevel,
  }));
```

- [ ] **Step 4: pipeline.ts 去掉硬编码 sourceType（pipeline.ts:46, 215）**

`Hit` 接口 `sourceType: 'schema'` → `sourceType: SourceType`（顶部 import `SourceType`）。`finalHits` 里 `sourceType: chunk.sourceType as 'schema'` → `sourceType: chunk.sourceType`（去掉 cast）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: `✓`（无错误。若 `app/lib/api.ts` 的 `SourceHit.sourceType` union 已含 schema/policy，前端无需改）

- [ ] **Step 6: 冒烟验证 schema chunk 带元数据**

Run: `npx tsx -e "import {CORPUS} from './src/knowledge/corpus'; const c=CORPUS.find(x=>x.id==='Pod::spec.containers.image'); console.log(c.sourceType, c.trustLevel, c.sourceUri)"`
Expected: `schema k8s-official https://kubernetes.io/docs/concepts/containers/images`

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/schema-corpus.ts src/retrieval/sources.ts src/server/pipeline.ts
git commit -m "refactor(stage6): Chunk.sourceType union + sourceUri/trustLevel 元数据字段"
```

---

## Task 2: policies.json + buildPolicyCorpus + CORPUS 合并

新建真实 policy 数据 + 生成 policy chunk + 合并进 CORPUS。TDD：先写 buildPolicyCorpus 单测。

**Files:**
- Create: `data/policies.json`
- Create: `src/knowledge/policy-corpus.ts`
- Create: `src/knowledge/policy-corpus.test.ts`
- Modify: `src/knowledge/corpus.ts`

- [ ] **Step 1: 写 data/policies.json（10 条业界公认真实规范）**

```json
[
  {
    "id": "policy.deployment.resources.limits.required",
    "rule": "生产环境 Deployment 容器必须设置 resources.limits(cpu/memory)",
    "appliesTo": { "resource": "Deployment", "field": "spec.template.spec.containers.resources.limits" },
    "severity": "required",
    "scope": "prod",
    "rationale": "防止单容器耗尽节点资源,保障多租户稳定性",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.deployment.resources.requests.required",
    "rule": "生产环境 Deployment 容器必须设置 resources.requests(cpu/memory)",
    "appliesTo": { "resource": "Deployment", "field": "spec.template.spec.containers.resources.requests" },
    "severity": "required",
    "scope": "prod",
    "rationale": "无 requests 会导致调度器无法合理分配,易引发节点超卖",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.container.image.tag.no-latest",
    "rule": "容器镜像禁止使用 latest tag,必须指定明确版本",
    "appliesTo": { "resource": "Deployment", "field": "spec.template.spec.containers.image" },
    "severity": "forbidden",
    "scope": "all",
    "rationale": "latest 不可复现,回滚与审计困难,易导致节点间版本漂移",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.deployment.probes.liveness.recommended",
    "rule": "生产环境 Deployment 容器建议配置 livenessProbe",
    "appliesTo": { "resource": "Deployment", "field": "spec.template.spec.containers.livenessProbe" },
    "severity": "recommended",
    "scope": "prod",
    "rationale": "存活探针失败时自动重启,提升自愈能力",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.deployment.probes.readiness.recommended",
    "rule": "生产环境 Deployment 容器建议配置 readinessProbe",
    "appliesTo": { "resource": "Deployment", "field": "spec.template.spec.containers.readinessProbe" },
    "severity": "recommended",
    "scope": "prod",
    "rationale": "就绪探针未通过前不接流量,避免把请求打到未启动完成的实例",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.pod.security.privileged.forbidden",
    "rule": "禁止 privileged 特权容器",
    "appliesTo": { "resource": "Pod", "field": "spec.containers.securityContext.privileged" },
    "severity": "forbidden",
    "scope": "all",
    "rationale": "特权容器可访问宿主机所有设备,突破隔离边界",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.pod.security.hostNetwork.forbidden",
    "rule": "禁止使用 hostNetwork",
    "appliesTo": { "resource": "Pod", "field": "spec.hostNetwork" },
    "severity": "forbidden",
    "scope": "all",
    "rationale": "共享宿主机网络命名空间,削弱网络隔离并占用宿主端口",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.pod.security.runAsNonRoot.recommended",
    "rule": "建议容器以非 root 用户运行(runAsNonRoot: true)",
    "appliesTo": { "resource": "Pod", "field": "spec.containers.securityContext.runAsNonRoot" },
    "severity": "recommended",
    "scope": "all",
    "rationale": "降低容器逃逸后的宿主机权限,遵循最小权限原则",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.deployment.replicas.min-two",
    "rule": "生产环境 Deployment 副本数应不少于 2",
    "appliesTo": { "resource": "Deployment", "field": "spec.replicas" },
    "severity": "recommended",
    "scope": "prod",
    "rationale": "单副本在节点故障/滚动更新时会中断服务,无法保证高可用",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  },
  {
    "id": "policy.pod.volume.hostPath.discouraged",
    "rule": "不建议使用 hostPath 卷",
    "appliesTo": { "resource": "Pod", "field": "spec.volumes.hostPath" },
    "severity": "discouraged",
    "scope": "all",
    "rationale": "hostPath 把宿主机路径挂进容器,破坏可移植性并有安全风险",
    "sourceUri": "data/policies.json",
    "version": "2026-07-06"
  }
]
```

- [ ] **Step 2: 写 buildPolicyCorpus 失败测试（policy-corpus.test.ts）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyCorpus } from './policy-corpus';

test('buildPolicyCorpus: 一条 policy 一个 chunk,id/title/元数据稳定', () => {
  const chunks = buildPolicyCorpus();
  assert.ok(chunks.length >= 10, '至少 10 条');

  const c = chunks.find((x) => x.id === 'policy.container.image.tag.no-latest');
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.sourceType, 'policy');
  assert.equal(c.trustLevel, 'org-policy');
  assert.equal(c.resource, 'Deployment');
  assert.equal(c.path, 'spec.template.spec.containers.image');
  assert.equal(c.title, '平台规范 · Deployment · spec.template.spec.containers.image');
  assert.match(c.text, /\[平台规范\]/);
  assert.match(c.text, /latest/);
  assert.match(c.text, /级别:forbidden/);
  assert.match(c.text, /组织策略\/平台规范,非 K8s 官方强制/);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx tsx src/knowledge/policy-corpus.test.ts`
Expected: FAIL（`Cannot find module './policy-corpus'`）

- [ ] **Step 4: 实现 policy-corpus.ts**

```ts
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
  sourceUri?: string;
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
    sourceUri: p.sourceUri,
    version: p.version,
    trustLevel: 'org-policy',
  }));
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx src/knowledge/policy-corpus.test.ts`
Expected: PASS

- [ ] **Step 6: CORPUS 合并（corpus.ts）**

```ts
// 语料知识库:schema 单源(schema-corpus)+ Stage 6 起并入 policy 源(policy-corpus)。
// Chunk 接口统一,下游 retrieve/rerank/校验只认接口,不感知来源差异。

export type { Chunk } from './schema-corpus';
import { buildSchemaCorpus } from './schema-corpus';
import { buildPolicyCorpus } from './policy-corpus';

export const CORPUS = [...buildSchemaCorpus(), ...buildPolicyCorpus()];
```

- [ ] **Step 7: 重建索引（policy chunk 要嵌入进持久化索引）**

Run: `npm run index:build`
Expected: 索引重建，chunk 数比之前多 10（policy）。记录新 corpusHash。

> 注:`data/index` 是持久化索引，CORPUS 变了必须重建，否则检索用的是旧索引（不含 policy）。

- [ ] **Step 8: 冒烟验证 policy chunk 可检索到**

Run: `npx tsx -e "import {config} from 'dotenv'; config({override:true}); import {searchCorpusTraced} from './src/retrieval/retrieve'; (async()=>{const {hits}=await searchCorpusTraced('Deployment 镜像 tag 有什么要求'); console.log(hits.slice(0,5).map(h=>h.chunk.id))})()"`
Expected: 结果里含 `policy.container.image.tag.no-latest`（可能不在 top-1，Task 3 加 boost 后提升）

- [ ] **Step 9: 挂测试 + 全绿 + Commit**

先把 `policy-corpus.test.ts` 追加到 `package.json` 的 `test` 脚本（显式列文件、非自动发现）：

```json
"test": "tsx src/validation/validate.test.ts && tsx src/server/agent.test.ts && tsx src/knowledge/policy-corpus.test.ts",
```

然后：

```bash
npx tsc --noEmit -p tsconfig.json && npm test
git add data/policies.json src/knowledge/policy-corpus.ts src/knowledge/policy-corpus.test.ts src/knowledge/corpus.ts data/index package.json
git commit -m "feat(stage6): policy 知识源 — policies.json + buildPolicyCorpus + CORPUS 合并"
```

---

## Task 3: policy 检索加权（POLICY_RELATED_BOOST + router 扩展）

policy chunk 与 query resource 相关时轻加权，保证进 top-k。抽 `policyBoost` 纯函数便于单测。同时扩 `router.RULES` 认 policy 涉及的资源（否则 `boostResource` 为 null，加权触发不了）。

**Files:**
- Create: `src/retrieval/boost.ts`
- Create: `src/retrieval/boost.test.ts`
- Modify: `src/retrieval/router.ts`
- Modify: `src/retrieval/retrieve.ts`

- [ ] **Step 1: router.ts 加 POLICY_RELATED_BOOST + 扩 RULES**

`ResourceType` union 加 `'Deployment' | 'Pod' | 'Service'`；`RULES` 顶部加（放 storage 规则前，优先级更高的具体词在前）：

```ts
export const POLICY_RELATED_BOOST = 0.04;
```

`ResourceType`：

```ts
export type ResourceType =
  | 'Deployment'
  | 'Pod'
  | 'Service'
  | 'StorageClass'
  | 'PersistentVolume'
  | 'PersistentVolumeClaim'
  | 'VolumeSnapshotClass'
  | 'VolumeAttributesClass';
```

`RULES` 末尾追加（storage 之后，避免抢占）：

```ts
  { resource: 'Deployment', patterns: [/deployment/i, /部署/, /\bdeploy\b/i] },
  { resource: 'Service', patterns: [/\bservice\b/i, /服务/] },
  { resource: 'Pod', patterns: [/\bpod\b/i, /容器组/] },
```

- [ ] **Step 2: 写 policyBoost 失败测试（boost.test.ts）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyBoost } from './boost';
import { POLICY_RELATED_BOOST } from './router';
import type { Chunk } from '../knowledge/schema-corpus';

const policy = (resource: string, path: string): Chunk => ({
  id: 'p', resource, path, title: 't', text: 'x', sourceType: 'policy',
});
const schema = (resource: string, path: string): Chunk => ({
  id: 's', resource, path, title: 't', text: 'x', sourceType: 'schema',
});

test('policy + resource match → 加权(无需 path)', () => {
  assert.equal(policyBoost(policy('Deployment', 'spec.replicas'), 'Deployment', undefined), POLICY_RELATED_BOOST);
});

test('policy + resource match + path match → 叠加增强', () => {
  const b = policyBoost(policy('Deployment', 'spec.replicas'), 'Deployment', 'spec.replicas');
  assert.ok(b > POLICY_RELATED_BOOST, 'path 命中再加');
});

test('policy + resource 不匹配 → 不加(不越资源抢占)', () => {
  assert.equal(policyBoost(policy('Deployment', 'spec.replicas'), 'Service', undefined), 0);
});

test('schema chunk → policyBoost 不作用(返回 0)', () => {
  assert.equal(policyBoost(schema('Deployment', 'spec.replicas'), 'Deployment', undefined), 0);
});

test('无 boostResource → 不加', () => {
  assert.equal(policyBoost(policy('Deployment', 'spec.replicas'), undefined, undefined), 0);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx tsx src/retrieval/boost.test.ts`
Expected: FAIL（`Cannot find module './boost'`）

- [ ] **Step 4: 实现 boost.ts**

```ts
// policy 检索加权:policy chunk 与 query resource 相关时轻加权,保证进 top-k。
// 只在 resource 匹配时加(policy 问题常无 cursorPath);path 命中再叠加增强。
// 不基于 query 文本出现"必须/禁止"就全局抬 policy——否则问字段事实时 policy 抢占 schema。

import type { Chunk } from '../knowledge/schema-corpus';
import { POLICY_RELATED_BOOST } from './router';

const POLICY_PATH_BONUS = 0.03;

export function policyBoost(
  chunk: Chunk,
  boostResource?: string,
  boostPath?: string,
): number {
  if (chunk.sourceType !== 'policy') return 0;
  if (!boostResource || chunk.resource !== boostResource) return 0;
  const pathHit =
    boostPath && chunk.path.toLowerCase().endsWith(boostPath.toLowerCase());
  return POLICY_RELATED_BOOST + (pathHit ? POLICY_PATH_BONUS : 0);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx src/retrieval/boost.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 6: denseSearch 接入 policyBoost（retrieve.ts:56-67）**

顶部加 `import { policyBoost } from './boost';`。`denseSearch` 的 score 计算追加一项：

```ts
      score:
        cosineSimilarity(queryEmbedding, c.embedding) +
        (boostResource && c.resource === boostResource ? RESOURCE_BOOST : 0) +
        (normalizedPath && c.path.toLowerCase().endsWith(normalizedPath)
          ? FIELD_PATH_BOOST
          : 0) +
        policyBoost(c as Chunk, boostResource, boostPath),
```

> 注:schema chunk 走 `policyBoost` 返回 0，行为不变;只有 policy chunk 在 resource 匹配时才加。

- [ ] **Step 7: 挂测试 + 类型检查 + 全部单测**

先把 `boost.test.ts` 追加到 `package.json` 的 `test` 脚本（`&& tsx src/retrieval/boost.test.ts`），然后：
Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: `✓` + 所有测试 PASS

- [ ] **Step 8: 冒烟验证 policy 加权后进 top-3**

Run: `npx tsx -e "import {config} from 'dotenv'; config({override:true}); import {searchCorpusTraced} from './src/retrieval/retrieve'; import {inferResource} from './src/retrieval/router'; (async()=>{const q='Deployment 镜像 tag 有什么要求'; const {hits}=await searchCorpusTraced(q,{boostResource:inferResource(q)??undefined}); console.log(hits.slice(0,3).map(h=>h.chunk.id))})()"`
Expected: top-3 含 `policy.container.image.tag.no-latest`

- [ ] **Step 9: 回归检索 baseline（policy 不能压垮 schema Recall）**

Run: `npm run eval`
Expected: schema case 的 Recall@3 不低于 baseline（91.0%）。若明显下降说明 boost 过强，调小 `POLICY_RELATED_BOOST`。

- [ ] **Step 10: Commit**

```bash
git add src/retrieval/boost.ts src/retrieval/boost.test.ts src/retrieval/router.ts src/retrieval/retrieve.ts
git commit -m "feat(stage6): policy 检索加权 POLICY_RELATED_BOOST + router 认 Deployment/Pod/Service"
```

---

## Task 4: source label + prompt 冲突表达

生成层区分 schema 事实与 policy 建议。source label 让来源类型可见；prompt 加四条冲突规则。

**Files:**
- Create: `src/retrieval/sources.test.ts`
- Modify: `src/retrieval/sources.ts`
- Modify: `src/server/pipeline.ts`
- Modify: `src/eval/answer.ts`

- [ ] **Step 1: 写 source label 失败测试（sources.test.ts）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSources } from './sources';
import type { SourceInput } from './sources';

const policy: SourceInput = { id: 'p1', title: '平台规范 · Deployment · image', text: '[平台规范] 禁止 latest', sourceType: 'policy' };
const schema: SourceInput = { id: 's1', title: 'Deployment · image', text: 'image 是 string', sourceType: 'schema' };

test('formatSources: policy source 带 [组织策略] 标签,schema 带 [K8s schema]', () => {
  const { context } = formatSources([policy, schema]);
  assert.match(context, /\[S1\]\[policy\]\[组织策略\]/);
  assert.match(context, /\[S2\]\[schema\]\[K8s schema\]/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx src/retrieval/sources.test.ts`
Expected: FAIL（context 是旧格式 `[S1] title`，无来源标签）

- [ ] **Step 3: formatSources context 加来源标签（sources.ts）**

```ts
const SOURCE_LABEL: Record<SourceType, string> = {
  schema: 'K8s schema',
  policy: '组织策略',
};

// ...在 formatSources 内:
  const context = chunks
    .map(
      (c, i) =>
        `[S${i + 1}][${c.sourceType}][${SOURCE_LABEL[c.sourceType]}] ${c.title}\n${c.text}`,
    )
    .join('\n\n');
```

顶部 import `SourceType`（已在 Task 1 从 schema-corpus 导入）。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx src/retrieval/sources.test.ts`
Expected: PASS

- [ ] **Step 5: ASK_SYSTEM 加冲突表达四规则（pipeline.ts:23-31）**

在 `ASK_SYSTEM` 规则列表末尾（“简洁准确”之前）插入：

```
- 来源分工:标 [schema][K8s schema] 的是官方事实(字段是否合法/能填什么);标 [policy][组织策略] 的是平台组织规范(推荐/禁止怎么配),不是 K8s 官方强制。
- 冲突表达:当 schema 允许但 policy 禁止/不推荐时,同时说明两层。措辞严谨,例如:"image 字段在 K8s schema 层面允许填字符串,nginx:latest 能通过字段类型校验;但平台 policy 禁止 latest tag。"不要说成"schema 合法"。
- 完整性:问题涉及"能不能/是否允许/推荐吗/生产可用吗",必须同时检查 schema 与 policy 来源;若未检索到 policy 来源,只答 schema 层事实并说明"未检索到组织规范"。
- 红线:不得把 policy 说成 K8s 官方强制;policy 一律标"组织策略/平台规范",强度由级别(required/forbidden/recommended/discouraged)表达。
```

- [ ] **Step 6: ANSWER_SYSTEM 同步加同样四规则（answer.ts:9-13）**

`ANSWER_SYSTEM`（eval 用的被测生成 prompt）在“简洁准确”之前插入与 Step 5 相同的四条，保证 eval == serving 的生成行为一致。

- [ ] **Step 7: 挂测试 + 类型检查 + 单测**

先把 `sources.test.ts` 追加到 `package.json` 的 `test` 脚本（`&& tsx src/retrieval/sources.test.ts`），然后：
Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: `✓` + PASS

- [ ] **Step 8: 冒烟验证冲突表达（真实 pipeline）**

Run: `npx tsx -e "import {config} from 'dotenv'; config({override:true}); import {searchCorpusTraced} from './src/retrieval/retrieve'; import {inferResource} from './src/retrieval/router'; import {formatSources} from './src/retrieval/sources'; import {getClient} from './src/server/pipeline'; import {generateAnswer} from './src/eval/answer'; (async()=>{const q='生产环境我能用 nginx:latest 吗?'; const {hits}=await searchCorpusTraced(q,{boostResource:inferResource(q)??undefined}); const {context}=formatSources(hits.slice(0,3).map(h=>h.chunk)); console.log(await generateAnswer(getClient(),context,q))})()"`
Expected: 答案同时提到 schema 层可填字符串 + policy 禁止 latest，且标注为组织策略（非官方强制）。人工确认措辞。

- [ ] **Step 9: Commit**

```bash
git add src/retrieval/sources.ts src/retrieval/sources.test.ts src/server/pipeline.ts src/eval/answer.ts
git commit -m "feat(stage6): source label + prompt 冲突表达(schema 事实 vs policy 建议)"
```

---

## Task 5: eval-set policy case + 分层 judge 维度 + 校准

eval-set 加 policy case（纯 policy + 冲突）；judge 加 policy detail 字段；建 policy 区分 calibration，按 §7.2 先校准再信。

**Files:**
- Modify: `src/eval/eval-set.ts`
- Modify: `src/eval/judge.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `scripts/build-calibration.ts`

- [x] **Step 1: eval-set 加 policy 相关 EvalCase（eval-set.ts，EVAL_SET 数组末尾）**

```ts
  // ── Stage 6:平台 policy 用例(纯 policy 问询 + schema/policy 冲突)──
  // 已落 9 条 policy-* EvalCase:
  // policy-deploy-limits / policy-pod-privileged / policy-sc-reclaim /
  // policy-secret-plaintext / policy-crb-admin / policy-ingress-tls /
  // policy-conflict-latest / policy-conflict-nodeport / policy-conflict-privileged
```

- [x] **Step 2: 校验 eval-set（chunk id 存在性）**

Run: `npm run eval:check`
Expected: 通过；policy case 的 `expectedChunkIds` 都能在 CORPUS 找到（Task 2 已让 policy chunk id = policy.id）。

- [x] **Step 3: Verdict 扩 policy detail（judge.ts:18-22）**

```ts
export interface Verdict {
  faithful: boolean;
  unsupported: string[];
  reason: string;
  /** 仅当 context 含 policy 来源时有意义;非 policy case 为 undefined */
  policy?: {
    /** 是否区分了 schema 事实与 policy 建议 */
    distinguished: boolean;
    /** 冲突是否同时说明两层(仅冲突类问题) */
    conflictExplained: boolean;
    /** 是否误把 policy 当 K8s 官方强制 */
    misstatedAsOfficial: boolean;
  };
}
```

- [x] **Step 4: JUDGE_SYSTEM 加 policy 判定段 + parseJson 解析 policy（judge.ts）**

`JUDGE_SYSTEM` 输出 JSON 前追加一段：

```
- policy 判定(仅当【文档】含标 [policy] 的片段时):额外判断回答是否 ① 区分了官方事实与组织策略(distinguished)、② 冲突问题是否同时说明 schema 合法性与 policy 限制(conflictExplained)、③ 是否误把 policy 当 K8s 官方强制(misstatedAsOfficial)。文档无 policy 片段时 policy 字段留空。
```

JSON 模板改为：

```
{"faithful": true 或 false, "unsupported": [...], "reason": "...", "policy": {"distinguished": bool, "conflictExplained": bool, "misstatedAsOfficial": bool} 或省略}
```

`parseJson` 里补 policy 解析（保持容错，缺失即 undefined）：

```ts
    const policy =
      o.policy && typeof o.policy === 'object'
        ? {
            distinguished: Boolean((o.policy as Record<string, unknown>).distinguished),
            conflictExplained: Boolean((o.policy as Record<string, unknown>).conflictExplained),
            misstatedAsOfficial: Boolean((o.policy as Record<string, unknown>).misstatedAsOfficial),
          }
        : undefined;
    return {
      faithful: Boolean(o.faithful),
      unsupported: Array.isArray(o.unsupported) ? o.unsupported : [],
      reason: typeof o.reason === 'string' ? o.reason : '',
      ...(policy ? { policy } : {}),
    };
```

- [x] **Step 5: faithfulness-eval.ts 让 policy detail 落 trace（faithfulness-eval.ts）**

`FaithTrace` 已含 `verdict: Verdict | null`，policy detail 随 verdict 自动落盘（Task 3 的 Verdict 扩展）。无需改结构 —— 确认 `src/eval/faith-store.ts` 的 `FaithTrace.verdict` 类型是 `Verdict | null`（是则本步只需 `npx tsc` 确认通过）。

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: `✓`

- [x] **Step 6: 冒烟 faith(policy case)看 detail 落盘**

Run: `npm run eval:faith -- --policy`（只跑 9 条 policy 用例；跑完看输出）然后：
Run: `npx tsx -e "import {readFileSync,readdirSync} from 'node:fs'; const d='data/eval/faith'; const f=readdirSync(d).filter(x=>x.includes('policy')).sort().pop(); const ls=readFileSync(d+'/'+f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)); console.log(ls.filter(x=>x.id.startsWith('policy')).map(x=>({id:x.id,policy:x.verdict?.policy})))"`
Expected: policy case 的 verdict 带 policy detail（distinguished/conflictExplained/misstatedAsOfficial）。清理冒烟产物。

- [x] **Step 7: 建 policy 区分 calibration case（build-calibration.ts LABELS）**

从 faith 明细取 policy case 的 (context, answer) 快照，**独立人工判定** policy detail（不照抄 judge）。LABELS 加 policy 条目，human 判定填 `distinguished`/`conflictExplained`/`misstatedAsOfficial` 期望值。

> ⚠ §7.2 铁律:policy judge 新维度是**未校准**的。此步只固化 calibration set，下一步 `eval:judge` 测新维度的人机一致率;**未达标(≥80%)前不信 policy detail 数字**，只作定性观察。

- [x] **Step 8: 跑 judge 校准（含 policy 维度）**

Run: `npm run build:calibration && npm run eval:judge`
Expected: faithful 维度一致率维持 ≥80%；policy 维度人机一致率产出（首次可能不达标——记录，后续调 JUDGE_SYSTEM policy 段再校，不阻塞本 plan）。

- [x] **Step 9: 跑检索 eval(policy 召回)**

Run: `npm run eval`
Expected: policy case（policy-image-latest / policy-resource-limits）Recall@3 命中 policy chunk；schema case Recall 不回退。

- [ ] **Step 10: 全绿 + Commit**

  当前已完成 `npx tsc --noEmit -p tsconfig.json`、`npm test`、`npm run build`、`npm run eval:check`、`npm run eval`、`npm run eval:faith -- --policy`、`npm run build:calibration`、`npm run eval:judge`；尚未提交 commit。

```bash
npx tsc --noEmit -p tsconfig.json && npm test
git add src/eval/eval-set.ts src/eval/judge.ts src/eval/faithfulness-eval.ts src/eval/judge-eval.ts scripts/build-calibration.ts data/eval/judge-calibration.jsonl
git commit -m "feat(stage6): policy eval case + judge policy 区分维度 + 校准"
```

---

## 落地后状态

- §8.4 验收：能答字段事实（schema，已有）✓；能区分官方事实与组织建议（policy distinction）✓；冲突正确表达（conflict）✓；行为语义/YAML 示例（doc/example）留后续。
- 多源架构就位：`sourceType` union + 元数据字段 + 检索加权 + source label，后续接 doc/example 同法。
- 边界守住：policy 只在 Ask/解释/faithfulness answer，`validateResource` 不受影响。

## 已知后续（不在本 plan）

- policy judge 维度若校准不达标，迭代 `JUDGE_SYSTEM` policy 段（多数投票已在 eval:judge）。
- doc/example 两类源接入。
- policy 参与 YAML gen/fix 的 compliance（需独立设计 policy lint 层）。

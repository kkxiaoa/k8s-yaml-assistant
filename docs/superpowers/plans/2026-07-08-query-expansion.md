# A3 schema-aware query expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用离线 schema-derived alias index + 在线轻量 query expansion 验证 A3 假设:中文 query 能否通过已审 alias 映射到英文字段术语,救回跨语言 schema-field retrieval miss。

**Architecture:** 第一版只在 A/B 脚本中启用 expansion,不改 `searchCorpusTraced` 默认行为,不接 serving/CLI/Web。alias 范围收敛到显式目标字段 seed,不从 `bad-cases.jsonl` 动态推导,不对 Pod/Deployment 全字段建 alias。线上和 A/B 都只使用 `reviewed: true` alias。

**Tech Stack:** TypeScript(严格模式)、DeepSeek/Anthropic SDK 离线生成 alias、Voyage embedding/rerank、tsx、自定义 `check()` 测试 runner。

**Spec:** `docs/superpowers/specs/2026-07-08-query-expansion-design.md`

**Baseline:** A1 不采纳 k=5;A2 不升级 voyage-4。默认保持 `CONTEXT_K=3` + `voyage-3` + `data/index`。

---

## File Structure

**新建:**
- `data/aliases/schema-field-alias-targets.json` — 第一版目标字段显式 seed。
- `data/aliases/schema-field-aliases.jsonl` — LLM 离线生成 + 人工 review 后的 alias。
- `scripts/generate-schema-aliases.ts` — 从目标字段 seed + 真实 schema chunk 生成 alias 草稿。
- `scripts/check-schema-aliases.ts` — 校验 target/alias 可追溯、chunk 存在、reviewed 约束。
- `src/retrieval/query-expansion.ts` — alias loader + `expandQueryWithAliases()` 纯函数。
- `src/retrieval/query-expansion.test.ts` — expansion 单测。
- `scripts/query-expansion-ab.ts` — 同一次运行对比 no-expansion vs alias-expansion。

**修改:**
- `package.json` — 增加 `aliases:generate`、`aliases:check`、`aliases:ab`,并挂 `query-expansion.test.ts`。

---

## Task 1: 显式目标字段 seed + 校验脚本

第一版范围必须固定在目标字段集合,不能从 bad-cases 动态推导,也不能把 Pod/Deployment 全字段纳入。

**Files:**
- Create: `data/aliases/schema-field-alias-targets.json`
- Create: `scripts/check-schema-aliases.ts`
- Modify: `package.json`

- [ ] **Step 1: 新建目标字段 seed**

`data/aliases/schema-field-alias-targets.json` 内容使用显式数组。`metric=true` 参与 A3 schema alias 成败指标;`metric=false` 只观察,不计成功率。

```json
[
  {
    "id": "pod-volumes",
    "resource": "Pod",
    "path": "spec.volumes",
    "chunkId": "Pod::spec.volumes",
    "evalCaseIds": ["pod-volumes"],
    "metric": true
  },
  {
    "id": "deploy-container-image",
    "resource": "Deployment",
    "path": "spec.template.spec.containers.image",
    "chunkId": "Deployment::spec.template.spec.containers.image",
    "evalCaseIds": ["deploy-container-image", "policy-conflict-latest"],
    "metric": true
  },
  {
    "id": "sts-volumeclaimtemplates",
    "resource": "StatefulSet",
    "path": "spec.volumeClaimTemplates",
    "chunkId": "StatefulSet::spec.volumeClaimTemplates",
    "evalCaseIds": ["sts-volumeclaimtemplates"],
    "metric": true
  },
  {
    "id": "rolebinding-subjects",
    "resource": "RoleBinding",
    "path": "subjects",
    "chunkId": "RoleBinding::subjects",
    "evalCaseIds": ["rolebinding-subjects"],
    "metric": true
  },
  {
    "id": "endpoints-subsets-addresses",
    "resource": "Endpoints",
    "path": "subsets.addresses",
    "chunkId": "Endpoints::subsets.addresses",
    "evalCaseIds": ["endpoints-subsets"],
    "metric": true
  },
  {
    "id": "endpoints-subsets-ports",
    "resource": "Endpoints",
    "path": "subsets.ports",
    "chunkId": "Endpoints::subsets.ports",
    "evalCaseIds": ["endpoints-subsets"],
    "metric": true
  },
  {
    "id": "pvc-volumemode",
    "resource": "PersistentVolumeClaim",
    "path": "spec.volumeMode",
    "chunkId": "PersistentVolumeClaim::spec.volumeMode",
    "evalCaseIds": ["pvc-volumemode"],
    "metric": true
  },
  {
    "id": "pvc-resources-requests",
    "resource": "PersistentVolumeClaim",
    "path": "spec.resources.requests",
    "chunkId": "PersistentVolumeClaim::spec.resources.requests",
    "evalCaseIds": ["pvc-resources"],
    "metric": true
  },
  {
    "id": "sc-volumebindingmode",
    "resource": "StorageClass",
    "path": "volumeBindingMode",
    "chunkId": "StorageClass::volumeBindingMode",
    "evalCaseIds": ["sc-volumebindingmode"],
    "metric": true
  },
  {
    "id": "sc-allowexpansion",
    "resource": "StorageClass",
    "path": "allowVolumeExpansion",
    "chunkId": "StorageClass::allowVolumeExpansion",
    "evalCaseIds": ["sc-allowexpansion"],
    "metric": true
  },
  {
    "id": "pod-privileged-observation",
    "resource": "Pod",
    "path": "spec.containers.securityContext.privileged",
    "chunkId": "Pod::spec.containers.securityContext.privileged",
    "evalCaseIds": ["policy-conflict-privileged"],
    "metric": false,
    "note": "policy-conflict-privileged 的真正 miss 是 policy chunk,本条仅观察 schema 侧 expansion,不计入 A3 schema alias 成功率"
  }
]
```

- [ ] **Step 2: 实现 aliases 校验脚本**

`scripts/check-schema-aliases.ts` 校验:
- 每个 target 的 `chunkId` 在 `CORPUS` 中存在。
- target chunk 必须是 `sourceType === 'schema'`。
- target 的 `resource/path` 必须与 chunk 一致。
- `evalCaseIds` 必须存在于 `EVAL_SET`。
- 若 `data/aliases/schema-field-aliases.jsonl` 已存在,每条 alias 的 `chunkId/resource/path` 必须与 target 对齐。
- A/B 可用 alias 必须 `reviewed === true`;脚本输出 reviewed/unreviewed 数量,但不自动修改。

- [ ] **Step 3: 挂 npm script**

`package.json` scripts 增加:

```json
"aliases:check": "tsx scripts/check-schema-aliases.ts"
```

- [ ] **Step 4: 验证**

Run: `npm run aliases:check`

Expected: target seed 全部通过;若 alias 文件未生成,输出 `aliases: 0 reviewed / 0 unreviewed` 或明确提示 alias 文件未存在。

- [ ] **Step 5: Task 1 review**

停止,给用户 review target seed。未确认前不进入 Task 2。

---

## Task 2: 离线 alias 生成 + 人工审计闭环

LLM 只生成草稿,不能直接进入 A/B。第一版所有 alias 必须人工审计后 `reviewed: true` 才可使用。

**Files:**
- Create: `scripts/generate-schema-aliases.ts`
- Create/Modify: `data/aliases/schema-field-aliases.jsonl`

- [ ] **Step 1: 实现 alias 生成脚本**

`scripts/generate-schema-aliases.ts`:
- 读取 `schema-field-alias-targets.json`。
- 从 `CORPUS` 取对应 chunk text/path/resource。
- 调用现有 LLM client 生成 `fieldTerms` 和 `zhAliases`。
- 输出 JSONL 到 `data/aliases/schema-field-aliases.jsonl`。
- 每条必须带:

```ts
interface SchemaFieldAlias {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  fieldTerms: string[];
  zhAliases: string[];
  source: 'llm_offline';
  reviewed: false;
  reviewedAt: null;
  reviewNote: '';
}
```

LLM system 要求:
- 只根据给定 `resource/path/chunk text` 生成中文别名。
- 不允许加入字段不存在的行为解释。
- `fieldTerms` 只能来自 path、description、enum/type 中的英文术语。
- `zhAliases` 是中文用户可能问法,但必须能追溯到字段语义。
- 输出严格 JSON。

- [ ] **Step 2: 挂 npm script**

`package.json` scripts 增加:

```json
"aliases:generate": "tsx scripts/generate-schema-aliases.ts"
```

- [ ] **Step 3: 生成 alias 草稿**

Run: `npm run aliases:generate`

Expected:
- 生成 `data/aliases/schema-field-aliases.jsonl`。
- 所有记录 `reviewed:false`。
- 不自动把任何记录置为 reviewed。

- [ ] **Step 4: 校验草稿**

Run: `npm run aliases:check`

Expected: chunk 可追溯、字段对齐、alias 文件格式合法。

- [ ] **Step 5: 人工审计**

停止,把 alias 草稿给用户 review。审计规则:
- 可以删改不准确 `zhAliases`。
- 可以删改不准确 `fieldTerms`。
- 不可新增没有 schema 字段来源的 alias。
- 审计通过的记录置 `reviewed:true`、填 `reviewedAt`、必要时填 `reviewNote`。
- 未审记录保留 `reviewed:false`,不会进入 A/B。

- [ ] **Step 6: 审计后复验**

Run: `npm run aliases:check`

Expected: reviewed alias 数量 = 第一版要参与 A/B 的 alias 数量;无格式/追溯错误。

---

## Task 3: Query expansion 纯函数 + 单测

实现 reviewed alias 的本地匹配与 query 扩展。这里只做纯函数,不接 serving。

**Files:**
- Create: `src/retrieval/query-expansion.ts`
- Create: `src/retrieval/query-expansion.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 实现 `query-expansion.ts`**

导出:

```ts
export interface MatchedAlias {
  chunkId: string;
  resource: string;
  path: string;
  zhAlias: string;
}

export interface QueryExpansionResult {
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
}

export function loadReviewedAliases(path?: string): SchemaFieldAlias[];

export function expandQueryWithAliases(
  queryText: string,
  routedResource: string | undefined,
  aliases: SchemaFieldAlias[],
  options?: { maxFields?: number; maxTermsPerField?: number },
): QueryExpansionResult;
```

规则:
- `routedResource` 为空 → 不扩展。
- 只匹配 `reviewed:true`。
- 只匹配同 resource。
- `zhAliases` 子串命中 query。
- 最多 3 个字段、每字段最多 5 个 terms。
- expansion terms = `fieldTerms + path`,去重后追加到 query 末尾。

- [ ] **Step 2: 写单测**

`query-expansion.test.ts` 覆盖:
- 未 reviewed alias 不参与。
- resource 不匹配不参与。
- query 命中中文 alias 后追加 field terms + path。
- topN 限制生效。
- 无命中时 `expandedQueryText === originalQueryText`。
- diagnostic 字段包含 `matchedAliases` / `expansionTerms`。

- [ ] **Step 3: 挂测试**

把 `query-expansion.test.ts` 追加到 `package.json` 的 `test` 脚本。

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit -p tsconfig.json && npm test`

Expected: 全绿。

- [ ] **Step 5: Task 3 review**

停止,给用户 review expansion 纯函数和测试。未确认前不进入 Task 4。

---

## Task 4: Targeted A/B 脚本(no-expansion vs alias-expansion)

同一次运行对比同一批 case 的 no-expansion vs alias-expansion,避免跨 run 噪音。脚本只读 reviewed alias,不写 bad-cases,不改 baseline。

**Files:**
- Create: `scripts/query-expansion-ab.ts`
- Modify: `package.json`

- [ ] **Step 1: 实现 A/B 脚本**

`scripts/query-expansion-ab.ts`:
- 读取 `schema-field-alias-targets.json`。
- 根据 `evalCaseIds` 从 `EVAL_SET` 取显式 case。
- 对每个 case 跑两次:
  - no-expansion: 原 question。
  - alias-expansion: `expandQueryWithAliases(question, inferResource(question), reviewedAliases)` 后的 query。
- 两边都调用 `searchCorpusTraced()`。
- 输出每条 case:
  - `evalCaseId`
  - `metric` true/false
  - expected ids
  - no-exp top3/top5 + recall@3/reciprocalRank
  - expansion top3/top5 + recall@3/reciprocalRank
  - `expandedQueryText`
  - `matchedAliases[]`
  - `expansionTerms[]`
- 汇总只统计 `metric:true` 的 schema-field miss;`metric:false` 观察项单独打印。

- [ ] **Step 2: 挂 npm script**

`package.json` scripts 增加:

```json
"aliases:ab": "tsx scripts/query-expansion-ab.ts"
```

- [ ] **Step 3: 跑 targeted A/B**

Run: `npm run aliases:ab`

Expected:
- 打印 no-expansion vs alias-expansion case-level 对比。
- 输出哪些 schema-field miss 转 hit,哪些回退。
- 输出 `matchedAliases` 和 `expansionTerms`,可解释每个变化。
- 不修改 `data/eval/bad-cases.jsonl`。

- [ ] **Step 4: 结果 review**

停止,给用户 review targeted A/B 结果。若无收益,记录 A3 假设不成立,不进入 Task 5。

---

## Task 5: 条件触发全量 eval(A/B 内部启用 expansion)

只有 Task 4 targeted 有明确收益时才执行。仍不改 serving 默认。

**Files:**
- Modify: `scripts/query-expansion-ab.ts` 或 Create: `scripts/query-expansion-eval.ts`

- [ ] **Step 1: 增加 `--all` 模式**

推荐直接扩展 `scripts/query-expansion-ab.ts --all`:
- 对 `EVAL_SET` 中全部 answerable case 跑 no-expansion vs alias-expansion。
- 只对命中 alias 的 case 扩展;未命中 alias 的 case 应保持原 query。
- 输出全量 Recall@3 / MRR 对比。
- 输出新增回退 case 清单。
- 不写 bad-cases,不 promote baseline。

- [ ] **Step 2: 跑全量 A/B**

Run: `npm run aliases:ab -- --all`

Expected:
- targeted 收益在全量下不被新增回退抵消。
- 若引入回退,打印回退 case 和 matched aliases,便于判断 alias 是否过宽。

- [ ] **Step 3: 决策**

判据:
- 若 targeted schema-field miss 有稳定转 hit,且全量 eval 不引入明显回退 → 可以进入后续计划:扩 curated 常用字段 alias,再考虑接入 serving。
- 若 targeted 无收益或全量引入回退 → A3 第一版不采纳,记录结论,考虑在线 LLM fallback 或搁置。

- [ ] **Step 4: Task 5 review**

停止,给用户 review 全量 A/B 和采纳/不采纳建议。

---

## Task 6: Commit

只有用户 review 确认后提交。不要把未审 alias 或临时 run 产物混进 commit。

- [ ] **Step 1: 最终检查**

Run:

```bash
npm run aliases:check
npx tsc --noEmit -p tsconfig.json
npm test
git status --short
```

检查:
- `data/aliases/schema-field-aliases.jsonl` 中用于 A/B 的 alias 必须 `reviewed:true`。
- 不提交 `data/eval/runs/`、`data/eval/faith/`、`data/eval/traces.jsonl`、`data/index-ab/`。

- [ ] **Step 2: Commit**

给用户 review 后:

```bash
git add data/aliases/schema-field-alias-targets.json data/aliases/schema-field-aliases.jsonl \
  scripts/generate-schema-aliases.ts scripts/check-schema-aliases.ts scripts/query-expansion-ab.ts \
  src/retrieval/query-expansion.ts src/retrieval/query-expansion.test.ts package.json
git commit -m "feat(debt-a): schema-aware query expansion alias ab"
```

---

## 落地后状态

- A3 第一版目标字段范围固定、可审计。
- alias 只从真实 schema chunk 派生,生成后人工审计,未审不进 A/B。
- expansion 不接默认 serving,只在 A/B 中验证。
- targeted / full eval 都能解释每个变化来自哪个 alias 和 expansion terms。

## 非本计划

- 扩 curated 资源常用字段 alias。
- 在线 LLM 选字段 fallback。
- 将 expansion 接入 serving / CLI / Web。

# Schema Alias Registry Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 11 条 schema alias 从单一 `zhAliases` 迁移为 `weakZhAliases/strongZhAliases`,并实现正式启用规则,确保 A3 收益保持且弱 alias 不再跨 resource 误扩展。

**Architecture:** 本轮只改 alias registry 结构、query expansion 纯函数、校验/生成脚本和 A/B 诊断脚本。`searchCorpusTraced`、serving、CLI、Web 默认行为不变;正式 serving 接入和新 alias 批次扩展留给后续轮。

**Tech Stack:** TypeScript strict、tsx、JSON/JSONL、本地 `node:assert` 测试、现有 `searchCorpusTraced`/`EVAL_SET`/alias A/B 脚本。

---

## File Structure

**Modify:**
- `src/retrieval/query-expansion.ts` — alias 类型升级,实现 weak/strong 三分支启用规则,输出 resource 选择诊断。
- `src/retrieval/query-expansion.test.ts` — 用 TDD 锁定 weak/strong 行为,特别是 wrong-resource weak 完全不扩展。
- `data/aliases/schema-field-aliases.jsonl` — 现有 11 条 alias 迁移为 `weakZhAliases/strongZhAliases`。
- `data/aliases/schema-field-alias-targets.json` — 为现有 target 补 `source` 和 `priority`。
- `scripts/check-schema-aliases.ts` — 校验 target source/priority 与 alias weak/strong 结构。
- `scripts/generate-schema-aliases.ts` — 离线生成草稿输出 weak/strong 结构,保持 `reviewed:false`。
- `scripts/query-expansion-ab.ts` — 使用 expansion 返回的 `aliasSelectedResource/resourceSelectionReason`,并在输出中展示规则归因。

**Not touched in this round:**
- `src/retrieval/retrieve.ts`
- `src/server/*`
- `app/*`
- `src/eval/retrieve-eval.ts`
- `data/eval/*`

---

## Task 1: Query Expansion 正式规则(TDD)

**Files:**
- Modify: `src/retrieval/query-expansion.test.ts`
- Modify: `src/retrieval/query-expansion.ts`

- [ ] **Step 1: 写 failing tests 覆盖 weak/strong 规则**

在 `src/retrieval/query-expansion.test.ts` 中将 fixture alias helper 改成新结构:

```ts
function alias(
  partial: Partial<SchemaFieldAlias> & Pick<SchemaFieldAlias, 'id'>,
): SchemaFieldAlias {
  return {
    resource: 'Deployment',
    path: 'spec.template.spec.containers.image',
    chunkId: 'Deployment::spec.template.spec.containers.image',
    fieldTerms: ['image', 'container image'],
    weakZhAliases: ['镜像', '容器镜像'],
    strongZhAliases: [],
    source: 'llm_offline',
    reviewed: true,
    reviewedAt: '2026-07-08',
    reviewNote: '',
    ...partial,
  };
}
```

新增测试:

```ts
check('same resource: weak alias 允许 expansion 但不改变 resource', () => {
  const result = expandQueryWithAliases('Deployment 容器镜像怎么写', 'Deployment', [
    alias({ id: 'image' }),
  ]);

  assert.equal(result.aliasSelectedResource, 'Deployment');
  assert.equal(result.resourceSelectionReason, 'same_resource');
  assert.deepEqual(result.expansionTerms, [
    'image',
    'container image',
    'spec.template.spec.containers.image',
  ]);
});

check('no route: strong alias 可选择 resource', () => {
  const result = expandQueryWithAliases(
    '怎么把卷设成裸块设备?',
    undefined,
    [
      alias({
        id: 'volume-mode',
        resource: 'PersistentVolumeClaim',
        path: 'spec.volumeMode',
        chunkId: 'PersistentVolumeClaim::spec.volumeMode',
        fieldTerms: ['volumeMode', 'Block'],
        weakZhAliases: ['卷模式'],
        strongZhAliases: ['裸块设备'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.equal(result.aliasSelectedResource, 'PersistentVolumeClaim');
  assert.equal(result.resourceSelectionReason, 'no_route_strong_alias');
  assert.deepEqual(result.matchedAliases.map((a) => a.strength), ['strong']);
});

check('wrong resource: strong alias 可覆盖 resource', () => {
  const result = expandQueryWithAliases(
    '怎么让卷延迟到 Pod 调度后再绑定?',
    'Pod',
    [
      alias({
        id: 'binding-mode',
        resource: 'StorageClass',
        path: 'volumeBindingMode',
        chunkId: 'StorageClass::volumeBindingMode',
        fieldTerms: ['volumeBindingMode', 'WaitForFirstConsumer'],
        weakZhAliases: ['延迟绑定'],
        strongZhAliases: ['延迟到 Pod 调度后再绑定'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.equal(result.aliasSelectedResource, 'StorageClass');
  assert.equal(result.resourceSelectionReason, 'cross_resource_strong_alias');
  assert.deepEqual(result.expansionTerms, [
    'volumeBindingMode',
    'WaitForFirstConsumer',
  ]);
});

check('wrong resource: weak alias 完全不扩展', () => {
  const result = expandQueryWithAliases(
    'Pod 容器怎么暴露端口号?',
    'Pod',
    [
      alias({
        id: 'endpoint-ports',
        resource: 'Endpoints',
        path: 'subsets.ports',
        chunkId: 'Endpoints::subsets.ports',
        fieldTerms: ['ports', 'subsets.ports'],
        weakZhAliases: ['端口号'],
        strongZhAliases: ['后端地址和端口'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.equal(result.aliasSelectedResource, 'Pod');
  assert.equal(result.resourceSelectionReason, 'no_alias_match');
  assert.deepEqual(result.matchedAliases, []);
  assert.deepEqual(result.expansionTerms, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx tsx src/retrieval/query-expansion.test.ts
```

Expected: fail because `SchemaFieldAlias` still uses `zhAliases`, `MatchedAlias.strength` does not exist, and `QueryExpansionResult.aliasSelectedResource/resourceSelectionReason` does not exist.

- [ ] **Step 3: 修改类型定义**

在 `src/retrieval/query-expansion.ts` 中将接口改成:

```ts
export type AliasStrength = 'weak' | 'strong';

export type ResourceSelectionReason =
  | 'same_resource'
  | 'no_route_strong_alias'
  | 'cross_resource_strong_alias'
  | 'weak_alias_no_resource_override'
  | 'no_alias_match';

export interface SchemaFieldAlias {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  fieldTerms: string[];
  weakZhAliases: string[];
  strongZhAliases: string[];
  source: 'llm_offline';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewNote: string;
}

export interface MatchedAlias {
  chunkId: string;
  resource: string;
  path: string;
  zhAlias: string;
  strength: AliasStrength;
}

export interface QueryExpansionResult {
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
  aliasSelectedResource: string | undefined;
  resourceSelectionReason: ResourceSelectionReason;
}
```

- [ ] **Step 4: 实现 weak/strong 匹配函数**

在 `src/retrieval/query-expansion.ts` 中新增 helper:

```ts
function bestAliasMatch(
  queryText: string,
  alias: SchemaFieldAlias,
): { zhAlias: string; strength: AliasStrength } | null {
  const strong = alias.strongZhAliases
    .filter((candidate) => queryText.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (strong) return { zhAlias: strong, strength: 'strong' };

  const weak = alias.weakZhAliases
    .filter((candidate) => queryText.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (weak) return { zhAlias: weak, strength: 'weak' };

  return null;
}
```

- [ ] **Step 5: 实现 resource 选择规则**

在 `expandQueryWithAliases` 中用以下逻辑替换现有 `alias.resource === routedResource` 过滤:

```ts
const matched = aliases
  .filter((alias) => alias.reviewed)
  .map((alias) => {
    const match = bestAliasMatch(queryText, alias);
    if (!match) return null;

    if (alias.resource === routedResource) {
      return { alias, ...match, reason: 'same_resource' as const, usable: true };
    }

    if (!routedResource && match.strength === 'strong') {
      return { alias, ...match, reason: 'no_route_strong_alias' as const, usable: true };
    }

    if (!routedResource && match.strength === 'weak') {
      return {
        alias,
        ...match,
        reason: 'weak_alias_no_resource_override' as const,
        usable: true,
        canSelectResource: false,
      };
    }

    if (routedResource && alias.resource !== routedResource && match.strength === 'strong') {
      return {
        alias,
        ...match,
        reason: 'cross_resource_strong_alias' as const,
        usable: true,
      };
    }

    return null;
  })
  .filter(
    (
      hit,
    ): hit is {
      alias: SchemaFieldAlias;
      zhAlias: string;
      strength: AliasStrength;
      reason: ResourceSelectionReason;
      usable: true;
      canSelectResource?: boolean;
    } => hit !== null,
  )
  .slice(0, maxFields);
```

然后设置返回字段:

```ts
const aliasSelectedResource =
  matched.find((hit) => hit.canSelectResource !== false)?.alias.resource ?? routedResource;
const resourceSelectionReason = matched[0]?.reason ?? 'no_alias_match';
```

- [ ] **Step 6: 修正 no route 返回值**

`routed-only` 且没有 routed resource 时必须返回:

```ts
return {
  originalQueryText,
  expandedQueryText: originalQueryText,
  matchedAliases: [],
  expansionTerms: [],
  aliasSelectedResource: undefined,
  resourceSelectionReason: 'no_alias_match',
};
```

- [ ] **Step 7: 跑测试确认通过**

Run:

```bash
npx tsx src/retrieval/query-expansion.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected: query expansion tests pass, TypeScript pass.

---

## Task 2: Alias/Target 数据结构迁移与校验

**Files:**
- Modify: `data/aliases/schema-field-aliases.jsonl`
- Modify: `data/aliases/schema-field-alias-targets.json`
- Modify: `scripts/check-schema-aliases.ts`
- Modify: `scripts/generate-schema-aliases.ts`

- [ ] **Step 1: 迁移 target source/priority**

在 `data/aliases/schema-field-alias-targets.json` 每条记录补:

```json
"source": "retrieval_eval_miss",
"priority": "high"
```

例外:

```json
{
  "id": "deploy-container-image",
  "source": "curated_common_field",
  "priority": "high"
}
```

`pod-privileged-observation` 保持 `metric:false`,补:

```json
"source": "retrieval_eval_miss",
"priority": "low"
```

- [ ] **Step 2: 迁移 alias JSONL**

将每条 alias 的 `zhAliases` 替换为 `weakZhAliases/strongZhAliases`。使用以下分类:

```text
pod-volumes:
  weak: ["卷列表","volumes字段","Pod卷定义"]
  strong: ["可挂载卷列表","挂载卷来源","卷来源"]

deploy-container-image:
  weak: ["镜像名称","容器镜像","容器镜像名","image字段"]
  strong: []

sts-volumeclaimtemplates:
  weak: ["volumeClaimTemplates字段"]
  strong: ["卷声明模板","持久卷声明模板","PVC模板","StatefulSet卷声明模板","独立存储","每个副本申请独立存储"]

rolebinding-subjects:
  weak: ["主体","subjects字段","角色适用的对象","角色绑定的目标对象","引用对象列表"]
  strong: ["被授权的用户","被授权的用户或 SA","用户或 SA"]

endpoints-subsets-addresses:
  weak: ["子集地址","就绪IP地址","可用端点地址","负载均衡器可用地址"]
  strong: ["后端地址","后端地址和端口"]

endpoints-subsets-ports:
  weak: ["端口号","端口列表","子集端口","可用端口号"]
  strong: ["后端端口","后端地址和端口"]

pvc-volumemode:
  weak: ["卷模式","卷类型","存储模式","块设备","文件系统卷"]
  strong: ["裸块设备"]

pvc-resources-requests:
  weak: ["资源请求","资源请求规格","请求的资源量","最小资源请求"]
  strong: ["存储大小","申请存储大小"]

sc-volumebindingmode:
  weak: ["卷绑定模式","PVC绑定模式","立即绑定","等待第一个消费者","延迟绑定"]
  strong: ["Pod 调度后再绑定","延迟到 Pod 调度后再绑定"]

sc-allowexpansion:
  weak: ["允许卷扩展","是否允许卷扩展","卷扩展支持","卷扩容","卷大小扩展"]
  strong: ["PVC 扩容","允许 PVC 扩容"]

pod-privileged-observation:
  weak: ["特权模式","特权容器","privileged字段","安全上下文中的privileged","容器特权设置","启用特权"]
  strong: []
```

- [ ] **Step 3: 更新 `check-schema-aliases.ts` 类型**

将 `AliasTarget` 增加:

```ts
type AliasTargetSource =
  | 'retrieval_bad_case'
  | 'retrieval_eval_miss'
  | 'curated_common_field'
  | 'product_workflow_field';

type AliasPriority = 'high' | 'medium' | 'low';

interface AliasTarget {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  evalCaseIds: string[];
  metric: boolean;
  source: AliasTargetSource;
  priority: AliasPriority;
  note?: string;
}
```

将 `SchemaFieldAlias` 中的 `zhAliases` 替换为:

```ts
weakZhAliases: string[];
strongZhAliases: string[];
```

- [ ] **Step 4: 增加 target 枚举校验**

在 `readTargets()` 中增加:

```ts
const TARGET_SOURCES = new Set<AliasTargetSource>([
  'retrieval_bad_case',
  'retrieval_eval_miss',
  'curated_common_field',
  'product_workflow_field',
]);
const PRIORITIES = new Set<AliasPriority>(['high', 'medium', 'low']);

if (!row.source || !TARGET_SOURCES.has(row.source))
  fail(`target[${i}].source 非法`);
if (!row.priority || !PRIORITIES.has(row.priority))
  fail(`target[${i}].priority 非法`);
```

- [ ] **Step 5: 增加 alias 结构校验**

在 `readAliases()` 中替换旧检查:

```ts
if (!Array.isArray(row.weakZhAliases))
  fail(`alias[${i}].weakZhAliases 必须是数组`);
if (!Array.isArray(row.strongZhAliases))
  fail(`alias[${i}].strongZhAliases 必须是数组`);
if ('zhAliases' in row) fail(`alias[${i}].zhAliases 已废弃,请迁移到 weak/strong`);
if (row.reviewed && row.weakZhAliases.length === 0 && row.strongZhAliases.length === 0)
  fail(`alias[${i}] reviewed=true 但没有任何中文 alias`);
```

- [ ] **Step 6: 更新生成脚本输出结构**

在 `scripts/generate-schema-aliases.ts` 中将模型输出格式改为:

```ts
interface ModelAliasDraft {
  fieldTerms: string[];
  weakZhAliases: string[];
  strongZhAliases: string[];
}
```

将 system prompt 的 JSON 输出格式改为:

```text
{"fieldTerms":["..."],"weakZhAliases":["..."],"strongZhAliases":["..."]}
```

将返回对象改为:

```ts
weakZhAliases: uniq(draft.weakZhAliases),
strongZhAliases: uniq(draft.strongZhAliases),
```

生成脚本仍必须写 `reviewed:false`。

- [ ] **Step 7: 校验数据迁移**

Run:

```bash
npm run aliases:check
npx tsc --noEmit -p tsconfig.json
```

Expected:

```text
targets: 11 ok
aliases: 11 reviewed / 0 unreviewed
```

TypeScript pass.

---

## Task 3: A/B 脚本接入正式诊断字段

**Files:**
- Modify: `scripts/query-expansion-ab.ts`

- [ ] **Step 1: 使用 expansion 返回的 selected resource**

将手写逻辑:

```ts
const aliasSelectedResource = autoExpansion.matchedAliases[0]?.resource ?? autoResource;
```

替换为:

```ts
const aliasSelectedResource = autoExpansion.aliasSelectedResource;
```

- [ ] **Step 2: 诊断输出补 reason**

在 `QueryVariant` 中增加:

```ts
resourceSelectionReason: ResourceSelectionReason;
```

从 `query-expansion.ts` import:

```ts
type ResourceSelectionReason
```

构造 `auto/alias-expansion` 时使用:

```ts
resourceSelectionReason: autoExpansion.resourceSelectionReason,
```

`auto/no-expansion`、`oracle/alias-expansion`、`forced-target-expansion` 分别使用:

```ts
resourceSelectionReason: 'no_alias_match'
```

或对应 expansion 结果的 reason。

- [ ] **Step 3: `diagnosticsOf()` 返回 reason**

将 `diagnosticsOf` 改为:

```ts
function diagnosticsOf(variant: QueryVariant): Omit<QueryVariant, 'label'> {
  return {
    queryText: variant.queryText,
    boostResource: variant.boostResource,
    matchedAliases: variant.matchedAliases,
    expansionTerms: variant.expansionTerms,
    resourceSelectionReason: variant.resourceSelectionReason,
  };
}
```

- [ ] **Step 4: 打印 reason 和 strength**

将 matched 输出改为:

```ts
.map((a) => `${a.resource}::${a.path} <= ${a.zhAlias}(${a.strength})`)
```

在 diagnostic 输出中增加:

```ts
console.log(`  reason: ${diagnostic.resourceSelectionReason}`);
```

- [ ] **Step 5: 跑 targeted A/B**

Run:

```bash
npm run aliases:ab
```

Expected:

```text
auto/alias-expansion R@3=100.0%
lost(auto/alias-expansion R@3 vs base): 无
```

同时输出中能看到 `weak/strong` 和 `resourceSelectionReason`。

---

## Task 4: 本轮迁移验收

**Files:**
- No additional file changes expected.

- [ ] **Step 1: 跑结构校验**

Run:

```bash
npm run aliases:check
```

Expected:

```text
targets: 11 ok
aliases: 11 reviewed / 0 unreviewed
```

- [ ] **Step 2: 跑类型与单测**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
```

Expected: both exit 0.

- [ ] **Step 3: 跑 targeted A/B**

Run:

```bash
npm run aliases:ab
```

Expected:

```text
auto/alias-expansion     R@3=100.0%
lost(auto/alias-expansion R@3 vs base): 无
```

- [ ] **Step 4: 跑 full eval A/B**

Run:

```bash
npm run aliases:ab -- --all
```

Expected:

```text
alias matched cases: 11
alias-expansion: R@3>=98.8%
lost(R@3): 无
```

Special check:

```text
pod-containerport
```

Expected: no Recall regression; MRR should not be worse than the pre-migration A3 result `0.333`, and ideally returns to `1.000` if weak wrong-resource expansion is blocked.

- [ ] **Step 5: Review checkpoint**

Stop and report:

```text
targeted R@3:
full eval R@3 / MRR:
lost(R@3):
mrr changed only:
pod-containerport MRR:
files changed:
```

Do not commit until user review.

---

## Task 5: Commit After Review

**Files:**
- Commit only files changed by Tasks 1-3.

- [ ] **Step 1: Final status check**

Run:

```bash
git status --short
```

Expected changed files:

```text
M data/aliases/schema-field-alias-targets.json
M data/aliases/schema-field-aliases.jsonl
M scripts/check-schema-aliases.ts
M scripts/generate-schema-aliases.ts
M scripts/query-expansion-ab.ts
M src/retrieval/query-expansion.ts
M src/retrieval/query-expansion.test.ts
```

- [ ] **Step 2: Commit only after user approval**

Run after approval:

```bash
git add data/aliases/schema-field-alias-targets.json \
  data/aliases/schema-field-aliases.jsonl \
  scripts/check-schema-aliases.ts \
  scripts/generate-schema-aliases.ts \
  scripts/query-expansion-ab.ts \
  src/retrieval/query-expansion.ts \
  src/retrieval/query-expansion.test.ts
git commit -m "feat(debt-a): migrate schema aliases to weak strong registry"
```

Expected: one commit containing only本轮结构迁移.

---

## Self-Review

- Spec coverage: covers §3本轮 scope, §5 target metadata, §6 alias weak/strong, §7启用规则, §8审计流程兼容生成脚本, §9迁移验收.
- Explicit exclusions: no curated field expansion, no serving, no feature flag, no `searchCorpusTraced` default behavior change.
- TDD coverage: Task 1 requires failing tests before implementation for same-resource weak, no-route strong, cross-resource strong, wrong-resource weak no-expansion.
- Type consistency: `MatchedAlias.strength`, `QueryExpansionResult.aliasSelectedResource`, and `resourceSelectionReason` are defined before A/B script consumes them.
- Placeholder scan: no placeholder markers remain.

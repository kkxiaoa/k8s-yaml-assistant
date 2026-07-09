# Alias-aware Query Expansion Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已通过 full eval A/B 的 schema alias query expansion 接入真实 Ask serving，并让 serving、retrieval eval、faith eval 和 A/B 共用同一个可回退、可追踪、可复现的检索入口。

**Architecture:** 新增 `query-expansion-runtime.ts` 负责 feature flag、alias registry 快照、hash、缓存和 fail-open 决策；`searchCorpusTraced()` 在 embedding/rerank 前调用该模块，不复制 weak/strong 规则。Expansion 接入与 exact/leaf bug 修复分开实施、分开验证；默认 serving 切换到 expansion-on 后，baseline 必须在人工审核后对齐到同一配置。

**Tech Stack:** TypeScript strict、Node.js ESM、`node:assert/strict`、tsx、Next.js Route Handler、现有 Voyage embedding/rerank、JSONL alias registry、现有 eval run/baseline/trace。

---

## 执行约束

- 严格按 Task 顺序执行。
- 每个 Task 完成验证后停止，汇报结果并等待人工 review。
- 未经用户明确指示，不执行 `git commit`。
- 未经 Task 4 的人工指标审核，不执行 `eval:promote`。
- Task 1-4 不修改 exact/leaf 行为；Task 5 才修 exact/leaf，保证归因隔离。
- 不新增 alias，不修改 eval case，不引入 BM25/RRF。

## Baseline 口径

当前仓库 baseline 与当前 full A/B 不是同一把尺子：

- `data/eval/baseline.json`：旧 `evalSetHash=0d4b4a...`，`serving.recall@3=90.97%`、`serving.mrr@3=0.896`。
- 当前 eval set：86 条 / 81 条 answerable，`evalSetHash=6c8a22...`。
- 当前同集 A/B expansion-off：`R@3=89.5%`、`MRR=0.847`。
- 当前同集 A/B expansion-on：`R@3=98.8%`、`MRR=0.926`。

因此：

- Expansion 纯归因只看当前同集 explicit off/on A/B。
- `eval:compare` 对旧 baseline 的 delta 只作跨版本参考。
- 默认 serving 最终为 expansion-on 时，必须由人工审核后 promote expansion-on candidate run。
- 若 candidate 不被接受，则默认 serving 必须退回 expansion-off。

## File Structure

### Create

- `src/retrieval/query-expansion-runtime.ts`：feature flag、strict registry snapshot、hash、进程缓存、fail-open query preparation。
- `src/retrieval/query-expansion-runtime.test.ts`：配置优先级、registry 缺失/损坏、hash、fallback、alias-aware 选择测试。
- `src/retrieval/exact-field.ts`：只做 `resource + full path` 确定性命中，不做 leaf fallback。
- `src/retrieval/exact-field.test.ts`：真实 CORPUS 的 schema/policy exact 命中与叶子歧义测试。

### Modify

- `src/retrieval/query-expansion.ts`：导出默认路径和共享 JSONL parser，供 runtime、检查脚本与现有 loader 共用。
- `scripts/check-schema-aliases.ts`：复用共享 alias parser，只保留 target/eval/CORPUS 关系检查。
- `src/retrieval/trace.ts`：增加 query expansion trace 类型。
- `src/retrieval/retrieve.ts`：在共享 search 内接入 prepared query/effective resource。
- `scripts/query-expansion-ab.ts`：A/B 改为显式调用共享 search 的 on/off 选项。
- `src/eval/run-store.ts`：run 增加 query expansion 配置快照。
- `src/eval/retrieve-eval.ts`：把真实 search trace 的 expansion 配置写入 run。
- `src/server/pipeline.ts`：Task 5 才改 exact/leaf 分流，并补 `skipped_exact` trace。
- `package.json`：把两个新增纯本地测试加入 `npm test`。

---

### Task 1: Query Expansion Runtime、Registry 与 Trace 类型

**Files:**
- Create: `src/retrieval/query-expansion-runtime.ts`
- Create: `src/retrieval/query-expansion-runtime.test.ts`
- Modify: `src/retrieval/query-expansion.ts`
- Modify: `scripts/check-schema-aliases.ts`
- Modify: `src/retrieval/trace.ts`
- Modify: `package.json`

- [ ] **Step 1: 在 `query-expansion.ts` 导出统一 registry 路径和 parser**

把现有私有常量改为：

```ts
export const DEFAULT_ALIASES_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-aliases.jsonl',
);
```

保留现有 `loadReviewedAliases()` 行为，避免破坏 alias 生成/检查脚本。

新增共享 parser，JSON 语法和运行时必须依赖的字段结构都在这里校验：

```ts
function stringArray(
  value: unknown,
  field: string,
  index: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`alias[${index}].${field} 必须是 string[]`);
  }
  return value;
}

export function parseSchemaFieldAliasesJsonl(
  raw: string,
): SchemaFieldAlias[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`alias[${index}] 必须是对象`);
      }
      const row = value as Record<string, unknown>;
      for (const field of ['id', 'resource', 'path', 'chunkId']) {
        if (typeof row[field] !== 'string' || row[field] === '') {
          throw new Error(`alias[${index}].${field} 缺失`);
        }
      }
      if ('zhAliases' in row) {
        throw new Error(
          `alias[${index}].zhAliases 已废弃,请使用 weakZhAliases/strongZhAliases`,
        );
      }
      const fieldTerms = stringArray(
        row.fieldTerms,
        'fieldTerms',
        index,
      );
      const weakZhAliases = stringArray(
        row.weakZhAliases,
        'weakZhAliases',
        index,
      );
      const strongZhAliases = stringArray(
        row.strongZhAliases,
        'strongZhAliases',
        index,
      );
      if (row.source !== 'llm_offline') {
        throw new Error(`alias[${index}].source 必须是 llm_offline`);
      }
      if (typeof row.reviewed !== 'boolean') {
        throw new Error(`alias[${index}].reviewed 必须是 boolean`);
      }
      if (
        row.reviewedAt !== null &&
        typeof row.reviewedAt !== 'string'
      ) {
        throw new Error(
          `alias[${index}].reviewedAt 必须是 string|null`,
        );
      }
      if (typeof row.reviewNote !== 'string') {
        throw new Error(
          `alias[${index}].reviewNote 必须是 string`,
        );
      }
      if (
        row.reviewed &&
        weakZhAliases.length === 0 &&
        strongZhAliases.length === 0
      ) {
        throw new Error(
          `alias[${index}].reviewed=true 时 weak/strong alias 不能同时为空`,
        );
      }
      return {
        id: row.id,
        resource: row.resource,
        path: row.path,
        chunkId: row.chunkId,
        fieldTerms,
        weakZhAliases,
        strongZhAliases,
        source: row.source,
        reviewed: row.reviewed,
        reviewedAt: row.reviewedAt,
        reviewNote: row.reviewNote,
      } as SchemaFieldAlias;
    });
}
```

`loadReviewedAliases()` 改为：

```ts
return parseSchemaFieldAliasesJsonl(readFileSync(path, 'utf8'))
  .filter((alias) => alias.reviewed);
```

- [ ] **Step 2: 先写 runtime 失败测试**

创建 `src/retrieval/query-expansion-runtime.test.ts`，至少包含以下断言：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAliasRegistrySnapshot,
  prepareQueryExpansion,
  resolveQueryExpansionEnabled,
} from './query-expansion-runtime';

assert.equal(resolveQueryExpansionEnabled(undefined, undefined), true);
assert.equal(resolveQueryExpansionEnabled(undefined, 'false'), false);
assert.equal(resolveQueryExpansionEnabled(true, 'false'), true);
assert.equal(resolveQueryExpansionEnabled(false, undefined), false);

const dir = mkdtempSync(join(tmpdir(), 'alias-runtime-'));
try {
  const missing = loadAliasRegistrySnapshot(join(dir, 'missing.jsonl'));
  assert.deepEqual(missing, { ok: false, errorCode: 'aliases_missing' });

  const invalidPath = join(dir, 'invalid.jsonl');
  writeFileSync(invalidPath, '{bad json}\n');
  const invalid = loadAliasRegistrySnapshot(invalidPath);
  assert.deepEqual(invalid, { ok: false, errorCode: 'aliases_invalid' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

再加入一个 reviewed alias fixture，验证：

```ts
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.snapshot.reviewedAliasCount, 1);
  assert.match(valid.snapshot.registryHash, /^[a-f0-9]{64}$/);
}
```

最后验证：

- enabled + valid registry + strong alias 会返回 `status='applied'`。
- `selectedResource` 使用 alias 选中的资源。
- missing/invalid registry 返回原始 query、原始 routed resource、`status='failed'`。
- disabled 不访问 registry，返回 `status='disabled'`。

- [ ] **Step 3: 运行新测试并确认失败**

Run:

```bash
npx tsx src/retrieval/query-expansion-runtime.test.ts
```

Expected: FAIL，提示 `query-expansion-runtime` 模块不存在。

- [ ] **Step 4: 实现 runtime 类型和 strict registry snapshot**

创建 `src/retrieval/query-expansion-runtime.ts`：

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_ALIASES_PATH,
  expandQueryWithAliases,
  parseSchemaFieldAliasesJsonl,
  type MatchedAlias,
  type ResourceSelectionReason,
  type SchemaFieldAlias,
} from './query-expansion';

export type QueryExpansionErrorCode =
  | 'aliases_missing'
  | 'aliases_invalid';

export type QueryExpansionStatus =
  | 'applied'
  | 'no_match'
  | 'disabled'
  | 'skipped_exact'
  | 'failed';

export interface QueryExpansionTrace {
  enabled: boolean;
  status: QueryExpansionStatus;
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
  routedResource?: string;
  selectedResource?: string;
  resourceSelectionReason?: ResourceSelectionReason;
  registryHash?: string;
  reviewedAliasCount?: number;
  errorCode?: QueryExpansionErrorCode;
}

export interface AliasRegistrySnapshot {
  aliases: SchemaFieldAlias[];
  registryHash: string;
  reviewedAliasCount: number;
}

export type AliasRegistryLoadResult =
  | { ok: true; snapshot: AliasRegistrySnapshot }
  | { ok: false; errorCode: QueryExpansionErrorCode };

export interface PreparedQueryExpansion {
  queryText: string;
  boostResource?: string;
  trace: QueryExpansionTrace;
}

export function resolveQueryExpansionEnabled(
  override: boolean | undefined,
  raw = process.env.ENABLE_QUERY_EXPANSION,
): boolean {
  return override ?? raw !== 'false';
}

export function loadAliasRegistrySnapshot(
  path = DEFAULT_ALIASES_PATH,
): AliasRegistryLoadResult {
  if (!existsSync(path)) {
    return { ok: false, errorCode: 'aliases_missing' };
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const aliases = parseSchemaFieldAliasesJsonl(raw)
      .filter((alias) => alias.reviewed);
    return {
      ok: true,
      snapshot: {
        aliases,
        registryHash: createHash('sha256').update(raw).digest('hex'),
        reviewedAliasCount: aliases.length,
      },
    };
  } catch {
    return { ok: false, errorCode: 'aliases_invalid' };
  }
}
```

- [ ] **Step 5: 让 aliases:check 复用共享 parser**

在 `scripts/check-schema-aliases.ts` 导入：

```ts
import {
  DEFAULT_ALIASES_PATH,
  parseSchemaFieldAliasesJsonl,
  type SchemaFieldAlias,
} from '../src/retrieval/query-expansion';
```

删除脚本内重复的 `SchemaFieldAlias` interface、`ALIASES_PATH` 和逐字段 alias parser。`readAliases()` 改为：

```ts
function readAliases(): SchemaFieldAlias[] {
  if (!existsSync(DEFAULT_ALIASES_PATH)) return [];
  return parseSchemaFieldAliasesJsonl(
    readFileSync(DEFAULT_ALIASES_PATH, 'utf8'),
  );
}
```

target、evalCase、CORPUS、重复 id 和 target 对齐检查保持原样。

- [ ] **Step 6: 实现 fail-open preparation 和进程缓存**

继续在同一文件实现：

```ts
let cachedRegistry: AliasRegistryLoadResult | undefined;
let warnedRegistryFailure = false;

export function getCachedAliasRegistry(): AliasRegistryLoadResult {
  cachedRegistry ??= loadAliasRegistrySnapshot();
  if (!cachedRegistry.ok && !warnedRegistryFailure) {
    warnedRegistryFailure = true;
    console.warn(
      `[query-expansion] registry unavailable: ${cachedRegistry.errorCode}; falling back to original query`,
    );
  }
  return cachedRegistry;
}

export function prepareQueryExpansion(
  queryText: string,
  routedResource: string | undefined,
  enabled: boolean,
  registry?: AliasRegistryLoadResult,
): PreparedQueryExpansion {
  const base = {
    enabled,
    originalQueryText: queryText,
    expandedQueryText: queryText,
    matchedAliases: [],
    expansionTerms: [],
    routedResource,
    selectedResource: routedResource,
  } satisfies Omit<
    QueryExpansionTrace,
    'status' | 'resourceSelectionReason' | 'errorCode'
  >;

  if (!enabled) {
    return {
      queryText,
      boostResource: routedResource,
      trace: { ...base, status: 'disabled' },
    };
  }

  if (!registry?.ok) {
    return {
      queryText,
      boostResource: routedResource,
      trace: {
        ...base,
        status: 'failed',
        errorCode: registry?.errorCode ?? 'aliases_invalid',
      },
    };
  }

  try {
    const result = expandQueryWithAliases(
      queryText,
      routedResource,
      registry.snapshot.aliases,
      { resourceStrategy: 'alias-aware' },
    );
    return {
      queryText: result.expandedQueryText,
      boostResource: result.aliasSelectedResource ?? routedResource,
      trace: {
        ...base,
        status:
          result.matchedAliases.length > 0 ? 'applied' : 'no_match',
        expandedQueryText: result.expandedQueryText,
        matchedAliases: result.matchedAliases,
        expansionTerms: result.expansionTerms,
        selectedResource:
          result.aliasSelectedResource ?? routedResource,
        resourceSelectionReason: result.resourceSelectionReason,
        registryHash: registry.snapshot.registryHash,
        reviewedAliasCount: registry.snapshot.reviewedAliasCount,
      },
    };
  } catch {
    return {
      queryText,
      boostResource: routedResource,
      trace: {
        ...base,
        status: 'failed',
        errorCode: 'aliases_invalid',
      },
    };
  }
}
```

- [ ] **Step 7: 扩展 RetrievalTrace**

在 `src/retrieval/trace.ts` 导入并挂载可选字段：

```ts
import type { QueryExpansionTrace } from './query-expansion-runtime';

export interface RetrievalTrace {
  // 保留现有字段
  queryExpansion?: QueryExpansionTrace;
}
```

保持可选，兼容旧 trace、旧 run 和尚未修改的 exact 分支。

- [ ] **Step 8: 把 runtime 测试加入 `npm test`**

在 `package.json` 的 `test` 脚本中，将：

```text
tsx src/retrieval/query-expansion-runtime.test.ts
```

放在现有 `query-expansion.test.ts` 之后。

- [ ] **Step 9: 验证 Task 1**

Run:

```bash
npx tsx src/retrieval/query-expansion-runtime.test.ts
npx tsc --noEmit -p tsconfig.json
npm test
npm run aliases:check
git diff --check
```

Expected:

- runtime 测试通过。
- TypeScript 无错误。
- 全部既有测试通过。
- alias 检查仍输出 `11 reviewed / 0 unreviewed`。
- `git diff --check` 无输出。

- [ ] **Step 10: Review gate**

停止并汇报：

- feature flag 四种优先级结果。
- valid/missing/invalid registry 测试结果。
- fail-open trace 示例。
- 当前 diff 文件。

未经用户明确指示不 commit，不进入 Task 2。

---

### Task 2: Expansion 下沉到共享 Search，并迁移 A/B

**Files:**
- Modify: `src/retrieval/retrieve.ts`
- Modify: `scripts/query-expansion-ab.ts`

- [ ] **Step 1: 先修改 SearchOptions 与 SearchTrace 类型**

在 `src/retrieval/retrieve.ts` 增加：

```ts
import {
  getCachedAliasRegistry,
  prepareQueryExpansion,
  resolveQueryExpansionEnabled,
} from './query-expansion-runtime';

export interface SearchOptions {
  boostResource?: string;
  boostPath?: string;
  coarseN?: number;
  queryExpansion?: boolean;
}

export type SearchTrace = Pick<
  RetrievalTrace,
  | 'queryText'
  | 'queryExpansion'
  | 'coarseHits'
  | 'rerankHits'
  | 'latencyMs'
  | 'cache'
>;
```

- [ ] **Step 2: 在网络调用前准备 search query**

在 `searchCorpusTraced()` 开头替换 options 解构：

```ts
const {
  boostResource,
  boostPath,
  coarseN = COARSE_N,
  queryExpansion,
} = options;
const expansionEnabled =
  resolveQueryExpansionEnabled(queryExpansion);
const prepared = prepareQueryExpansion(
  queryText,
  boostResource,
  expansionEnabled,
  expansionEnabled ? getCachedAliasRegistry() : undefined,
);
const effectiveQueryText = prepared.queryText;
const effectiveBoostResource = prepared.boostResource;
```

随后统一使用：

```ts
embed([effectiveQueryText], 'query');
denseSearch(
  queryEmbedding,
  index,
  coarseN,
  effectiveBoostResource,
  boostPath,
);
rerank(
  effectiveQueryText,
  coarse.map((h) => h.chunk.text),
  coarse.length,
);
```

所有返回 trace 使用：

```ts
{
  queryText: effectiveQueryText,
  queryExpansion: prepared.trace,
  // 其余现有字段
}
```

不要修改 `denseSearch()`、`policyBoost()` 或 `expandQueryWithAliases()`。

- [ ] **Step 3: 静态确认 A/B 仍在 search 外部扩展**

Run:

```bash
rg -n "expandQueryWithAliases|expandedQueryText" scripts/query-expansion-ab.ts
```

Expected: auto/oracle alias variant 仍在 search 外部构造 `expandedQueryText`。不要运行该中间状态，避免双扩展结果污染判断。

- [ ] **Step 4: A/B 改为显式 shared search on/off**

`QueryVariant` 增加：

```ts
queryExpansion: boolean;
```

自动对照 variant 使用原始问题：

```ts
{
  label: 'auto/no-expansion',
  queryText: evalCase.question,
  boostResource: autoResource,
  queryExpansion: false,
  // 诊断默认空值
},
{
  label: 'auto/alias-expansion',
  queryText: evalCase.question,
  boostResource: autoResource,
  queryExpansion: true,
  // 诊断由 search trace 回填
},
{
  label: 'oracle/alias-expansion',
  queryText: evalCase.question,
  boostResource: oracleResource,
  queryExpansion: true,
  // 诊断由 search trace 回填
},
```

`forced-target-expansion` 是 oracle 诊断，不是 serving 行为。它继续手工构造 query，但必须显式：

```ts
queryExpansion: false
```

避免二次扩展。

- [ ] **Step 5: 让 A/B diagnostics 来自 shared trace**

`evaluateVariant()` 改为同时返回 side 与 trace diagnostics：

```ts
async function evaluateVariant(
  variant: QueryVariant,
  expectedChunkIds: string[],
): Promise<{
  side: RetrievalSide;
  diagnostics: Omit<QueryVariant, 'label' | 'queryExpansion'>;
}> {
  const result = await searchCorpusTraced(variant.queryText, {
    boostResource: variant.boostResource,
    queryExpansion: variant.queryExpansion,
  });
  const expansion = result.trace.queryExpansion;
  return {
    side: side(
      result.hits.map((hit) => hit.chunk.id),
      expectedChunkIds,
    ),
    diagnostics: {
      queryText: result.trace.queryText,
      boostResource:
        expansion?.selectedResource ?? variant.boostResource,
      matchedAliases: expansion?.matchedAliases ?? variant.matchedAliases,
      expansionTerms:
        expansion?.expansionTerms ?? variant.expansionTerms,
      resourceSelectionReason:
        expansion?.resourceSelectionReason ??
        variant.resourceSelectionReason,
    },
  };
}
```

`evaluateAllCase()` 同样对原始 question 分别调用：

```ts
const noExpansion = await searchCorpusTraced(evalCase.question, {
  boostResource: autoResource,
  queryExpansion: false,
});
const aliasExpansion = await searchCorpusTraced(evalCase.question, {
  boostResource: autoResource,
  queryExpansion: true,
});
```

full A/B diagnostics 从 `aliasExpansion.trace.queryExpansion` 读取，不再在脚本外部调用 `expandQueryWithAliases()`。

- [ ] **Step 6: 验证 targeted shared-path A/B**

Run:

```bash
npm run aliases:check
npm run aliases:ab
```

Expected:

- aliases check 为 `11 reviewed / 0 unreviewed`。
- auto/no-expansion trace 状态为 `disabled`。
- auto/alias-expansion trace 状态为 `applied` 或 `no_match`。
- 已知 targeted gained case 保持收益。
- 输出的 selected resource/reason 与迁移前一致。

- [ ] **Step 7: 验证类型与全测试**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
git diff --check
```

Expected: 全部通过。

- [ ] **Step 8: Review gate**

停止并汇报 targeted 指标、关键 trace 和是否存在双扩展。未经用户明确指示不 commit，不进入 Task 3。

---

### Task 3: Serving/Eval/Faith 默认接入与 Run 元数据

**Files:**
- Modify: `src/eval/run-store.ts`
- Modify: `src/eval/retrieve-eval.ts`
- Verify only: `src/server/pipeline.ts`
- Verify only: `src/eval/faithfulness-eval.ts`

- [ ] **Step 1: 扩展 EvalRun 类型**

在 `src/eval/run-store.ts` 的 `EvalRun` 增加可选字段，兼容旧 run/baseline：

```ts
queryExpansion?: {
  enabled: boolean;
  registryHash?: string;
  reviewedAliasCount: number;
};
```

- [ ] **Step 2: 从真实 serving trace 捕获 run 配置**

在 `src/eval/retrieve-eval.ts` 的 `ServingResult` 增加：

```ts
queryExpansion: NonNullable<EvalRun['queryExpansion']>;
```

在 `evaluateServing()` 中首次获得 `st.queryExpansion` 时保存：

```ts
let queryExpansion:
  | NonNullable<EvalRun['queryExpansion']>
  | undefined;

const expansion = st.queryExpansion;
if (!queryExpansion && expansion) {
  queryExpansion = {
    enabled: expansion.enabled,
    registryHash: expansion.registryHash,
    reviewedAliasCount: expansion.reviewedAliasCount ?? 0,
  };
}
```

返回前保证存在配置：

```ts
queryExpansion: queryExpansion ?? {
  enabled: false,
  reviewedAliasCount: 0,
},
```

构造 retrieval `run` 时写入：

```ts
queryExpansion: reranked.queryExpansion,
```

- [ ] **Step 3: 核实默认调用链，不新增平行逻辑**

确认以下调用方都不手工调用 `expandQueryWithAliases()`：

```bash
rg -n "expandQueryWithAliases|searchCorpusTraced" \
  src/server/pipeline.ts \
  src/eval/retrieve-eval.ts \
  src/eval/faithfulness-eval.ts
```

Expected:

- serving/eval/faith 只调用 `searchCorpusTraced()`。
- expansion 只在 `searchCorpusTraced()` 内执行。
- A/B 的 forced-target oracle 诊断除外。

- [ ] **Step 4: 验证默认开启和显式关闭**

用无网络 runtime 检查：

```bash
npx tsx -e "import {resolveQueryExpansionEnabled} from './src/retrieval/query-expansion-runtime'; console.log(resolveQueryExpansionEnabled(undefined), resolveQueryExpansionEnabled(false), resolveQueryExpansionEnabled(true, 'false'))"
```

Expected:

```text
true false true
```

- [ ] **Step 5: 运行 TypeScript 与项目测试**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
git diff --check
```

Expected: 全部通过。

- [ ] **Step 6: Review gate**

停止并汇报：

- serving、retrieval eval、faith eval 的调用链证据。
- 默认 on / explicit off 的结果。
- EvalRun 新字段兼容性。

未经用户明确指示不 commit，不进入 Task 4。

---

### Task 4: Full A/B、稳定性、Faith 与 Baseline 人工门禁

**Files:**
- Generate ignored: `data/eval/runs/*.json`
- Generate ignored: `data/eval/traces.jsonl`
- Modify only after approval: `data/eval/baseline.json`

- [ ] **Step 1: 运行 full same-set A/B**

Run:

```bash
npm run aliases:ab -- --all
```

Acceptance:

- expansion-on `Recall@3 >=` expansion-off。
- expansion-on `MRR >=` expansion-off。
- `lost(R@3): 无`。
- gained case 与既有 8 条结果一致，差异必须逐条解释。

- [ ] **Step 2: 重复 targeted A/B 三次确认稳定性**

Run:

```bash
npm run aliases:ab
npm run aliases:ab
npm run aliases:ab
```

记录：

- 关键 gained case 的 top3 是否稳定。
- rerank 噪音是否只影响 base，还是影响 expansion-on。
- 是否出现任何单次 lost。

- [ ] **Step 3: 生成默认 expansion-on retrieval candidate run**

Run:

```bash
npm run eval -- 3
```

Expected:

- 新 run 写入 `data/eval/runs/`。
- run 中 `queryExpansion.enabled=true`。
- run 中存在 64 位 `registryHash`。
- `reviewedAliasCount=11`。

记录 candidate 路径，避免后续 faith run 覆盖“最新 run”的判断：

```bash
CANDIDATE_RUN="$(ls -t data/eval/runs/*.json | head -n 1)"
printf '%s\n' "$CANDIDATE_RUN" > /tmp/k8s-yaml-assistant-expansion-candidate
printf '%s\n' "$CANDIDATE_RUN"
```

Expected: 输出刚生成的 retrieval run 路径。

- [ ] **Step 4: 对旧 baseline 输出跨版本参考**

Run:

```bash
CANDIDATE_RUN="$(cat /tmp/k8s-yaml-assistant-expansion-candidate)"
npm run eval:compare -- "$CANDIDATE_RUN"
```

Expected:

- 工具提示 eval-set 指纹变化。
- 不把该 delta 单独归因给 expansion。
- 纯归因仍使用 Step 1 的 current same-set A/B。

- [ ] **Step 5: 跑 policy faith 子集**

Run:

```bash
npm run eval:faith -- --policy
```

记录：

- 9 条 policy case 的 faithful 数量。
- schema/policy 是否继续明确分层。
- conflict case 是否出现 source 引用回退。
- 新增 `hallucination` 或 `dual_cause` 必须阻止 promotion。

- [ ] **Step 6: 最终静态验证**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
git diff --check
git status --short
```

Expected: 静态检查和测试全部通过；只出现本轮预期源码、文档和 baseline 前置变更。

- [ ] **Step 7: Baseline review gate**

停止并向用户提交：

- full off/on A/B 汇总。
- 三次稳定性结果。
- candidate run 路径和 expansion 元数据。
- `eval:compare` 的 hash 警告与指标。
- policy faith 结果。
- 是否建议 promote。

此时不得执行 `eval:promote`。

- [ ] **Step 8: 仅在用户明确批准后 promote**

Run:

```bash
CANDIDATE_RUN="$(cat /tmp/k8s-yaml-assistant-expansion-candidate)"
npm run eval:promote -- "$CANDIDATE_RUN"
```

Expected:

- `data/eval/baseline.json` 更新为 candidate run。
- baseline 中 `queryExpansion.enabled=true`。
- baseline `evalSetHash=6c8a22bd3697f72fd612565dab0222cebf64008f697bc3de44635a1826448d13`。

若用户不批准：

- 不修改 baseline。
- 将 `resolveQueryExpansionEnabled()` 默认值改回 false。
- 重跑 Task 3-4 的默认路径验证后再继续。

- [ ] **Step 9: Review gate**

汇报 baseline 是否已对齐。未经用户明确指示不 commit，不进入 Task 5。

---

### Task 5: 独立修复 Exact Path 与 Leaf Fallback

**Files:**
- Create: `src/retrieval/exact-field.ts`
- Create: `src/retrieval/exact-field.test.ts`
- Modify: `src/server/pipeline.ts`
- Modify: `package.json`

- [ ] **Step 1: 写真实 CORPUS 失败测试**

创建 `src/retrieval/exact-field.test.ts`：

```ts
import assert from 'node:assert/strict';
import { CORPUS } from '../knowledge/corpus';
import { findExactFieldChunks } from './exact-field';

const image = findExactFieldChunks(
  CORPUS,
  'Deployment',
  'spec.template.spec.containers.image',
  3,
);
assert.deepEqual(
  image.map((chunk) => chunk.id),
  [
    'Deployment::spec.template.spec.containers.image',
    'policy.deployment.image.tag.no-latest',
  ],
);

const privileged = findExactFieldChunks(
  CORPUS,
  'Pod',
  'spec.containers.securityContext.privileged',
  3,
);
assert.deepEqual(
  privileged.map((chunk) => chunk.id),
  [
    'Pod::spec.containers.securityContext.privileged',
    'policy.pod.security.privileged.forbidden',
  ],
);

const ambiguousLeaf = findExactFieldChunks(
  CORPUS,
  'Deployment',
  'unknown.image',
  3,
);
assert.deepEqual(ambiguousLeaf, []);
```

该测试要求 full path 才能命中；`unknown.image` 不能因为叶子是 `image` 而短路。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npx tsx src/retrieval/exact-field.test.ts
```

Expected: FAIL，提示 `exact-field` 模块不存在。

- [ ] **Step 3: 实现 exact-only 纯函数**

创建 `src/retrieval/exact-field.ts`：

```ts
import type { Chunk } from '../knowledge/corpus';

export function findExactFieldChunks(
  chunks: readonly Chunk[],
  resource: string | undefined,
  fieldPath: string | undefined,
  k: number,
): Chunk[] {
  if (!resource || !fieldPath) return [];
  return chunks
    .filter(
      (chunk) =>
        chunk.resource === resource &&
        chunk.path === fieldPath,
    )
    .slice(0, k);
}
```

- [ ] **Step 4: Pipeline 改用 exact-only helper**

在 `src/server/pipeline.ts`：

```ts
import { findExactFieldChunks } from '../retrieval/exact-field';
import {
  resolveQueryExpansionEnabled,
  type QueryExpansionTrace,
} from '../retrieval/query-expansion-runtime';
```

将 `exactFieldHits()` 改为：

```ts
function exactFieldHits(
  resource: string | undefined,
  fieldPath: string | undefined,
  k: number,
): Hit[] {
  return findExactFieldChunks(CORPUS, resource, fieldPath, k)
    .map((chunk) => toHit(chunk, 1));
}
```

删除原有 leaf fallback。完全路径没有命中时，现有控制流自然进入 `searchCorpusTraced(text, { boostPath })`。

- [ ] **Step 5: Exact trace 标记 skipped_exact**

构造 exact trace 前增加：

```ts
const expansionEnabled = resolveQueryExpansionEnabled(undefined);
const exactExpansionTrace: QueryExpansionTrace = {
  enabled: expansionEnabled,
  status: expansionEnabled ? 'skipped_exact' : 'disabled',
  originalQueryText: text,
  expandedQueryText: text,
  matchedAliases: [],
  expansionTerms: [],
  routedResource: routed ?? undefined,
  selectedResource: routed ?? undefined,
};
```

写入：

```ts
queryExpansion: exactExpansionTrace,
```

不要加载 alias registry；exact path 不需要 registry hash。

- [ ] **Step 6: 把 exact 测试加入 `npm test`**

在 `package.json` 的 `test` 脚本中加入：

```text
tsx src/retrieval/exact-field.test.ts
```

- [ ] **Step 7: 验证 exact 与 leaf 分流**

Run:

```bash
npx tsx src/retrieval/exact-field.test.ts
npx tsc --noEmit -p tsconfig.json
npm test
git diff --check
```

Expected:

- image/privileged 同路径 schema+policy 都命中。
- `unknown.image` 返回空，不再 leaf 短路。
- 全部项目测试通过。

- [ ] **Step 8: Review gate**

停止并单独汇报 exact 修复结果。不要把本 Task 的行为变化归因给 expansion 指标；未经用户明确指示不 commit，不进入 Task 6。

---

### Task 6: 最终全量回归与交付检查

**Files:**
- Verify all changed files
- Generate ignored: `data/eval/runs/*.json`
- Generate ignored: `data/eval/traces.jsonl`

- [ ] **Step 1: 运行 alias registry 和 targeted 回归**

Run:

```bash
npm run aliases:check
npm run aliases:ab
```

Expected: registry 合法，targeted 收益保持。

- [ ] **Step 2: 运行 full A/B**

Run:

```bash
npm run aliases:ab -- --all
```

Expected:

- expansion-on Recall/MRR 不低于 off。
- lost 为 0。
- exact 修复不应改变该组无 cursorPath 的 A/B 指标；若变化，说明存在非预期耦合，停止归因。

- [ ] **Step 3: 运行最终 retrieval eval**

Run:

```bash
npm run eval -- 3
npm run eval:compare
```

Expected:

- 最新 run 为 expansion-on。
- 若 Task 4 已 promote，compare 显示同口径且无非预期回退。
- run 的 alias registry hash、reviewed count 和 baseline 对齐。

- [ ] **Step 4: 运行最终工程验证**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run build
git diff --check
git status --short
```

Expected:

- TypeScript、测试、Next.js build 全部通过。
- 无空白错误。
- 未跟踪/已修改文件仅属于本轮设计、计划、代码、测试和经批准的 baseline。

- [ ] **Step 5: 最终 review gate**

汇报：

- shared serving 接入结果。
- full A/B 与最新 retrieval run。
- baseline 是否与默认 serving 对齐。
- exact/leaf 独立验证结果。
- policy faith 结果。
- build/test 状态。
- 当前未提交 diff。

等待用户决定是否提交 commit；不得擅自 commit。

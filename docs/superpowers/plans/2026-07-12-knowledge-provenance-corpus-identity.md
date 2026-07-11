# Knowledge Provenance 与 Corpus Identity 实施计划

> 状态：已自审，待执行。
> 对应设计：`docs/superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md`。
> 顺序：纠偏计划 2/4。依赖 Eval Artifact Protocol 完成，完成并 review 后再执行 Evaluator Validity。

## Goal

把知识形态、权威来源和适用资源收敛为单一事实模型；让 schema/policy、corpus provider、索引、serving、eval、alias 和 bad case 使用同一 canonical ID 与 manifest identity。迁移后删除 `resource/path/resources/paths/appliesTo/trustLevel` 并存结构。

本计划不 ingest docs/examples，不实现 source quota，不优化 retrieval 排名。

## Execution Rules

- 严格按 Task 顺序执行，每个 Task 后停止汇报并等待 review。
- 不维护旧 chunk ID runtime alias；数据引用一次性迁移。
- 不把 cluster 或 CRD schema 标为 Kubernetes 官方内置事实。
- 不运行 embedding/index build，除非用户在最终 Task 明确批准成本。
- chunk ID、hash 或 metadata 变化不得被宣称为模型收益。
- 未经用户要求不 commit，不 promote baseline。

## Canonical Model

```ts
type SourceType = 'schema' | 'docs' | 'policy' | 'example';

type SourceAuthority =
  | 'kubernetes_official'
  | 'cluster_api'
  | 'extension_provider'
  | 'organization'
  | 'curated';

interface Provenance {
  authority: SourceAuthority;
  sourceUri?: string;
  version?: string;
}

interface KnowledgeTarget {
  apiVersion?: string;
  kind: string;
  path?: string;
}

interface KnowledgeChunk {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  provenance: Provenance;
  targets: KnowledgeTarget[];
}
```

Schema ID 格式固定为：

```text
schema::<apiVersion>::<kind>::<path>
```

示例：

```text
schema::apps/v1::Deployment::spec.replicas
schema::v1::Pod::spec.containers.image
```

Policy 保留当前稳定业务 ID `policy.*`，但 targets/provenance 使用 canonical 结构。整个 corpus 中重复 ID 直接失败。

## Provider Identity

```ts
interface SourceManifest {
  sourceType: SourceType;
  providerId: string;
  version?: string;
  generatedAt?: string;
  count: number;
  contentHash: string;
  manifestHash: string;
}
```

- `contentHash` 覆盖会影响 embedding 的 canonical `id + text`。
- `manifestHash` 覆盖 providerId、sourceType、version 和完整 chunk，包括 sourceType、provenance、targets。
- `generatedAt` 是审计字段，不进入 contentHash/manifestHash。
- corpus manifest 按 providerId 排序组合，并验证 ID 全局唯一。
- hash canonicalization 只有一个实现，禁止 corpus/index/eval 各算一套。

## File Structure

### Create

- `src/knowledge/identity.ts`
- `src/knowledge/identity.test.ts`
- `src/knowledge/provenance.test.ts`

### Modify

- `src/knowledge/chunk.ts`
- `src/knowledge/chunk.test.ts`
- `src/knowledge/schema-corpus.ts`
- `src/knowledge/policy-corpus.ts`
- `src/knowledge/policy-corpus.test.ts`
- `src/knowledge/corpus.ts`
- `src/knowledge/corpus.test.ts`
- `src/knowledge/schemas.ts`
- `src/retrieval/index-store.ts`
- `src/retrieval/embeddings.test.ts`
- `src/retrieval/retrieve.ts`
- `src/retrieval/trace.ts`
- `src/retrieval/boost.ts`
- `src/retrieval/boost.test.ts`
- `src/retrieval/exact-field.ts`
- `src/retrieval/exact-field.test.ts`
- `src/retrieval/sources.ts`
- `src/retrieval/sources.test.ts`
- `src/retrieval/source-policy.ts`
- `src/retrieval/source-policy.test.ts`
- `src/server/pipeline.ts`
- `src/server/pipeline-retrieval.test.ts`
- `app/lib/api.ts`
- `app/ui/AskPanel.tsx`
- `scripts/index-build.ts`
- `scripts/corpus-stats.ts`
- `scripts/check-schema-aliases.ts`
- `scripts/generate-schema-aliases.ts`
- `scripts/query-expansion-ab.ts`
- `scripts/voyage-ab.ts`
- `src/eval/cases/retrieval-cases.ts`
- `src/eval/retrieval-eval.ts`
- `src/eval/faithfulness-eval.ts`
- `src/eval/bad-cases.ts`
- `src/eval/bad-cases.test.ts`
- `data/aliases/schema-field-alias-targets.json`
- `data/aliases/schema-field-aliases.jsonl`
- `data/eval/bad-cases.jsonl`

### Invalidate / Regenerate

- ignored `data/index/` 和 `data/index-ab/`。
- `data/eval/judge-calibration.jsonl`：旧 context snapshot 不能跨 knowledge identity 继续使用；保留人工 labels，待新 faith run 后重建。
- 所有旧 run/trace：由 Artifact plan 的 ignored cleanup 处理。

## Task 1: Canonical Identity 与迁移预览

**Files:**

- Create: `src/knowledge/identity.ts`
- Create: `src/knowledge/identity.test.ts`
- Create temporarily: `scripts/migrate-knowledge-ids.ts`

- [ ] **Step 1: 先写 identity 反例测试**

覆盖 target 缺 kind、target 去重排序、schema ID 区分 apiVersion/kind/path、同 Kind 多版本不冲突，以及 canonical hash 输入顺序稳定。此时不修改现有 `Chunk` 导出，避免未迁移 consumer 失效。

- [ ] **Step 2: 实现纯 identity primitives**

导出 `schemaChunkId()`、`canonicalTargets()` 和 canonical JSON/hash helper。模块不得 import `CORPUS` 或带 `main()` 的 runner。

- [ ] **Step 3: 建立只读迁移预览**

one-shot 工具从真实 `SchemaDoc.apiVersion/kind` 与当前 chunk path 建立 old ID -> new ID 映射，并扫描 retrieval cases、aliases、bad cases 和测试 fixture。默认只能 preview；0 个或多个匹配整批失败，不允许字符串替换猜 apiVersion。

```bash
npx tsx src/knowledge/identity.test.ts
npx tsx scripts/migrate-knowledge-ids.ts --preview
npx tsc --noEmit -p tsconfig.json
```

Stop and report：最终 ID 格式、映射数量、unmapped/ambiguous 项和 Task 2 原子切换文件清单。

## Task 2: Canonical Chunk、运行时 Consumer 与数据原子切换

本 Task 是不可拆分的 schema migration。开始前要求 Task 1 preview 为零歧义；结束时 producers、runtime consumers 和提交数据必须同时使用新 contract，禁止停在双写状态。

**Files:**

- Modify: `src/knowledge/chunk.ts` and tests
- Modify: `src/knowledge/schema-corpus.ts`, `src/knowledge/policy-corpus.ts`, `src/knowledge/schemas.ts` and tests
- Create: `src/knowledge/provenance.test.ts`
- Modify: retrieval trace/boost/exact-field/sources/source-policy/index metadata and tests
- Modify: `src/server/pipeline.ts`, pipeline tests, `app/lib/api.ts`, `app/ui/AskPanel.tsx`
- Modify: corpus/eval/alias scripts that read chunk resource/path fields
- Modify: retrieval cases, aliases, bad cases and all old chunk-ID fixtures
- Remove after apply: `scripts/migrate-knowledge-ids.ts`
- Remove: `data/eval/judge-calibration.jsonl`; keep human labels

- [ ] **Step 1: 切换 Chunk 与 providers**

- `KnowledgeChunk` 只保留 sourceType/provenance/targets；缺字段 runtime decode 失败。
- schema provider 从完整 SchemaDoc 构造 target 和 canonical ID；chunk text 保持不变。
- policy 输入仍可使用 `appliesTo`，输出只使用 targets，业务 ID 保持 `policy.*`。
- authority 固定映射：builtin -> kubernetes_official、cluster -> cluster_api、crd -> extension_provider、policy -> organization。
- `apiVersion` 只进入 target；未知 version/sourceUri 留空，不猜测。

- [ ] **Step 2: 同步迁移所有 runtime consumers**

- boost、router hint、exact field、trace、source formatting、index chunk metadata 统一读 targets/provenance。
- `TraceHit`、API `Source` 和 UI 输出 canonical targets/provenance；cluster/CRD schema 不显示为 Kubernetes 内置官方事实。
- source policy 只维护 source label、事实域和 prompt role，删除 trustLevel。
- 删除未生效 `sourceQuotas`；exact-field 先收集完整候选，再执行真实选择和 k 截断。

- [ ] **Step 3: 应用提交数据迁移**

在同一改动中更新 retrieval expected IDs、alias target/chunk IDs、bad-case source IDs、A/B 脚本和测试 fixture。保留 policy ID。迁移后删除 one-shot 工具和任何 old->new runtime map，并增加旧 ID 格式扫描测试。

- [ ] **Step 4: 失效不可复用 snapshot**

保留 `judge-calibration-labels.jsonl`。删除含旧 context/source identity 的 materialized calibration snapshot；不从当前 corpus 伪造旧运行输入。ignored index 只标记失效，本 Task 不触发 Voyage rebuild。

- [ ] **Step 5: 原子验收**

```bash
npx tsx src/knowledge/chunk.test.ts
npx tsx src/knowledge/provenance.test.ts
npx tsx src/knowledge/policy-corpus.test.ts
npx tsx src/retrieval/source-policy.test.ts
npx tsx src/retrieval/sources.test.ts
npx tsx src/retrieval/exact-field.test.ts
npx tsx src/server/pipeline-retrieval.test.ts
npm run aliases:check
npm run eval:check
npm run corpus:closure
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report：authority 分布、ID 迁移数量、删除的 snapshot、旧字段/旧 ID 扫描结果。任一校验失败都不把 Task 标为完成。

## Task 3: Provider Manifest 与唯一 Corpus Identity

**Files:**

- Modify: `src/knowledge/identity.ts` and tests
- Modify: `src/knowledge/corpus.ts` and tests
- Modify: `scripts/corpus-stats.ts`
- Modify: Artifact plan 建立的 kind-specific run config helper

- [ ] **Step 1: 写 hash 与 duplicate 反例**

覆盖输入重排、text 变化、metadata-only 变化、generatedAt 变化、provider version 变化，以及 provider 内/跨 provider duplicate ID。`generatedAt` 不进入 hash；provider version 只改变 manifestHash。

- [ ] **Step 2: 建立 provider manifests**

- schema providerId = `schema.curated-openapi`。
- policy providerId = `policy.organization`。
- contentHash 覆盖排序后的 canonical id+text。
- manifestHash 覆盖 providerId/sourceType/version 和完整 canonical chunks。
- corpus manifest 按 providerId 排序组合，并验证全局 ID 唯一。

- [ ] **Step 3: 删除重复 hash 实现**

corpus、stats 和 eval run config 只使用 knowledge identity 公开入口。retrieval/faith 记录 corpus contentHash/manifestHash；generation/fix validation identity 使用 schema provider manifest。

```bash
npx tsx src/knowledge/identity.test.ts
npx tsx src/knowledge/corpus.test.ts
npm run corpus:stats
npx tsc --noEmit -p tsconfig.json
```

Stop and report：provider manifests、corpus identity、chunk count 和 text 是否保持。

## Task 4: Index v2 与 Runtime 一致性

**Files:**

- Modify: `src/retrieval/index-store.ts`
- Modify: `src/retrieval/embeddings.test.ts`
- Modify: `src/retrieval/retrieve.ts`
- Modify: `src/retrieval/trace.ts`
- Modify: `scripts/index-build.ts`

- [ ] **Step 1: 写 index v2 反例**

IndexManifest 必须包含 formatVersion、embeddingModel、dimension、count、corpus contentHash/manifestHash、indexHash 和 createdAt。测试 text/metadata/model/dimension/count 不匹配、损坏 JSON、NaN embedding 与 duplicate ID 均明确失败。

- [ ] **Step 2: 实现单一 identity 输入**

index-store 接收 corpus manifest，不自行重算另一份 corpus hash。indexHash 覆盖 format、embedding model 与 corpus identity；readIndex runtime decode manifest/chunks。metadata-only 复用向量不在本轮实现，第一版要求重建。

- [ ] **Step 3: fail-safe 与 trace**

旧或不匹配 index 不得返回陈旧 metadata。按现有策略实时 rebuild 时，trace 明确记录 miss/rebuild 原因，不能称为 cache hit。

```bash
npx tsx src/retrieval/embeddings.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：index v2、全部失效原因、旧 index 状态；不执行付费 build。

## Task 5: Cleanup 与全本地回归

- [ ] **Step 1: 预览 ignored index**

列出 `data/index`、`data/index-ab` 的路径、大小、format 和 manifest。清理前获得用户确认；不删除任何提交数据。

- [ ] **Step 2: 全本地回归**

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run corpus:stats
npm run corpus:closure
npm run aliases:check
npm run eval:check
npm run build
git diff --check
```

- [ ] **Step 3: 最终审计**

```bash
rg "trustLevel|resources\?|paths\?|chunkResources|chunkPaths|computeCorpusHash|hashCorpusChunks|sourceQuotas" src scripts app
rg '"[A-Za-z][A-Za-z0-9]+::[^:]' src data scripts --glob '!data/schemas/generated/**'
```

Expected：只允许与 KnowledgeChunk 无关的业务字段命中；运行时无旧 locator/trust、重复 hash 或旧 schema chunk ID。

Stop and report：本地回归、corpus identity、authority 分布和待重建 index。

## Task 6: 正式 Index Rebuild 决策

`npm run index:build` 会调用 Voyage 全量 embedding。执行前报告 chunk 数、embedding model、预计调用量/耗时和旧 index 已失效事实，获得用户明确批准后才运行。

运行后验证 index manifest、count/dimension/hash 与当前 corpus 完全一致；失败 artifact 不得冒充可用 cache。若用户暂不批准，本 plan 可记录为“代码完成、正式 index 待重建”，但 Ask/eval 的运行前置条件必须明确。

Stop and report：是否执行 build、最终 index identity 和下一 plan 可用前置条件。

## Completion Gate

- 所有 runtime chunks 只有 sourceType/provenance/targets 一套事实源。
- schema ID 区分 apiVersion/kind/path，corpus ID 全局唯一。
- cluster/CRD schema 不显示为 Kubernetes 内置官方事实。
- provider manifest 和 index identity 能检测 text 与 metadata 变化。
- serving、eval、stats、index 使用同一 corpus identity。
- aliases、eval cases、bad cases 已迁移，没有 runtime 旧 ID map。
- 未实现的 source quota API 已删除。
- 本地测试、类型检查和 build 通过；正式 index build 是否执行有明确记录。

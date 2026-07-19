# Knowledge Provenance 与 Corpus Identity 纠偏设计

> 状态：已实施；对应实施计划已完成逐 Task（任务）审核。
> 用途：定义知识形态、权威来源、目标资源、provider manifest、corpus 指纹和索引失效边界；本轮不 ingest docs/examples。
> 对应计划：`docs/superpowers/plans/2026-07-12-knowledge-provenance-corpus-identity.md`。
> 顺序：第二项实施。依赖 Artifact Protocol，并在 Evaluator Validity 前完成知识 ID 和 identity 迁移。

## 1. 目标

系统必须能区分“知识是什么”和“知识由谁提供”。schema 是字段约束形态，但可能来自 Kubernetes 官方、当前集群或 CRD 厂商，不能一律标为 K8s 官方。

## 2. 当前问题

- `sourceType='schema'` 自动映射为 `k8s-official`，无法如实表达 cluster/CRD schema。
- Chunk 同时维护 `resource/path`、`resources/paths`、`appliesTo`，存在多个事实源。
- schema chunk ID 缺少 apiVersion/group，同 Kind 多版本会冲突。
- corpus/index hash 只覆盖 `id+text`，targets/sourceType 变化后仍接受旧索引 metadata。
- `sourceQuotas` 已暴露但未执行，形成静默无效接口。
- source policy 中 `promptRole` 与实际静态 prompt 规则可能漂移。

## 3. 非目标

- 不新增 docs/example provider 数据和 ingestion。
- 不实现未经新 bad case 证明的复杂 source quota 或重排算法。
- 不引入知识图谱或外部向量数据库。

## 4. Source 与 Provenance

`SourceType` 只表达知识形态：

```ts
type SourceType = 'schema' | 'docs' | 'policy' | 'example';
```

权威来源单独表达：

```ts
interface Provenance {
  authority:
    | 'kubernetes_official'
    | 'cluster_api'
    | 'extension_provider'
    | 'organization'
    | 'curated';
  sourceUri?: string;
  version?: string;
}
```

当前映射：`builtin -> kubernetes_official`、`cluster -> cluster_api`、`crd -> extension_provider`、policy -> `organization`、人工示例 -> `curated`。`extension_provider` 覆盖厂商和用户自定义 CRD，具体提供者由 source URI/version 表达，不能在缺少证据时假定某个厂商。

## 5. Canonical Target

资源适用范围只保留一个成对结构：

```ts
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

不得长期同时维护 `resource/path`、`resources/paths` 和 `appliesTo`。迁移完成后，下游统一从 `targets` 派生 resource/path 视图。

schema chunk ID 至少区分 source type、apiVersion、kind 和 path。provider 可以使用自己的稳定业务 ID，但整个 corpus 中 ID 必须全局唯一，重复直接失败。

## 6. Provider 与 Manifest

每个 provider 负责生成一种知识来源及其 manifest：

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

- `contentHash` 覆盖影响 embedding 的 ID/text 内容。
- `manifestHash` 覆盖 providerId、sourceType、version 和完整 canonical chunk，包括 sourceType、provenance 和 targets。
- `generatedAt` 只用于审计，不进入 hash；相同输入重复 ingestion 不应仅因时间变化失效索引。
- corpus manifest 组合所有 provider manifest，并验证 ID 唯一。
- serving、eval 和 index build 必须记录同一 corpus manifest identity。

## 7. 索引一致性

持久化索引至少记录 format version、embedding model、content hash 和 manifest hash。

- text/content 变化必须重新生成 embedding。
- metadata-only 变化不得继续读取旧 chunk metadata；第一版可以重建索引，后续再优化为复用向量、刷新 metadata。
- corpus hash 实现只能有一份，index-store、eval 和 corpus stats 共用。
- runtime 读取索引时验证 manifest 与 chunk 数量、维度和 identity。

## 8. Source Policy 与 Selection

- label、authority 表达和 prompt role 从同一 source policy 构造，serving/faith 共用。
- CRD schema 应表达为当前集群或厂商提供的 schema 字段事实，不说成 Kubernetes 官方内置事实。
- 当前删除未生效的 `sourceQuotas` 参数；只有 docs/examples 实际接入且 bad case 证明容量竞争后，再设计并实现 quota。
- 未来 selection 使用统一 `RetrievedHit { chunk, score }` 输入，并在截断 k 之前执行；exact-field 也不能预先截断后再做来源选择。

## 9. 迁移

- 当前 schema/policy chunks 一次性迁移到 provenance + targets。
- query alias、retrieval case expected IDs 和 bad case source IDs 通过可审计映射更新。
- 旧 ignored index 直接重建，不维护旧 index metadata 兼容。
- baseline 的 corpus identity 随新 manifest 一次性更新，不能把迁移前后 delta 宣称为纯模型变化。

## 10. 反例验收

- CRD schema context 不得显示为 Kubernetes 官方内置 schema。
- 同 Kind 不同 apiVersion 的 chunks ID 不冲突。
- 只修改 target/path/sourceType 时 manifest hash 必须变化，旧索引不得命中。
- chunk ID 重复时 corpus build 明确失败。
- index-store 与 corpus builder 对同一语料计算出同一 identity。
- 未实现 quota 时 API 中不存在静默忽略的 `sourceQuotas`。

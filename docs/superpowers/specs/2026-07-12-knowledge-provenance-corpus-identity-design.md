# Knowledge Provenance 与 Corpus Identity 纠偏设计

> 状态：已实施；对应实施计划已完成逐 Task（任务）审核。
> 用途：定义知识形态、权威来源、目标资源、provider manifest、corpus 指纹和索引失效边界；本轮不 ingest docs/examples。
> 对应计划：`docs/superpowers/plans/2026-07-12-knowledge-provenance-corpus-identity.md`。
> 顺序：第二项实施。依赖 Artifact Protocol，并在 Evaluator Validity 前完成知识 ID 和 identity 迁移。
> 2026-07-25 收敛：当前契约升级为 knowledge identity v2（知识身份版本 2），删除无独立行为消费者的 corpus contentHash（语料内容哈希）。

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
  providerId: string;
  sourceType: SourceType;
  version?: string;
  generatedAt?: string;
  count: number;
  manifestHash: string;
}

interface CorpusManifest {
  identityVersion: 2;
  providers: SourceManifest[];
  count: number;
  manifestHash: string;
}
```

- provider `manifestHash` 覆盖 providerId、sourceType、version 和完整 canonical chunk，包括 provenance 和 targets；provider 不再重复维护 `contentHash`。
- corpus `manifestHash` 只组合按 providerId 排序后的 provider `manifestHash`；provider `manifestHash` 已绑定 providerId，不在 corpus 根输入中重复保存。
- corpus `identityVersion` 明确整套哈希算法契约，并由 index identity 绑定；算法变化必须升级该版本。`generatedAt` 只用于审计，不进入 hash；相同输入重复 ingestion 不应仅因时间变化失效索引。
- corpus manifest 组合所有 provider manifest，并验证 provider ID 和 chunk ID 全局唯一。
- serving、eval 和 index build 必须记录同一 corpus manifest identity。

## 7. 索引一致性

持久化索引至少记录 format version（格式版本）、embedding model（向量嵌入模型）和 corpus manifest hash（语料清单哈希）。

- 任意 canonical chunk（规范知识片段）变化不得继续读取旧索引；当前没有独立向量复用身份，统一重建完整索引产物。
- corpus hash 实现只能有一份，index-store、eval 和 corpus stats 共用。
- index（索引）写盘按 chunk ID（知识片段标识）稳定排序并同步重排 embedding（向量嵌入），保证相同语料身份不因 provider（知识提供方）输入顺序产生不同数据文件。
- runtime 读取索引时验证 manifest 与 chunk 数量、维度和 identity。
- build runner（构建运行器）写入后必须通过同一 runtime（运行时）读取路径立即回读；校验失败不得报告构建成功。

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

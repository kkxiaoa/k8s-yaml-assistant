# Alias-aware Query Expansion Serving 接入设计

> 状态：已实施；2026-07-29 根据 `policy-conflict-privileged` 的正式评估证据修订粗召回与重排边界。

## 1. 背景与证据

A3 已通过全量 eval A/B 验证 schema alias query expansion 的收益：

- answerable cases:81
- alias matched cases:9
- no-expansion:`R@3=89.5%`、`MRR=0.847`
- alias-expansion:`R@3=98.8%`、`MRR=0.926`
- gained:8 条
- lost:0 条

当前收益只存在于 A/B 脚本，Web Ask 的真实 serving 路径仍未启用 expansion。本轮目标是让 serving、retrieval eval、faith eval 和 A/B 共用同一个 alias-aware 检索入口，把已验证的离线收益送入真实链路。

## 2. 目标

1. 将 alias expansion 下沉到共享检索入口 `searchCorpusTraced()`。
2. 默认开启 expansion，并支持环境变量和调用参数快速回退。
3. 让 serving、eval、faith 和 A/B 复用同一实现，不再由调用方手工拼接 expanded query。
4. 在 trace 和 eval run 中记录 expansion 决策与 alias registry 版本，使结果可诊断、可复现。
5. 修正 `exactFieldHits()` 的同名叶子字段模糊短路，避免按语料顺序截取歧义字段。

## 3. 非目标

本轮不包含：

- 新增或扩充 schema alias。
- docs/examples ingestion。
- UI 改造。
- Stage 7 bad-case 分类与反馈闭环扩展。
- 自动更新 retrieval baseline。
- BM25、RRF 或其他 Hybrid Retrieval。
- 未经审核提交 commit。

## 4. 接入边界

### 4.1 选择 `searchCorpusTraced`

`searchCorpusTraced()` 是 serving、retrieval eval 和 faith eval 已有的共享检索入口。Expansion 在该函数内部完成，调用方只负责提供原始 query 和检索选项。

不采用以下方案：

- 只在 `retrieveContext()` 接入：eval 仍需重复实现，容易形成口径分裂。
- 新增 `searchCorpusWithExpansion()`：会产生两个检索入口，调用方可能误用旧路径。

### 4.2 数据流

```text
retrieveContext / retrieval eval / faith eval / A/B
  → searchCorpusTraced(originalQuery, options)
      → 解析 queryExpansion 开关
      → 加载 reviewed aliases
      → expandQueryWithAliases(
          originalQuery,
          boostResource,
          resourceStrategy: alias-aware
        )
      → 得到 expandedQuery + aliasSelectedResource + 唯一匹配字段路径
      → embed(expandedQuery)
      → denseSearch(effectiveResource, effectivePath)
      → 有 alias 命中时 rerank(originalQuery + matchedPaths, title + text)
      → 无 alias 命中时保持 rerank(expandedQuery, text)
      → 返回 hits + expansion trace
```

其中：

```text
effectiveResource = aliasSelectedResource ?? boostResource
effectivePath = callerBoostPath
  ?? (唯一 matched alias 的 resource 与 effectiveResource 相同时使用其 path)
```

weak/strong、同资源/跨资源启用规则完全复用现有 `expandQueryWithAliases()`，serving 不重新实现规则。

扩展术语只帮助 dense retrieval（稠密检索）跨语言或口语召回字段。有 alias 命中时，rerank（重排）使用原始用户问题和全部命中字段路径，并让文档携带既有标题，避免字段术语覆盖“能否使用”等原始意图，同时保留资源和路径身份。多个 alias 同时命中时不为 dense retrieval 推断单一字段路径，防止按注册顺序任意偏向其中一个字段；调用方显式提供的 `boostPath` 始终优先。无 alias 命中的请求保持原有重排行为。

## 5. Exact Path 与模糊叶子字段

### 5.1 现有证据

当前 eval 直接调用 `searchCorpusTraced(question)`，没有传入 `cursorPath`，因此尚未覆盖 `retrieveContext() → exactFieldHits()` 分支。

对真实 `CORPUS` 的无网络诊断显示：

| 字段 | exact 命中 | 同名叶子候选 |
|---|---:|---:|
| `Deployment.spec.template.spec.containers.image` | schema + policy，共 2 条 | 6 条 |
| `Pod.spec.containers.securityContext.privileged` | schema + policy，共 2 条 | 4 条 |
| `Service.spec.type` | schema + policy，共 2 条 | 3 条 |
| `Ingress.spec.tls` | schema + policy，共 2 条 | 2 条 |
| `PersistentVolumeClaim.spec.resources.requests` | schema，共 1 条 | 1 条 |

结论是：完全路径匹配可靠，但同名叶子 fallback 存在明显歧义。

### 5.2 最终规则

1. `resource + cursorPath` 完全匹配时，直接返回该路径下的所有知识源，包括 schema、policy，以及未来可能加入的 docs。
2. 完全匹配不执行 alias expansion，因为字段已经被确定性定位。
3. 完全匹配失败时，不再将同名叶子字段结果作为短路结果。
4. 未精确命中的请求进入 `searchCorpusTraced()`，将 `cursorPath` 作为 `boostPath`，同时执行 alias expansion。
5. 本轮不引入“exact + semantic supplemental search”。相关来源若无法通过完全路径命中，由后续 serving bad case 证明后再决定是否扩展，避免无证据增加每次字段解释的网络延迟。

## 6. Feature Flag

`SearchOptions` 新增：

```ts
queryExpansion?: boolean;
```

优先级：

1. 调用方显式传入的 `SearchOptions.queryExpansion`。
2. 环境变量 `ENABLE_QUERY_EXPANSION`。
3. 默认值 `true`。

仅当 `ENABLE_QUERY_EXPANSION` 严格等于字符串 `false` 时关闭。A/B 与测试必须显式传入 `true/false`，不依赖进程环境。

本规则取代
`docs/superpowers/specs/2026-07-08-schema-alias-registry-design.md`
中 serving 接入前的默认关闭策略。当前 targeted/full eval 已满足默认开启的证据门槛。

## 7. Alias Registry 加载与降级

### 7.1 加载

- serving 只加载 `reviewed: true` 的 alias。
- alias registry 使用进程级惰性缓存，避免每个请求同步读取 JSONL。
- registry 文件更新后通过重启进程加载新版本。
- 加载时计算 registry hash，并记录 reviewed alias 数量。

### 7.2 失败策略

采用 fail-open：

- registry 正常：执行 expansion。
- registry 文件存在但没有 reviewed alias：按 `no_match` 处理。
- registry 文件缺失：回退原始 query，记录 `aliases_missing`。
- registry JSONL 非法：回退原始 query，记录 `aliases_invalid`。

缺失或损坏不能导致 Ask 请求失败，也不能静默退回旧链路。服务端输出一次告警，并在 trace 中记录失败状态。

## 8. Trace

`RetrievalTrace` 和 `SearchTrace` 增加：

```ts
queryExpansion?: {
  enabled: boolean;
  status:
    | 'applied'
    | 'no_match'
    | 'disabled'
    | 'skipped_exact'
    | 'failed';
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
  routedResource?: string;
  selectedResource?: string;
  resourceSelectionReason?: ResourceSelectionReason;
  registryHash?: string;
  reviewedAliasCount?: number;
  errorCode?: 'aliases_missing' | 'aliases_invalid';
}
```

字段语义：

- `queryText`：真正送入 embedding 的扩展后 query；有 alias 命中时，rerank 使用 `originalQueryText`、命中字段路径及文档标题，否则保持原有 query 和正文。
- `resourceHint`：alias 处理前的原始路由结果。
- `selectedResource`：alias 规则处理后的最终软加权资源。
- `status=skipped_exact`：完全字段路径命中，没有执行 expansion。
- `status=failed`：registry 加载失败，检索已使用原始 query 降级完成。

Trace 是单条请求的执行证据，用于判断问题发生在路由、expansion、粗召回、rerank 还是 top-k。

## 9. Eval Run

Retrieval eval run 增加 query expansion 配置快照：

```ts
queryExpansion: {
  enabled: boolean;
  registryHash?: string;
  reviewedAliasCount: number;
}
```

Run 负责记录一次完整评估的模型、语料、eval set、alias registry 版本和聚合指标。这样同一份指标可以复现，也能确认 baseline 使用的是哪一批 alias。

Baseline 必须代表默认 serving 配置。默认 serving 切换为 expansion-on 后，不能长期继续使用 expansion-off 的旧 baseline。

当前 `data/eval/baseline.json` 来自旧 eval set：

- baseline `serving.recall@3=90.97%`、`serving.mrr@3=0.896`
- baseline `evalSetHash=0d4b4a...`
- 当前 86 条 eval case / 81 条 answerable 的 `evalSetHash=6c8a22...`
- 当前同集 A/B 的 expansion-off 才是 `R@3=89.5%`、`MRR=0.847`

因此，candidate run 与旧 baseline 的 `eval:compare` 只能作为跨版本参考，不能把 delta 全部归因给 expansion。Expansion 的纯归因必须使用当前同一 eval set 上的 explicit off/on A/B。

对齐流程：

1. Expansion 接入完成后保留旧 baseline，先生成 expansion-on candidate run。
2. 运行 full A/B、retrieval eval、稳定性复测和 policy faith。
3. 通过 `eval:compare` 查看 candidate run 相对旧 baseline 的 delta。
4. 停在人工审核门禁，不自动执行 `eval:promote`。
5. 审核通过后，将 candidate run 晋升为 expansion-on baseline。
6. 若 candidate run 不被接受，则默认 serving 必须退回 expansion-off。

因此，本轮不能以“默认 expansion-on + expansion-off baseline”的状态结束。

## 10. A/B 与调用方迁移

### 10.1 A/B

A/B 脚本删除外部手工调用 `expandQueryWithAliases()` 的检索路径，改为：

```ts
searchCorpusTraced(question, {
  boostResource: routed,
  queryExpansion: false,
});

searchCorpusTraced(question, {
  boostResource: routed,
  queryExpansion: true,
});
```

诊断输出继续展示 matched aliases、expansion terms、selected resource 和 selection reason，但数据来自共享 search trace。

### 10.2 Serving 与 Eval

- `retrieveContext()` 不显式关闭 expansion，使用默认开启配置。
- retrieval eval 的 serving 指标调用同一个 `searchCorpusTraced()` 默认路径。
- faith eval 同样使用默认路径，使检索上下文与线上一致。
- 需要旧链路对照时，调用方必须显式传 `queryExpansion:false`。

## 11. 测试与验收

### 11.1 单元与集成测试

必须覆盖：

1. feature flag 默认开启。
2. `ENABLE_QUERY_EXPANSION=false` 可以关闭。
3. `SearchOptions.queryExpansion` 可以覆盖环境变量。
4. exact path 命中 schema。
5. exact path 同时命中 schema + policy。
6. 同名叶子字段不再触发 exact 短路。
7. weak/strong、同资源/跨资源规则保持现有行为。
8. alias 缺失时回退原始 query并记录 `aliases_missing`。
9. alias 损坏时回退原始 query并记录 `aliases_invalid`。
10. trace 中的 query、resource、匹配 alias 和 registry 元数据语义正确。
11. 唯一 alias 命中可提供字段软加权路径，多个 alias 命中不猜测路径。
12. alias 命中时 rerank 使用原始用户问题、命中路径和文档标题；未命中时保持旧输入。

### 11.2 指标门禁

1. 运行 targeted A/B，确认已知 gained case 仍被救回。
2. 运行 full eval A/B：
   - enabled 的 `Recall@3` 不低于 disabled。
   - enabled 的 MRR 不低于 disabled。
   - 无新增 lost case。
3. 对关键 case 重复运行，确认收益不依赖单次 rerank 噪音。
4. 运行 retrieval eval 并生成包含 expansion 配置的新 run。
5. 运行 policy faith 子集，检查 schema/policy 分层和 Faithfulness 没有回退。
6. 运行 TypeScript 检查和项目测试。

### 11.3 Task 拆分与归因

Expansion 接入和 exact/leaf 修复必须是独立 task，不能在同一变更和同一次归因验证中混合。

Implementation plan 按以下顺序拆分：

1. 共享 expansion 配置、registry 加载和 trace。
2. A/B 改为调用共享 `searchCorpusTraced()`。
3. Serving、retrieval eval、faith eval 默认接入并验证。
4. 生成 candidate run，停在 baseline 人工审核门禁。
5. 独立修复 exact path 与 leaf fallback 分流，并运行独立测试。
6. 运行最终全量回归。

Task 1-4 只验证 expansion 接入，不改 exact/leaf 行为。Task 5 才修改 exact/leaf，避免发生回退时无法判断责任变更。

## 12. 交付与审核边界

本轮完成后交付：

- alias-aware 的共享 serving 检索入口。
- exact/leaf 分流修正。
- 默认开启、可快速回退的 feature flag。
- expansion trace 和 eval run 可复现元数据。
- 共用真实 search 路径的 A/B。
- 单元测试、全量 A/B、retrieval eval 和 policy faith 验证结果。

每个 implementation task 完成后停下汇报结果，待人工 review 后再执行下一 task。未经明确指示不提交 commit，也不晋升 baseline。

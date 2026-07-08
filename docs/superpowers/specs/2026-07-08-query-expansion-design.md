# A3 schema-aware query expansion 设计

- 日期：2026-07-08
- 状态：待评审
- 主线：检索优化(债 A)第三步,承接 A1/A2

## 1. 背景与目标

A1(top-k 3→5)和 A2(voyage-4)验证后都不采纳、保持现状(`CONTEXT_K=3` + voyage-3),那 10 条跨语言字段 retrieval miss 仍在。A3 触发。

**问题本质**(A1/A2 已排除):中文 query + 英文 schema 的跨语言字段召回。chunk text 是「中文包装 + 英文 description/字段名」,bad-case query 是中文概念("裸块""延迟绑定""存储大小""镜像"),在 chunk 里不存在——dense(voyage-3/4)语义漂了没召回、扩 k 被 rerank 吃掉、BM25 词面跨语言不匹配(已证伪)。

**目标**:schema-aware query expansion——把中文 query 映射到英文字段术语,救跨语言 miss。用**离线 schema-derived alias index + 在线轻量匹配扩展**,先小范围验证假设、再扩大。

## 2. 范围(第一版边界,成败关键)

**范围 = bad-case 的目标字段集合,不是涉及资源**。第一版只覆盖约 10-15 个正确 chunk 对应字段:
- PVC: `spec.volumeMode`、`spec.resources.requests`
- StorageClass: `volumeBindingMode`、`allowVolumeExpansion`
- Deployment/Pod: `containers.image`、`securityContext.privileged`、`spec.volumes`
- StatefulSet: `spec.volumeClaimTemplates`
- RoleBinding: `subjects`
- Endpoints: `subsets.addresses`、`subsets.ports`

**不对 Pod/Deployment 全字段建 alias**(各 1000+ 字段会把工程和 review 成本拉爆)。第一版验证有收益后,再扩 curated 资源的常用字段。

**非目标**:
- 在线 LLM 选字段(后续 fallback,alias miss 时才调,非第一版主链路)。
- 全库 alias。
- BM25/RRF(跨语言证伪,不回)。

## 3. 三层架构

### 3.1 Alias 数据层

- **输入**:真实 schema chunk 的 `resource`/`path`/`description`/`type`/`enum`(仅目标字段)。
- **输出**:`data/aliases/schema-field-aliases.jsonl`。
- **每条结构**:
  ```json
  {
    "resource": "PersistentVolumeClaim",
    "path": "spec.volumeMode",
    "chunkId": "PersistentVolumeClaim::spec.volumeMode",
    "fieldTerms": ["volumeMode", "Block", "Filesystem"],
    "zhAliases": ["卷模式", "裸块", "块设备", "文件系统卷"],
    "source": "llm_offline",
    "reviewed": false,
    "reviewedAt": null,
    "reviewNote": ""
  }
  ```
- **生成**:LLM 离线从字段 `description`/`enum`/`path` 派生 `zhAliases`(中文别名)与 `fieldTerms`(英文术语)。
- **反玩具审计闭环**:
  - 每条 `source: "llm_offline"` + `reviewed: false` 落盘;
  - 第一版量小(~10-15 条),**全部人工过一遍**——确认别名准确、不是模型瞎编,review 后置 `reviewed: true` + `reviewedAt`;
  - **铁律**:可人工审核**修正** LLM 输出,但**不可凭空新增没有 schema 字段来源的 alias**;每条必须能追溯到真实 `resource`/`path`/`chunkId`/`description`。修的是 LLM 输出,不是手写散装词典。

### 3.2 Query expansion 层

- query 进来先 `inferResource`(已能路由 24 类)。
- **只在 routed resource 的 `reviewed: true` alias** 里匹配 query 的中文 `zhAliases`(子串命中)。
- 命中 → 追加该字段的 `fieldTerms` + `path` 到 query text。
- **topN 限制防稀释**:最多 3 个字段、每字段最多 5 个 terms。
- 例:`怎么把卷设成裸块设备?`(routed=PVC)→ 命中 "裸块"→ volumeMode → expansion 后的检索文本 = `怎么把卷设成裸块设备? volumeMode Block Filesystem spec.volumeMode`。
- **`reviewed: true` 的 alias 才用**——线上检索链路和 A/B eval **都只用已审 alias**;未审 LLM 结果既不进检索、也不进实验(否则未审 alias 会在 A/B 里带来虚高,违背"生成后审计")。
- **可诊断输出**(A/B 脚本必须打印、后续接 trace 也要落):`expandedQueryText`(扩展后的检索文本)、`matchedAliases[]`(命中的 `{chunkId, path, zhAlias}`)、`expansionTerms[]`(实际追加的 fieldTerms)。否则命中/回退无法归因。

### 3.3 Eval 层

- 第一版**只在 A/B 脚本里对比,不改全局默认**。
- 对比:**同一次运行的 no-expansion vs alias-expansion**(消除 A1 暴露的 rerank noise)。
- 指标:case-level 是否转 hit(top3/top5)为主,Recall@3 / MRR 为辅。
- **成败指标只算 schema-field miss**:即那 ~9 条"正确 chunk 是 schema chunk"的跨语言 retrieval miss。`policy-conflict-privileged` 的目标 miss 是 **policy chunk**(`policy.pod.security.privileged.forbidden`)、不是中英字段映射问题,**保留为观察项、不计入 A3 schema alias 成功率**(除非后续另加 policy alias 设计)。
- **只用 `reviewed: true` 的 alias 参与 A/B**(见 §3.2)。
- targeted 有收益 → 再跑**全量 eval** 看是否对其他 case 引入回退。

## 4. 数据流(第一版:只在 eval/ab 脚本内启用)

**第一版 `searchCorpusTraced` 默认行为不变**——expansion 只在 A3 的 A/B 脚本里显式套一层(把扩展后的 query text 传给 searchCorpusTraced),线上 serving / CLI / Web **不接入**。接入 serving 必须等 targeted + 全量 eval 都通过后**另行决策**,不在第一版。

A/B 脚本内的流程:
```
query → inferResource(routed)
      → 在 routed resource 的 reviewed:true alias 匹配中文 zhAliases(子串)
      → 命中则追加 fieldTerms + path 到 query text(topN 限制)
      → searchCorpusTraced(扩展后的 query text)  // 复用现有路径,只是喂进去的 query 变了
```

## 5. 约束

- **反玩具**:alias 从真实 schema 派生 + LLM 离线生成 + 人工审计;不手写散装词典;每条追溯 `chunkId`;线上只用 `reviewed: true`。
- **measure-driven**:先小范围验证假设(~9 条 schema-field miss 能否转 hit;privileged 那条是 policy miss、剥离)再扩。**对比必须用同一次运行的 no-expansion vs expansion**——A1 暴露过:两次独立 eval 的整体 Recall 会因 rerank 随机性在 89.5~90.7% 间波动、不可直接比;A3 要看 **case-level 是否转 hit**(同一次跑,expansion 前后同一批 case 对比),而非整体 Recall 小数点。
- **复用现有 retrieve/eval**:expansion 只在 query 进入 searchCorpusTraced 前加一层,不造平行检索路径。
- **Voyage 3RPM 限流**:全量 eval 后台跑。

## 6. 决策门槛

```
第一版(10-15 目标字段 alias + expansion):
  · 对 ~9 条 schema-field 跨语言 miss 有收益(转 hit)且全量 eval 不引入回退
      → 扩 curated 资源的常用字段 alias。
  · 无收益 / 引入回退
      → 记录"alias expansion 假设不成立",考虑在线 LLM fallback 或搁置,不硬扩。
```

## 7. 已知后续(不在第一版)

- 扩到 curated 资源常用字段的 alias(仅当第一版有收益)。
- 在线 LLM 选字段作 fallback(alias miss 时),非主链路。

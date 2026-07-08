# Schema Field Alias Registry 正式方案设计

- 日期:2026-07-08
- 状态:待评审
- 前置证据:A3 targeted + full eval A/B 已验证 alias-aware query expansion 有效

## 1. 背景

A3 第一版证明了"中文问法 → 英文字段术语/path"的 alias expansion 方向有效:

- targeted A/B:`auto/alias-expansion` 在目标集上 `R@3=100.0%`,无回退。
- full eval A/B:`R@3 89.5% → 98.8%`,`MRR 0.847 → 0.918`,`lost(R@3): 无`。
- 同时暴露了副作用信号:`pod-containerport` 的 Recall 不掉,但 MRR `1.000 → 0.333`,说明短/泛 alias 可能影响排序。

因此下一步不是直接全量扩 alias,而是把 alias 从实验数据升级成可治理的 registry:有来源、有审计、有置信度、有启用规则、有评估门禁。

## 2. 目标

正式 alias 体系要解决四件事:

1. 可控扩展:从 bad case 和精选高频字段扩展,不全量扫所有 schema 字段。
2. 可审计:alias 必须能追溯到 `resource/path/chunkId`,并经过人工 review。
3. 可安全启用:弱 alias 不允许跨 resource 抢 boost;强 alias 才能修正 router。
4. 可评估:每批 alias 必须跑 targeted A/B + full eval A/B,无明显回退才允许进入 serving。

非目标:

- 不做全量字段 alias 自动生成。
- 不做在线 LLM 每问一次选字段。
- 不把未审 LLM 结果接入 retrieval。
- 不把 alias 当作 schema 事实层,它只是 query expansion 辅助。

## 3. 本轮 Scope

本轮只做 **结构迁移 + 正式启用规则验证**:

- 将现有 11 条 alias 从 `zhAliases` 迁移为 `weakZhAliases/strongZhAliases`。
- 为现有 target 补充受控来源字段,但不新增大批 target。
- 修改 expansion 规则,实现 weak/strong 的 resource 覆盖边界。
- 跑 targeted A/B 与 full eval A/B,验证迁移不破坏 A3 已有收益。

本轮不做:

- 不扩 `curated_common_field` 新字段批次。
- 不接 serving / CLI / Web。
- 不新增 feature flag。
- 不改 `searchCorpusTraced` 默认行为。

§10 的扩展策略和 §12 的 serving 接入边界是后续轮设计约束,不是本轮实施内容。

## 4. 来源分类

`schema-field-alias-targets` 不应只是一批临时 bad case 字段,正式版升级为目标字段 registry。第一版来源只定义 retrieval 相关来源,避免假装已经覆盖 generation/judge/label bad case。

推荐来源:

- `retrieval_bad_case`:已沉淀到 `data/eval/bad-cases.jsonl` 的检索失败,例如 `failure.type === "retrieval_miss"`。
- `retrieval_eval_miss`:某次 eval run 暴露的检索 miss,尚未沉淀为 bad case。
- `curated_common_field`:K8s YAML Authoring 高频字段,不一定失败过,但产品上高频。
- `product_workflow_field`:围绕一个工作流闭环选出的字段,例如 Deployment+Service+Ingress 多资源生成的一致性字段。

当前已有 targets 多数应归入 `retrieval_eval_miss` 或 `retrieval_bad_case`;不要泛称 `bad_case`,因为 generation/judge/label 的 bad case taxonomy 尚未系统化。

## 5. Target Registry 结构

目标字段 registry 建议继续用 JSON 数组,但补充来源和优先级。

```json
{
  "id": "pod-containerport",
  "resource": "Pod",
  "path": "spec.containers.ports.containerPort",
  "chunkId": "Pod::spec.containers.ports.containerPort",
  "source": "curated_common_field",
  "priority": "high",
  "evalCaseIds": ["pod-containerport"],
  "metric": true,
  "note": "Pod authoring 高频字段"
}
```

字段约束:

- `chunkId/resource/path` 必须与 `CORPUS` 中 schema chunk 一致。
- `evalCaseIds` 若存在,必须在 `EVAL_SET` 中存在。
- `source` 必须来自受控枚举。
- `priority` 用于分批扩展,不影响 retrieval 打分。
- `metric=false` 只用于观察项,不得计入 alias 成功率。

## 6. Alias Registry 结构

现有 `zhAliases:string[]` 需要升级为强弱分层,避免短词跨资源误触发。

```json
{
  "id": "endpoints-subsets-ports",
  "resource": "Endpoints",
  "path": "subsets.ports",
  "chunkId": "Endpoints::subsets.ports",
  "fieldTerms": ["ports", "port numbers", "subsets.ports"],
  "weakZhAliases": ["端口号", "端口列表"],
  "strongZhAliases": ["后端端口", "后端地址和端口"],
  "source": "llm_offline",
  "reviewed": true,
  "reviewedAt": "2026-07-08",
  "reviewNote": "manual reviewed"
}
```

定义:

- `fieldTerms`:追加到 query 的英文术语,必须来自 path、description、enum/type 或直接派生。
- `weakZhAliases`:短、泛、容易跨资源歧义的中文问法。
- `strongZhAliases`:信息量足、可明确指向该字段/资源的中文问法。

强弱不是单纯按字数决定。人工 review 时按歧义度判断:

- 弱: `端口号`、`镜像`、`资源请求`、`主体`、`卷模式`。
- 强: `后端地址和端口`、`延迟到 Pod 调度后再绑定`、`每个副本申请独立存储`、`申请存储大小`、`允许 PVC 扩容`、`裸块设备`。

## 7. Query Expansion 启用规则

alias-aware 应是 router 的补充和纠错机制,不是新的无约束 router。

规则:

```text
如果 alias.resource === routedResource:
  weak/strong 命中都允许 expansion,boostResource 保持 routedResource。

如果 routedResource 为空:
  strong 命中允许选择 alias.resource 作为 boostResource。
  weak 命中只允许追加 terms,不允许单独决定 boostResource。

如果 routedResource 存在且 alias.resource 不同:
  strong 命中才允许覆盖 boostResource。
  weak 命中完全不参与 expansion:既不覆盖 boostResource,也不追加 fieldTerms/path。
```

最后一条是防泛词回退的核心闸。否则 `端口号`、`卷模式` 这类弱 alias 即使不抢 boost,仍会把其他 resource 的英文术语塞进 query,继续造成 MRR 回退。

topN 限制:

- 最多命中 3 个字段。
- 每字段最多追加 5 个 terms。
- 同一 query 命中多个 strong alias 时,先按更长 alias、再按 target priority 排序。

诊断输出必须包含:

- `originalQueryText`
- `expandedQueryText`
- `matchedAliases`
- `expansionTerms`
- `routedResource`
- `aliasSelectedResource`
- `resourceSelectionReason`: `same_resource` / `no_route_strong_alias` / `cross_resource_strong_alias` / `weak_alias_no_resource_override`

## 8. 生成与审计流程

正式流程:

```text
target seed
  → LLM 离线生成 fieldTerms / weakZhAliases / strongZhAliases 草稿
  → aliases:check 校验可追溯
  → 人工 review / 修剪 / 调整强弱
  → reviewed:true
  → targeted A/B
  → full eval A/B
  → 决策是否进入 serving
```

审计规则:

- 未审 alias 不参与任何 eval 或 serving。
- 可人工修正 LLM 输出,但不能新增无法追溯 schema 字段语义的 alias。
- 短词默认进 `weakZhAliases`,除非人工能证明歧义低。
- cross-resource 覆盖必须来自 `strongZhAliases`。

## 9. 本轮迁移验收

本轮是单变量结构迁移,验收目标不是扩大覆盖,而是证明迁移后的规则不破坏现有 A3 收益。

必须跑:

```bash
npm run aliases:check
npm run aliases:ab
npm run aliases:ab -- --all
```

验收标准:

- targeted metric case 的 `auto/alias-expansion R@3` 仍保持 `100.0%`。
- full eval `lost(R@3)` 仍为 0。
- full eval 整体 `R@3` 不低于迁移前 A3 结果: `98.8%`。
- MRR 不应明显回退;特别关注 `pod-containerport` 是否因 weak alias 不再跨 resource expansion 而改善。
- 若 MRR-only 回退仍存在,必须打印 matched alias 和 top3,并记录是否可接受。

## 10. 后续扩展策略

本节是后续轮,不是本轮实施内容。

第一批正式扩展采用"bad-case + curated common fields"路线。

优先级:

1. `retrieval_bad_case` / `retrieval_eval_miss`:已被当前检索链路验证为 miss,且能定位 `expectedChunkIds`;优先补 alias 的收益最确定。
2. `curated_common_field`:K8s YAML Authoring 高频字段,每批 20-50 个。
3. `product_workflow_field`:多资源生成/修复所需字段,例如 selector、port、service backend 引用。

不做:

- 不扩 Pod/Deployment 全字段。
- 不为 `metadata.name`、`status`、`type` 这类高泛化字段盲目生成 alias。
- 不为了追求全量覆盖而增加人工无法 review 的 alias。

## 11. 新增 alias 批次评估门禁

本节适用于后续新增 alias 批次;本轮结构迁移使用 §9 的迁移验收。

每批 alias 必须跑:

```bash
npm run aliases:check
npm run aliases:ab
npm run aliases:ab -- --all
```

采纳条件:

- targeted case 有稳定 gain 或明确 MRR 改善。
- full eval `lost(R@3)` 为 0,或明确可解释且可接受。
- 若出现 MRR-only 回退,必须记录并判断是否来自 weak alias 误触发。
- policy/schema conflict case 不得回退。

不采纳条件:

- full eval 出现无法解释的 Recall 回退。
- alias 命中与 query 意图明显不一致。
- strong alias 造成跨 resource 误 boost。

## 12. Serving 接入边界

本节是后续轮,不是本轮实施内容。

进入 serving 前必须满足:

- registry 已迁移为 `weakZhAliases/strongZhAliases`。
- `searchCorpusTraced` 或其上层 trace 能记录 expansion 诊断字段。
- 有 feature flag,例如 `ENABLE_QUERY_EXPANSION=true`。
- eval 与 serving 使用同一 expansion 函数,不维护平行逻辑。

接入顺序:

1. 先在 eval/AB 里启用正式规则。
2. 再在 serving 里加 feature flag 默认关闭。
3. 打开后观察 trace 和 faithfulness,确认没有 source 引用变差。
4. 稳定后再考虑默认开启。

## 13. 当前结论

A3 第一版证明 alias expansion 方向成立,但正式版必须治理三个风险:

- alias 质量风险:LLM 草稿必须人工 review。
- 短 alias 误触发风险:用 weak/strong 分层解决。
- serving 黑盒风险:必须接 trace 和 feature flag。

推荐下一步:先实施 registry 结构迁移和正式启用规则,不要急于扩大 alias 数量。

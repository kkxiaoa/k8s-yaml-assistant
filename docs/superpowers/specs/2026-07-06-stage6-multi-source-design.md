# Stage 6 多知识源融合设计：Policy Source 与冲突表达

- 日期：2026-07-06
- 状态：设计已确认，待转实施计划
- 主线：方案 §8（Stage 6 多知识源融合）

## 1. 背景与目标

Stage 6 从 schema 单源扩到多知识源。真正训练的是**多知识源冲突处理能力**，不是简单扩语料——同一问题下 K8s 官方事实（schema）与组织规范（policy）可能不一致，模型要能分层表达而非混为一谈。

本轮范围：先搭多源架构 + 接 **policy** 一类源。其余 doc/example 后续同法增量接入。

前置已达成（符合 §8.1“基础可测再扩”）：§7.2 judge 校准可复现达标（一致率 90.9%），§7.3 引用 grounding（答案带 `[S]` + source 元数据）。

## 2. 范围与非目标

范围：
- policy 单源接入 + `sourceType` 多源架构（为 doc/example 留位）。
- 检索加权（policy boost）+ 冲突表达（prompt）+ 分层 eval。

非目标：
- doc/example 源（后续增量）。
- **policy 参与 schema validation / check / fix**（本轮明确排除，见 §11 边界）。

## 3. 架构与数据流

```
data/policies.json
  → knowledge/policy-corpus.ts  buildPolicyCorpus() : policy → Chunk
  → knowledge/corpus.ts  CORPUS = [...schemaChunks, ...policyChunks]
  → retrieval/retrieve  (软加权 + POLICY_RELATED_BOOST) → rerank
  → server/pipeline + eval/faithfulness  (formatSources 标 sourceType + prompt 冲突表达)
  → eval  (retrieval / faithfulness / policy distinction / conflict 四层)
```

policy 复用 `Chunk` 接口 + 混进同一 `CORPUS`，下游 retrieve/rerank **不新造路径**（反碎片）。分叉只在源头（policy-corpus）、检索加权、生成 prompt、eval 四处。

## 4. Policy 数据形态

`data/policies.json`，10-20 条业界公认真实生产规范，标注为组织策略/平台规范（非 K8s 官方强制）。每条：

```json
{
  "id": "policy.deployment.resources.limits.required",
  "rule": "生产环境 Deployment 容器必须设置 resources.limits",
  "appliesTo": {
    "resource": "Deployment",
    "field": "spec.template.spec.containers.resources.limits"
  },
  "severity": "required",
  "scope": "prod",
  "rationale": "防止单容器耗尽节点资源",
  "sourceUri": "data/policies.json",
  "version": "2026-07-06"
}
```

- `severity`：`required | recommended | discouraged | forbidden`
- `scope`：`dev | staging | prod | all`（很多规范仅 prod 强制）
- `id`：点分命名（`policy.<resource>.<field>.<intent>`）
- `sourceUri` / `version`：来源与版本，供 source 元数据溯源

## 5. buildPolicyCorpus + CORPUS 合并

- `knowledge/policy-corpus.ts` 导出 `buildPolicyCorpus(): Chunk[]`。
- policy chunk 稳定标识（eval `expectedChunkIds` 依赖）：
  - `id = policy.id`（如 `policy.deployment.resources.limits.required`）
  - `title = 平台规范 · <resource> · <field>`
- policy chunk `text` 模板（末句显式标注，降低模型误当 schema 事实）：
  `[平台规范] {rule}。级别:{severity}。适用:{scope}。理由:{rationale}。(组织策略/平台规范,非 K8s 官方强制)`
- `sourceType='policy'`，`resource=appliesTo.resource`，`path=appliesTo.field`——天然吃现有 `boostResource`/`boostPath`。
- **元数据进接口字段，不靠 text 解析**：`Chunk` 扩 `sourceUri?` / `version?` / `trustLevel?`。
  - policy chunk：`sourceUri`/`version` 取 policy 字段，`trustLevel='org-policy'`。
  - schema chunk：`sourceUri` 由 ingestion 从 description 的 “More info” 提取后**填入字段**（现有 `extractSourceUri` 逻辑从检索期上移到构建期），`trustLevel='k8s-official'`。
- `Chunk.sourceType`：`'schema'` → `'schema' | 'policy'`（union）。`retrieval/sources.ts` 的 `SourceInput`/`Source` 同步扩 union + 上述元数据字段。
- `knowledge/corpus.ts`：`CORPUS = [...buildSchemaCorpus(), ...buildPolicyCorpus()]`。

**硬编码 `sourceType:'schema'` 迁移点**（writing-plans 显式处理）：
- `knowledge/schema-corpus.ts` — `Chunk.sourceType` 接口 + 构建时赋值
- `retrieval/sources.ts` — `SourceInput` / `Source`
- `server/pipeline.ts` — `Hit.sourceType` 声明、`finalHits` 里的 `as 'schema'` cast

## 6. 检索加权（Policy Boost）

- 常量 `POLICY_RELATED_BOOST = 0.04`（可解释参数，独立可调）。
- 触发条件：
  - `chunk.sourceType === 'policy'` **且** resource 匹配 `boostResource` → 轻加权。policy 问题常只有 resource 意图、没有 `cursorPath`（如“Deployment 镜像 tag 有什么要求?”），所以 **resource match 即加权**，不强制 path。
  - 若还有 `boostPath` 且 policy path 匹配 → 额外增强（可选叠加）。
  - resource 不匹配则不加（policy 不越资源抢占）。
- **不**基于 query 文本出现“必须/禁止/推荐”就全局抬 policy——否则用户问字段事实时 policy 抢占 schema。
- 轻加权只为保证相关 policy 挤进 top-k、不被 schema chunk 淹掉。

## 7. Source Precedence（呈现层次，非物理覆盖）

- 不改 context 物理顺序（rerank 分数为主）。
- `formatSources` 给 source label 明确来源类型：
  ```
  [S1][policy][组织策略] ...
  [S2][schema][K8s schema] ...
  ```
- precedence = 检索保证 policy 进场（§6）+ 生成层 prompt 表达层次（§8），不靠排序覆盖谁。

## 8. Prompt 冲突表达（核心）

`ASK_SYSTEM` / `ANSWER_SYSTEM` 加规则：

1. **分工**：schema = 官方事实（字段是否合法/能填什么）；policy = 组织建议（平台推荐/禁止怎么填）。
2. **冲突**：schema 允许但 policy 禁止/不推荐时，**同时说明**两层（措辞见 §9）。
3. **完整性**：问题涉及“能不能 / 是否允许 / 推荐吗 / 生产可用吗”，**必须同时检查 schema 与 policy 来源**；若缺 policy 来源，只答 schema 层事实 + 说明“未检索到组织规范”。
4. **红线**：不得把 policy 说成 K8s 官方强制，policy 一律标“组织策略/平台规范（非 K8s 官方强制）”，强度由 severity（required/forbidden/recommended/discouraged）表达。

## 9. 严谨性边界（schema 能证明什么）

schema 只能证明字段类型/枚举/required，**不能**证明某具体取值在 K8s 语义上“合法”。例如 `containers.image` 只被证明为 string，不能由 schema 证明 `nginx:latest` “合法”。

冲突表达统一措辞：

> “schema 层面 `image` 字段允许填写字符串，因此 `nginx:latest` 能通过字段类型校验；但组织 policy 不推荐/禁止 `latest` tag。”

避免“schema 合法”这类越界表述。

## 10. 分层 Eval

不塞进一个 judge 分数，拆 4 层——落在 2 个**现有**命令上（反碎片，不新造 eval 命令）：

- **retrieval eval**（`npm run eval`）：policy chunk 是否召回（policy case 标 `expectedChunkIds`，测 Recall@k）。
- **faithfulness eval**（`eval:faith` judge）：answer 是否忠于 sources。
- **policy distinction eval**（`eval:faith` judge 的 detail 字段）：是否区分 schema fact 与 policy recommendation。
- **conflict eval**（`eval:faith` judge 的 detail 字段）：是否同时表达合法性与组织限制。

即 distinction / conflict 是 faith judge verdict 上新增的布尔 detail，不是独立命令。

judge verdict detail 拆字段（供 bad case 归因）：

```
policyDistinguished: boolean       // 是否区分了 schema 事实与 policy 建议
conflictExplained: boolean         // 冲突是否同时说明两层
policyMisstatedAsOfficial: boolean // 是否误把 policy 当 K8s 官方强制
```

新 judge 维度按 §7.2 铁律**先校准再信**——建 policy 区分的 calibration case，达标一致率后才用其数字。

eval-set 扩充两类 case：
- 纯 policy：“平台对 Deployment 镜像 tag 有什么要求?” → expected = policy chunk。
- 冲突：“我能用 nginx:latest 吗?” → 答案须同时说 schema 类型校验通过 + policy 不推荐。

## 11. 架构边界（重要）

- 当前阶段 policy **只进 Ask / 解释 / faithfulness answer（RAG 问答链路）**，**不进 schema validation，也不进 YAML generate/fix**（gen/fix 不走 RAG context；policy compliance 强制执行是后续独立设计）。
- `validateResource()` 是 schema 驱动（不碰 `CORPUS`），`nginx:latest` 不报 schema error。
- 概念分离：`schemaErrors`（硬错误）≠ `policyViolations`（软建议）。
- 未来若 policy 强制执行，**另起独立 policy lint 层**，不塞进 `validateResource`。

## 12. 验收（§8.4 对照）

| §8.4 验收 | 本轮 |
| --- | --- |
| 能回答字段事实 | schema，已有 |
| 能区分官方事实和组织建议 | **policy distinction eval**（本轮核心） |
| 冲突正确表达 | **conflict eval**（本轮核心） |
| 能回答行为语义 / 给 YAML 示例 | doc/example，后续 |

## 13. 落地顺序

1. `data/policies.json`（10-20 条真实规范）+ `policy-corpus.ts` + `CORPUS` 合并 + `sourceType` union。
2. 检索加权（`POLICY_RELATED_BOOST` + §6 触发条件）。
3. `formatSources` source label + `ASK_SYSTEM`/`ANSWER_SYSTEM` 冲突表达。
4. eval-set policy case + 分层 eval 字段 + judge 区分维度校准。
5. 全绿（`tsc` + `npm test`）+ baseline 对比。

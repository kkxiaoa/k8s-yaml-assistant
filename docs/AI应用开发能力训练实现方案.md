# AI 应用开发能力训练实现方案

> 状态：当前执行依据。
> 最近核对：2026-07-21。
> 用途：维护当前能力状态、质量门禁和唯一执行顺序。具体数据契约由已确认的 design/spec 定义，不在本文重复维护。

## 1. 项目目标

本项目的第一目标不是做成完整 K8s AI 产品，而是：

**用 K8s YAML Authoring Copilot 这个真实场景，训练可迁移的 AI 应用开发能力。**

当前价值主张：

**在编辑器里，基于当前 YAML 和已摄取的知识来源，提供带依据、可拒答、可校验的字段解释、错误解释、生成与修复辅助。**

训练范围包括：

- schema、docs、policy、examples 的摄取与知识建模。
- semantic retrieval、query expansion、rerank 与上下文选择。
- grounded answer、拒答、引用和多来源冲突表达。
- Generate/Fix 的结构化输出、校验和 repair loop。
- eval、trace、baseline、bad case 与反馈回灌。
- 延迟、token、成本、缓存和失败诊断。

当前不承诺：

- 集群运行时排障、日志和事件分析。
- 自动执行 `kubectl` 或自治运维。
- 多集群治理和完整企业权限体系。
- 覆盖所有 Kubernetes/CRD 资源的成熟产品体验。

## 2. 执行原则

1. **先修尺子**：evaluator 或数据契约不可信时，不优化模型，不晋升 baseline。
2. **证据驱动**：功能、检索策略和知识源扩展必须由场景缺口或 bad case 触发。
3. **评估分层**：retrieval、grounded answer、judge、generation、fix 使用各自明确的 case contract，不用一个超大可选字段结构混算指标。
4. **线上线下共实现**：eval 与 serving 复用同一 semantic retrieval、query expansion、rerank 和来源格式化实现，但按测量对象使用不同 evaluator。
5. **来源不混淆**：知识形态、权威来源和适用资源分别建模，policy 不冒充 Kubernetes 官方事实，example 不替代 schema 校验。
6. **失败显式化**：来源不足、模型错误、judge 不可判定和基础设施异常必须分别记录，不能用默认成功值掩盖。
7. **反过拟合**：已知 bad case 用于回归，不用同一批调优样本证明泛化；保留不参与日常调参的 holdout。
8. **反玩具**：不以硬编码特例、简化 fixture、截断语料或送分题换取表面跑通。
9. **不维护无价值兼容**：ignored artifacts 可清理重跑；提交数据只做一次性迁移，迁移后删除旧兼容分支。
10. **方案先行**：每项能力先确认 design/spec，再拆 plan；每个 Task 完成后停下 review，未经用户要求不提交。

## 3. 当前事实快照

以下数字只是 2026-07-19 的工作区快照，不是永久规格。若与命令输出冲突，以命令输出为准。

### 3.1 Corpus

运行：

```bash
npm run corpus:stats
```

当前结果：

- `8,410` chunks。
- `28` 个 curated resources。
- `8,368` schema chunks。
- `42` policy chunks。
- 已注册 provider：`schema`、`policy`。
- 尚未注册真实数据 provider：`docs`、`example`。
- `data/schemas/curated.json` 显式包含 2 个真实集群 CRD（自定义资源定义）：`gateway.networking.k8s.io/v1 HTTPRoute` 和 `cert-manager.io/v1 Certificate`。
- corpus identityVersion（语料身份版本）为 `2`，manifest hash（清单哈希）为 `82621edc73530dffc86e21fe6488a332e98f7d2e1efba3d0d995e7b66fb880c4`。
- 现有 `data/index` 仍是 `8,127` chunks 的 v2 索引；在线加载器现要求 v5 索引格式和 knowledge identity v2（知识身份版本 2），因此当前以 `format_mismatch` 失效。默认 `voyage-3` 的 v5 index expectation hash（索引期望哈希）为 `fc5b2110fea1339106aacc3829ac19404dab4dc1c9d81ae26c63fa11119ed15a`，8,410 条新索引尚未重建。

### 3.2 Eval 数据

当前数据集由 `npm run eval:check` 核对：

| 数据集 | 数量 | task（任务） | origin（来源） | role（角色） |
|---|---:|---|---|---|
| Semantic Retrieval（语义检索） | 83 | field_explanation=74，policy_explanation=9 | human=83 | development=71，regression=11，holdout=1 |
| Grounded Answer（有依据回答） | 88 | field_explanation=74，policy_explanation=9，error_explanation=2，refusal=3 | human=88 | development=76，regression=11，holdout=1 |
| Generation（生成） | 27 | generation=27 | human=27 | development=26，holdout=1 |
| Fix（修复） | 9 | fix=9 | human=9 | development=8，holdout=1 |

- Grounded Answer 由 83 条 retrieval 引用、2 条真实 validation error（校验错误）解释和 3 条独立拒答组成。
- Retrieval/Grounded Answer 的 Holdout（留出集）是 `Certificate.spec.issuerRef`；Generation 是 DaemonSet；Fix 是 HPA `spec.maxReplicas` 类型修复。
- 当前 origin 仍缺 `schema_generated` 和 `bad_case` 样本。这是实际分布，不为填满分桶新增送分题。
- 错误解释自动门禁覆盖真实 Fix fixture（修复夹具）、validator（校验器）、Ask 检索与 Faithfulness（忠实度）；correctness（正确性）和完整性尚未完整自动覆盖，首次 full trace（完整集轨迹）必须人工审核。
- 资源值断言、跨资源关系、修复保留/副作用检查和 fixture preflight（夹具预检）已进入 evaluator（评估器）；正式指标仍待新版本 full run（完整集运行）验证。

### 3.3 能力状态

| 能力 | 状态 | 当前边界 |
|---|---|---|
| Monaco YAML 工作流与 `ask/check/gen/fix` | 已完成基础闭环 | 继续以编辑器 YAML authoring 为唯一产品场景 |
| schema ingestion、`$ref` registry、curated corpus | provenance、targets、版本化 ID 和 corpus/index identity 已纠偏 | 尚未接入 docs/example provider，真实 CRD 样本不足 |
| dense retrieval、rerank、query expansion serving | 已完成基础能力 | 历史指标需在新 evaluator 下重测，不能直接沿用 |
| run/trace/baseline/bad case | runtime protocol、metric registry、compare/promote 门禁已实现 | 新 baseline 尚未重建，usage/cost 尚未贯通 |
| Generation/Fix repair loop | evaluator 已验证目标值、资源关系、保留项和副作用 | 尚未执行新版本 full eval/baseline |
| `[S]` 引用、schema/policy 分层 | 部分完成 | answer correctness 与 claim-level verification 未完成 |
| Stage 6 policy | 已完成 Ask 侧接入 | docs/examples 与 Generate/Fix policy compliance 未完成 |
| Stage 7 离线 feedback | retrieval/faith bad case 前置已完成 | serving feedback、采纳信号和审核式回灌未完成 |

## 4. 当前质量契约

本节只维护稳定原则。字段级契约以 `docs/superpowers/specs/2026-07-12-*.md` 为准。

### 4.1 Eval Artifact Protocol

一次 eval 的证据链必须是：

```text
dataset/config/model/corpus identity
  -> EvalRun
  -> per-case TraceEnvelope
  -> metrics
  -> baseline / bad case
```

要求：

- `EvalRun` 是判别联合，`kind/status/scope/dataset/artifactPaths` 等关键字段不可静默缺失。
- run 只保存相对 `data/eval/` 的可移植路径。
- 每条 trace 有稳定 `traceId/runId/evalCaseId/kind/outcome`。
- runner 启动先写 `running`，完成写 `completed`，异常写 `failed`。
- run、trace、baseline、bad case 读取都经过 runtime decoder。
- bad case 只引用可解析的真实 trace，不承担临时 trace 的职责。
- serving trace 与 eval artifact 分流；serving trace 写入失败不能拖垮 Ask。

设计依据：

- `superpowers/specs/2026-07-12-eval-artifact-protocol-design.md`

### 4.2 Metric Semantics

每个稳定指标必须定义：

- 测量对象和 evaluator kind。
- 越高越好、越低越好或 neutral。
- 单位、分子和分母。
- 空样本时是 `N/A`，不能伪装为 0% 或 100%。

Compare 和 baseline 要求：

- dataset hash、metric definition version 或 kind 不一致时，不输出改进/退化结论。
- baseline 有而当前缺失的稳定指标属于 harness 缺口，不能静默跳过。
- 所有 runner 在写 completed run 前统一校验 metric registry、required completeness、observation contract 和 definition version。
- retrieval、faith、generation、fix 只允许 full run 晋升；judge 只允许完整 calibration run 晋升。
- 只有 `completed`、trace selection 完整且 harness error 为 0 的 run 才能晋升；不提供 error override。
- baseline 晋升始终由人工显式执行。
- baseline 只保存 dataset、metrics 和参与比较的 config identity，不引用 source run/trace 路径。

设计依据：

- `superpowers/specs/2026-07-12-eval-metric-semantics-design.md`

### 4.3 Evaluator Validity

#### Semantic Retrieval

- 使用 self-contained question 评估 `searchCorpusTraced()`。
- 测量 dense、routing、query expansion、coarse candidate 和 rerank 的 Recall/MRR。
- 不注入 `EditorContext`，不把 exact-field 短路计入 semantic retrieval 指标。

#### Editor Context Retrieval

- `kind + cursorPath -> exact-field -> fallback search` 是 serving 分流能力。
- 当前使用确定性 pipeline 测试覆盖，不单独建立 run/baseline。
- 只有出现大量 serving bad case、需要统计 exact/fallback rate 或离线回放时，才新增独立 ServingRetrieval evaluator。

#### Grounded Answer

- 可以引用 retrieval case，但必须显式声明期望行为和必需来源类型。
- trace 保存实际发送给生成和 judge 的 context/source snapshot，不能从未来 corpus 重建旧上下文。
- Faithfulness、answer correctness、relevance、completeness 和 refusal correctness 是不同维度，不能用 faithful 一个指标代替全部答案质量。

#### Judge

- 严格解析输出，字符串布尔值、缺字段和非法数组项都是无效票。
- 记录计划票数、有效票、失败票和失败原因。
- 默认 5 票，至少 3 票有效才形成结论；平票返回不可判定。
- 新维度先用真实 pipeline 样本进行人工校准，再进入正式指标。

#### Generation/Fix

- Generation 断言绑定到明确资源，既检查 path，也检查值、集合和跨资源关系。
- 一致性检查先确认参与资源存在且唯一，缺少关系任一端都失败。
- Fix 在调用模型前执行 fixture preflight，确认输入确实包含声明缺陷。
- Fix 同时检查目标资源、预期修正、意图保留和额外副作用。
- YAML parse 和 schema validation 只证明结构合法，不等同于 admission、运行时或业务语义正确。

设计依据：

- `superpowers/specs/2026-07-12-evaluator-validity-design.md`

### 4.4 Eval 数据治理

Case 至少有三个独立维度：

| 维度 | 建议值 | 用途 |
|---|---|---|
| task | field、error、free、refusal、crd、generation、fix | 区分测量对象 |
| origin | human、schema_generated、bad_case | 说明样本来源 |
| role | development、regression、holdout | 区分调优、回归和泛化验证 |

规则：

- schema 派生题用于覆盖诊断，不与真实用户问题混成唯一总指标。
- bad-case case 用于证明问题不再复发，不单独证明方案可泛化。
- holdout 不参与日常 prompt、alias、boost 或 rerank 调参。
- 每次报告至少按 task/origin/role 分桶，不能只展示一个整体 Recall。
- 数据集变化必须产生新 hash；新旧数据集不能直接宣称指标提升。

## 5. 知识与检索架构

### 5.1 Knowledge Model

知识形态和权威来源分开建模：

- `sourceType`：`schema | docs | policy | example`。
- `provenance`：Kubernetes 官方、当前集群、厂商、组织或人工 curated。
- `targets`：成对记录 `apiVersion/kind/path`，不再并行维护多套 resource/path 字段。

Corpus 与索引要求：

- provider 产出覆盖提供方身份和完整 canonical chunks（规范知识片段）的 manifest hash（清单哈希），corpus manifest hash（语料清单哈希）只组合排序后的 provider manifest hash（提供方清单哈希）。
- chunk ID 在全 corpus 唯一，并区分必要的 source/apiVersion/kind/path。
- 任意 chunk 内容或 metadata（元数据）变化都会更新 corpus/index identity（语料 / 索引身份）；当前没有独立向量复用身份，索引失效后按完整产物重建。
- serving、eval、index build、corpus stats 共用同一 identity 实现。
- CRD schema 不得标成 Kubernetes 内置官方 schema。

设计依据：

- `superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md`

### 5.2 Source Authority

不存在统一的 `policy > schema > docs > examples` 排序。来源按事实域分工：

| 问题 | 主要依据 | 约束 |
|---|---|---|
| 字段是否合法、类型、枚举、required | 与目标版本匹配的 schema | 只说明结构事实 |
| 行为语义、使用条件、限制 | 与目标版本匹配的官方 docs | 不覆盖 schema 结构事实 |
| 平台推荐、禁止、合规要求 | organization policy | 必须明确是组织规则 |
| YAML 写法与组合方式 | 可追溯 example | 示例不能替代事实或校验 |

检索排序负责相关性，生成层负责来源分工和冲突表达。只有 bad case 证明 top-k 容量竞争时，才设计 source quota 或 source-aware selection。

### 5.3 Ingestion 要求

新增 docs/examples provider 前必须定义：

- 来源 URI、文档锚点、版本、采集时间和许可证边界。
- 与目标 Kubernetes/schema 版本的匹配规则。
- chunking、去重、更新、删除和重建策略。
- 内容清洗和 prompt injection 边界，检索内容始终作为数据而不是系统指令。
- 对应的 retrieval、grounded-answer 或 Generation/Fix eval case。

资源覆盖继续通过 ingestion pipeline 和 generated registry 扩展，不手工维护大规模 schema。

### 5.4 Retrieval 决策

当前保留：

- dense retrieval。
- resource/path 软加权。
- Voyage rerank。
- reviewed alias 驱动的跨语言 query expansion。
- serving 与 eval 共用 semantic retrieval 实现。

后续规则：

- 先在纠偏后的 evaluator 下复测历史 retrieval/rerank bad case。
- 只有仍稳定复现的 rerank miss 才进入 rerank 候选、打分或父子 chunk 竞争优化。
- alias 只按真实 bad case 和高价值工作流字段分批扩展，每批必须经过人工 review 和 full eval A/B。
- BM25/RRF 只在同语言关键词、标识符或枚举精确匹配型失召回被 trace 证明后实施。
- 不因“Hybrid 是常见做法”而无条件引入。

## 6. 能力阶段状态

Stage 是能力分类，不代表执行时序。

| Stage | 能力主题 | 当前状态 | 未完成出口 |
|---|---|---|---|
| 0 | Scope 与评估代表性 | curated 28 resources、治理分层和首批 Holdout 已落地 | 用新版本 full run 验证代表性并人工审核错误解释 |
| 1 | YAML Copilot 工作流 | 基础闭环完成 | 持续保持 editor-context 场景，不扩张产品叙事 |
| 2 | 质量工程底座 | artifact/metric/evaluator/provenance/governance 契约已纠偏 | 重建正式 baseline；贯通 usage/cost |
| 3 | 检索优化 | query expansion 已落地，Hybrid 未触发 | 新 baseline 下复测 rerank；证据触发后再选方案 |
| 4 | Generate/Fix | case contract、关系断言、fixture preflight 和指标语义已纠偏 | 执行新版本 full eval 并审核 baseline |
| 5 | Grounding/Judge | `[S]` 引用和 policy judge 基础已有 | judge 重新校准；answer quality 分维度；Claim-level Grounding |
| 6.1 | Policy | Ask 侧已完成 | Generate/Fix policy lint 需独立设计 |
| 6.2 | Official Docs | 未开始 | provider、版本化 ingestion、behavior eval |
| 6.3 | Examples | 未开始 | provider、Generation/Fix 接入与收益评估 |
| 7.1 | 离线 feedback | retrieval/faith bad-case 前置已有 | 在新 artifact 协议下重验 |
| 7.2 | 反馈闭环成熟化 | 未开始 | serving feedback、采纳信号、审核式回灌和对比报告 |

## 7. 唯一执行顺序

### Phase A：质量底座纠偏（结构实现完成）

1. 已完成：四份 2026-07-12 纠偏设计及其一对一实施计划已交叉自审并落盘。
2. 已完成：Eval Artifact Protocol（评估产物协议）已实施并完成审核。
3. 已完成：Knowledge Provenance / Corpus Identity（知识来源 / 语料身份）与 Evaluator Validity（评估器有效性）已实施并完成逐任务审核。
4. 已完成：Metric Semantics（指标语义）注册表、N/A（不适用）/ 分母、比较、晋升和全评估框架本地门禁已经实施并完成逐任务审核；正式 baseline（基线）重建不属于结构实现完成条件。
5. 当前边界：未执行真实模型评估，未晋升任何 baseline（基线），不根据旧指标优化检索、提示词或模型。
6. 已完成提交数据的一次性 canonical identity（规范身份）迁移；ignored runs/traces（被忽略的运行 / 轨迹产物）不兼容读取，正式评估前按当前身份清理重建。

### Phase B：工程收尾与重建尺子（结构完成，正式重建暂缓）

1. 已完成：收敛 test runner（测试运行器）、根 README 命令入口和 scripts inventory（脚本清单）；当前没有证据支持删除脚本，不新增平行 CLI（命令行界面）文档。
2. 已完成：清理 docs（文档）状态和引用，不让历史文档覆盖当前路线。
3. 已完成：工程清理登记的 Deferred Risk Closure（延期风险收敛）第 1-6 项均已核对、处理并完成审核。
4. 已完成：Case Governance（评估用例治理）已贯通 case contract、artifact、suite、泄漏门禁和分桶报告。
5. 已完成：补入 2 条真实错误解释、2 个真实 CRD（自定义资源定义）主题和 Retrieval/Grounded Answer、Generation、Fix 的首批 Holdout（留出集）。
6. 当前暂停项：清理 ignored artifacts（被忽略的产物），重建或复用与发布候选完全一致的 8,410 条 index（索引）和 run artifacts（运行产物），依次运行 retrieval、faith、judge、generation、fix（检索、忠实度、裁判、生成、修复）评估；该项在生产部署计划的公开前质量闸恢复。
7. 首次 full（完整集）评估必须人工审核错误解释 trace（轨迹）的 correctness（正确性）和完整性；只在人工审核指标、trace 和 bad case（问题用例）后晋升各 kind baseline（类别基线）。

### Production Deployment（生产部署，当前优先插入主线）

1. 已完成并审核：`superpowers/specs/2026-07-19-k3s-production-deployment-design.md`，明确华为云单机 K3s（轻量 Kubernetes）、GHCR（GitHub 容器镜像仓库）、单人 draft Release（草稿发布版本）人工确认、生产 self-hosted runner（自托管运行器）、镜像内置索引、private/portfolio（私有 / 作品集展示）双模式和安全 observation（观测）边界。
2. 已完成并审核：Phase 0（阶段 0）本地与服务器只读审计；Phase 1（阶段 1）的固定版本 K3s（轻量 Kubernetes）变更包、安装加固和节点外分离备份。非敏感证据记录在 `deploy/k3s/README.md`。
3. Phase 2（阶段 2）的 Task 5-10（任务 5-10）已审核；Task 11（任务 11）的本地发布契约和流水线门禁等待审核。在线索引使用共享连续 `Float32Array` 和 fail-closed（失败关闭）加载，当前索引契约为 knowledge identity v2（知识身份版本 2）与 index format v5（索引格式版本 5），并通过文件哈希验证 `chunks.jsonl` 和 `embeddings.f32`。个人私有 GitHub remote（GitHub 远程仓库）和 `main` 规则集已建立；尚未调用模型构建 8,410 条发布索引，也未创建生产镜像、应用 Kubernetes（容器编排系统）资源或公网入口。
4. 私有部署和受限入口验证通过后，在公开发布前恢复 Phase B（阶段 B）正式质量重建；新 baseline（基线）审核通过或形成显式风险接受记录后，才进入公开发布。
5. 部署完成后返回 AI 应用训练主线；部署不把项目扩张为通用 Kubernetes 运维平台。

### Phase C：剩余质量债

1. 贯通 embedding、rerank、answer、judge 的 raw usage，并记录 pricing/version 后再计算 cost。
2. 在新 baseline 下重新判断仍存在的 retrieval/rerank bad case。
3. 有证据时设计 rerank 优化；无同语言关键词证据时继续不做 BM25/RRF。
4. 按 ROI 扩展 reviewed alias，不做 Pod/Deployment 全字段 alias。

### Phase D：Stage 6.2 Official Docs

1. 从 schema 无法回答的行为语义、使用条件和限制 case 出发定义范围。
2. 实现 versioned docs provider、manifest、chunking、引用锚点和更新策略。
3. 增加 docs retrieval 与 grounded-answer cases。
4. 证明新增知识源提高目标 case，且不破坏 schema/policy 分层。

### Phase E：Stage 6.3 Examples

1. 选择可追溯、版本匹配的 YAML example 和反例。
2. examples 进入统一 corpus，但按 task-aware context selection 服务 Generate/Fix。
3. 用资源值断言和跨资源关系 eval 验证收益。
4. 若 policy 需要约束 Generate/Fix，另设 policy lint/compliance 层，不塞进 schema validation。

### Phase F：Stage 5.3 Claim-level Grounding

1. 定义可解析的 claim 与 citation reference。
2. 实现 claim extraction、claim-source verification 和 unsupported claim 输出。
3. 对 claim extractor 和 verifier 分别校准，避免用未经验证的 LLM judge 验证另一个 LLM。
4. 同时报告 groundedness、correctness、relevance、completeness 和 refusal correctness。

### Phase G：Stage 7 反馈闭环成熟化

当前安全 Ask serving observation（询问在线观测）子能力已完成实现并通过部署 Task 6 review（任务 6 审核）；这不修改上方 Stage 7.2（阶段 7.2）的“未开始”状态。该子能力也不包含 answer feedback（回答反馈）、Generate/Fix（生成 / 修复）采纳信号、审核式回灌或闭环报告。

1. 定义 serving observation envelope 和 request correlation，不复用 eval run 语义。
2. 记录 query、source、answer、latency/cost 前先实现 Secret/token/YAML 敏感字段脱敏。
3. 明确默认开关、采样、保留周期、删除机制和本地/远程边界。
4. 接入 UI feedback 和 Generate/Fix 采纳信号。
5. 反馈先生成可审核候选，人工确认后进入 bad case 或新 eval case。
6. 输出按失败类型、修复状态和版本变化的闭环报告。

### Phase H：全量语料规模化训练（后期）

只有前述质量链路稳定后才进入：

- 从 curated corpus 切到版本固定的全量 schema/CRD snapshot。
- 若数据源或集群版本变化，重新 ingestion，不假设旧 generated 永久有效。
- 量化 Recall、MRR、延迟、内存、索引构建时间和成本退化。
- 再根据规模证据选择 binary index、SQLite/vector extension、LanceDB 或真实向量库。

## 8. 每个 Task 的完成定义

一个 Task 只有同时满足以下条件才算完成：

- design/spec 已确认，代码没有越出范围。
- 正常路径、反例和失败路径均有测试。
- 运行时数据经过校验，不依赖 TypeScript 类型断言伪造安全性。
- 变更涉及 evaluator 时，有反例证明旧误判已被修复。
- 变更涉及 retrieval、prompt、model、corpus 或 generation 时，有同版本 dataset 的 baseline diff。
- trace 足以判断失败发生在数据、retrieval、rerank、context、generation、validation、judge 还是 harness。
- 真实模型验证前说明调用范围和成本；模型波动需要重复运行或报告不可判定。
- 文档只记录当前约束和可验证事实，历史过程放入 commit、PR 或学习复盘。
- 完成后停下汇报，等待用户 review；不自动 commit，不自动 promote baseline。

## 9. 当前验收目标

本轮训练项目达到以下状态，才说明质量底座真正可用：

- 任意一次 eval 都能从 run 定位 dataset、模型、corpus、trace、metrics 和 bad case。
- 每个指标都能解释方向、分母、适用范围和不可比较条件。
- retrieval、grounded answer、judge、generation、fix 的 evaluator 不再互相借用错误语义。
- 已知 bad case 能稳定回归，holdout 能独立反映泛化。
- schema、docs、policy、example 的来源和事实边界可解释。
- 生成和修复不仅能通过 YAML/schema，还能验证需求值与跨资源关系。
- 来源不足时系统能拒答，来源冲突时能分层表达。
- 每次优化都能用证据说明收益、代价和剩余风险。

达到这些标准，才进入更大语料和更复杂产品能力，而不是反过来用功能数量掩盖质量问题。

## 10. 当前设计依据

- `docs/superpowers/specs/2026-07-12-eval-artifact-protocol-design.md`
- `docs/superpowers/specs/2026-07-12-eval-metric-semantics-design.md`
- `docs/superpowers/specs/2026-07-12-evaluator-validity-design.md`
- `docs/superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md`
- `docs/superpowers/plans/2026-07-10-eval-harness-source-hardening.md`：仅保留第一轮 Task 1-8 的实施记录，不作为后续实现依据。

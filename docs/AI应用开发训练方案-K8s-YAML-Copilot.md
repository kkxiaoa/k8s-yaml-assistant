# AI 应用开发训练方案：K8s YAML Copilot

> 状态：当前项目定位依据。
> 用途：定义训练目标和能力边界；动态实现状态、质量契约和执行顺序只在 `AI应用开发能力训练实现方案.md` 维护。

## 1. 核心定位

本项目的第一目标是：

**用 K8s YAML Authoring Copilot 这个真实场景，系统训练 AI 应用开发能力。**

它不是泛化 Kubernetes 智能平台，也不是以覆盖全部 K8s 运维知识为目标的聊天机器人。

训练场景集中在用户编写 YAML 的工作流：

- 解释当前字段、配置和校验错误。
- 检查并修复 YAML。
- 根据自然语言生成一个或多个资源。
- 给出可追溯的答案依据。
- 在资料不足时拒答或明确说明边界。

产品化用于保证训练场真实，不是当前唯一成功标准。

## 2. 为什么选择这个训练场

K8s YAML Copilot 同时具备 AI 应用训练所需的关键条件：

- 有真实、结构化、可版本化的 OpenAPI/schema。
- 有 Kubernetes 官方文档、CRD 厂商资料、组织策略和 YAML 示例等多类知识源。
- 有当前 YAML、光标、选区和 validation errors 等真实上下文。
- 有 parse、schema validation 和跨资源关系等确定性校验手段。
- 有检索问答、结构化生成、工具调用和 repair loop 等不同 AI 任务。
- 有可以持续沉淀的 eval、trace 和 bad case。

这个场景足够复杂，可以训练真实工程能力；又足够收敛，不需要先建设完整运维平台。

## 3. 三层目标

### 3.1 第一目标：AI 应用工程能力

需要掌握的能力包括：

- ingestion、标准化、chunking、metadata 和 provenance。
- dense retrieval、query expansion、rerank 和条件触发的 sparse/hybrid retrieval。
- context engineering、来源选择、引用、拒答和多来源冲突表达。
- structured generation、tool use、validation 和 repair loop。
- retrieval、grounded answer、judge、generation、fix 的 evaluator 设计。
- run、trace、baseline、bad case 和反馈回灌。
- 延迟、token、成本、缓存、隐私和失败诊断。

这些能力应能迁移到 K8s 以外的 AI 应用，而不是只会维护当前项目的特例。

### 3.2 第二目标：真实用户工作流

训练必须锚定编辑器中的 YAML authoring：

- Ask 使用当前 YAML 和编辑器上下文，而不是要求用户重复复制资料。
- Check/Fix 处理真实 parse/schema 错误并保留用户意图。
- Generate 处理具体值和多资源关系，不只生成形式正确的 YAML。
- Sources 能回到真实知识片段，不能只是装饰性链接。
- 失败和拒答在 UI 与 trace 中都可解释。

### 3.3 第三目标：保留产品意识

真实产品约束用于防止训练项目变成玩具：

- 用户能否在编辑器里完成任务。
- 结果是否可靠、可理解、可撤销。
- 延迟和成本是否可接受。
- 日志是否会泄露 Secret、token 或内部配置。
- 反馈是否能转化为可复现问题和新 eval case。

当前不以商业化、市场份额或完整平台能力作为验收条件。

## 4. 能力地图

能力地图描述“需要练什么”，不表示当前状态或执行顺序。

### 4.1 Knowledge Engineering

- 从 Kubernetes OpenAPI、集群 discovery 和 CRD ingestion schema。
- 区分知识形态与权威来源。
- 为 schema、docs、policy、example 建立 provider 和 manifest。
- 处理版本、URI/anchor、许可证、去重、更新和删除。
- 保证 corpus、index、serving 和 eval 使用同一 identity。

### 4.2 Retrieval 与 Context

- 结构化 schema chunking。
- semantic retrieval 与 metadata-aware soft boost。
- reviewed alias 驱动的跨语言 query expansion。
- rerank、候选集治理和 top-k context selection。
- exact editor path 与 semantic search 分层。
- 仅在 bad case 证明需要时引入 sparse/hybrid retrieval。

### 4.3 Grounded Answer

- 答案引用实际进入上下文的来源。
- 区分 schema 结构事实、docs 行为语义、policy 组织约束和 example 示例作用。
- 来源不足时拒答，不补写未被支持的默认值或结论。
- 分别评估 groundedness、correctness、relevance、completeness 和 refusal correctness。
- 对 Claim-level extraction 和 verification 自身进行校准。

### 4.4 Generate/Fix

- 将自然语言和编辑器上下文转换成结构化生成任务。
- 生成后执行 YAML parse 和 schema validation。
- 将确定性错误反馈给模型形成 repair loop。
- 验证字段值、用户意图和多资源引用关系。
- 将 policy compliance 与 schema validation 分层处理。

### 4.5 Quality Engineering

- 每个 evaluator 有独立、有效的 case contract。
- run、trace、metric、baseline 和 bad case 形成可解析证据链。
- 指标有方向、单位、分母、空样本和可比较条件。
- development、regression、holdout 分工明确。
- LLM-as-judge 先校准，再进入正式指标。
- 模型、网络和 harness error 不进入质量指标分母，但必须被记录。

### 4.6 Feedback 与 Observability

- serving observation 与 eval artifact 分流。
- query、sources、answer、latency、usage 和 error 可关联。
- UI feedback 和 Generate/Fix 采纳信号形成可审核候选。
- 人工确认后再进入 bad case 或 eval，避免噪声自动污染数据集。
- 敏感 YAML、Secret 和 token 在落盘前脱敏，并定义采样和保留周期。

## 5. 当前不做什么

- 不做集群运行时排障、日志和事件分析。
- 不做自动执行 `kubectl` 或自治修复。
- 不做多集群治理和完整企业权限体系。
- 不为了展示能力数量而无条件接入 Agent 框架、Hybrid、知识图谱或向量数据库。
- 不用覆盖全部 Kubernetes/CRD 作为训练成功标准。
- 不用流畅但无法验证的答案替代证据和拒答。

这些方向可以作为后续产品化课题，但不能打断当前质量主线。

## 6. 成功标准

项目阶段性成功，不是“功能很多”，而是能够做到：

- 讲清楚一次请求从 ingestion 到 answer/repair 的完整链路。
- 定位错误发生在数据、retrieval、rerank、context、generation、validation、judge 还是 harness。
- 用有效 eval 和同版本 baseline 证明改动的收益与代价。
- 区分已知 bad case 回归与未知问题泛化。
- 让知识来源、答案主张和引用之间可追溯。
- 让 Generate/Fix 结果通过结构、值和跨资源关系验证。
- 让用户反馈进入受控、可审核的迭代闭环。
- 将这些方法迁移到其他 AI 应用场景。

达到这些标准，就完成了当前阶段的目标：

**用 K8s 场景训练自己成为 AI 应用开发者。**

## 7. 执行入口

- 唯一实施 roadmap：`docs/AI应用开发能力训练实现方案.md`
- Agent 工程规则：`AGENTS.md`
- 文档状态索引：`docs/README.md`
- RAG 评估参考：`docs/RAG能力训练评估报告.md`
- 学习复盘：`docs/RAG-复盘-01-*`、`docs/RAG-复盘-02-*`、`docs/RAG-复盘-03-*`

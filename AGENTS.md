# AGENTS.md

## 项目方向

本项目当前不是以“做成完整 K8s AI 产品”为第一目标，而是：

**用 K8s 场景训练自己成为 AI 应用开发者。**

训练场景收敛为：

**K8s YAML Authoring Copilot**

当前价值主张：

**在编辑器里，基于当前 YAML 和集群 schema，提供带依据、可拒答、可校验的字段解释、错误解释、生成与修复辅助。**

不要把当前阶段定位成泛化的 Kubernetes AI 平台，也不要定位成通用 K8s 知识库聊天机器人。当前场景应围绕用户在编辑器里编写、理解、检查、修复和生成 Kubernetes YAML 展开。

## 当前不承诺

第一阶段不要承诺：

- 集群运行时排障
- 多集群治理
- 日志 / 事件分析
- 自动执行 `kubectl`
- 完整 Kubernetes 运维助手能力
- 覆盖所有 Kubernetes / CRD 资源的成熟产品体验

这些能力可以作为后续产品化方向，但不是当前训练项目的验收标准。

## 训练原则

1. 训练场必须锚定当前 YAML 编辑工作流。
2. 优先提供有依据的答案，而不是流畅但不可验证的回答。
3. schema 是字段事实层，不是完整知识库。
4. 不要靠手工维护资源覆盖；资源覆盖应通过 ingestion pipeline 扩展。
5. 不用“产品成熟”作为当前验收标准，而用可测、可追踪、可诊断、可迭代、可证据化作为验收标准。
6. 失败要显式表达：如果来源不足，要说明不足并展示已检索到的内容。
7. 先修尺子，再追求指标；先解释 bad case，再追求指标提升。
8. RAG 检索层和 Generate / Fix 生成层都必须可评估，不能只训练检索。

## 当前状态

当前项目已经具备真实训练场基础：

- `ask / check / gen / fix` 已形成编辑器工作流闭环。
- schema ingestion、curated corpus、dense retrieval、rerank 和 query expansion 已落地。
- Generation/Fix 已有 agentic repair loop 和独立 eval runner。
- Ask 已有 `[S]` 引用、schema/policy 分层和冲突表达。
- retrieval/faith bad case 已具备离线沉淀入口。

当前最高优先级不是扩功能，而是修正质量底座。2026-07-10 harness 计划的 Task 1-8 已完成第一轮结构实现，但 correctness review 发现以下契约仍不可信：

- EvalRun、trace、baseline 与 bad case 的关联和生命周期。
- 指标方向、分母、空样本、可比较性和 baseline 晋升门禁。
- retrieval、faith、judge、generation、fix 的单 case 判定有效性。
- knowledge provenance、targets、corpus identity 与 index 失效边界。

纠偏完成前，不晋升 baseline，不根据当前指标继续优化 retrieval、prompt 或模型。

## 当前执行优先级

唯一执行路线维护在 `docs/AI应用开发能力训练实现方案.md`，Stage 编号只表示能力分类，不表示时序。

1. 按顺序实施四份已自审的 `2026-07-12` corrective plans；当前从 Eval Artifact Protocol 开始。
2. 完成 test runner、命令入口、scripts 和 docs cleanup，建立 eval case 的 task/origin/role 分层和 holdout。
3. 清理 ignored artifacts、重建 index，重跑 retrieval/faith/judge/generation/fix 并人工审核 baseline。
4. 贯通 token/usage/cost，在新尺子下复测仍存在的 retrieval/rerank bad case。
5. 接入 Stage 6.2 official docs，再接 Stage 6.3 examples。
6. 在多源 provenance 和 judge 稳定后实施 Claim-level Grounding。
7. 最后成熟化 Stage 7 serving feedback、采纳信号和审核式 eval 回灌。

长期约束：

- BM25/RRF 仅由同语言关键词型失召回证据触发，不作为默认路线。
- schema/docs/policy/example 使用 `sourceType + provenance + targets` 表达，不使用全局来源优先级覆盖事实边界。
- Generation/Fix 必须验证目标值和跨资源关系，不能只检查 kind/path 存在。
- serving 日志或反馈落盘前必须定义敏感 YAML/Secret 脱敏、采样和保留周期。

## 工程规则

- **禁止玩具思维落盘（最高优先）**：落盘的内容必须是当前阶段的真实工程形态，不得为了快速跑通而沉淀简化、占位或硬编码版本——例如手写少字段 schema 覆盖真实 ingestion 产物、storage-only 的 fallback 资源集、`CORPUS.slice(0, N)` 截断语料、单资源特判。临时方案必须显式标注边界并征求用户同意，不能悄悄变成既成事实。核实到历史玩具残留（如 `FIXTURE_SCHEMA_DOCS` 覆盖层、`FALLBACK_RESOURCES` / `chunksForResource` 硬过滤、旧 `validateStorageClass` / `submit_storageclass` 注释）应一并清退，不得在其上继续叠加，避免影响后续落盘。
  - **落盘前过三闸（2026-07 复盘）**：① 反碎片——能复用/扩展已有（eval-set / getClient / pipeline / 共享模块）就别另造平行物；② 反玩具——评估类高分先怀疑题太简单，校准/eval 输入要来自真实 pipeline 而非手写送分题；③ 难就说难——真活难/模糊时不发简单替身，做难的或停下问。另：别从带 `main()` 的 runner 文件 import（会触发跑批），共享代码放无副作用模块。
- 变更应贴合现有 TypeScript / Next.js / Monaco 结构。
- `ask / validate / generate / fix` 尽量复用 schema 派生数据。
- 检索、生成、拒答、修复都必须可评估；改 retrieval、prompt、generation 或 fix 行为时，要同步考虑 eval 和 baseline diff。
- 不要引入过宽抽象，除非它直接服务当前训练阶段。
- 方案落盘时优先采用业界通用、可维护的实现方式；如果只是临时方案、自研替代成熟方案，或预期收益不高，执行前应先说明取舍并征求用户意见。
- 保持 schema 事实、文档说明、示例模板、组织策略之间的边界。
- 来源不足时不要静默编造答案。
- 不要手动扩充大规模 schema import；资源覆盖应通过 ingestion pipeline 和 generated schema 目录完成。
- 当前阶段优先把问题变得可测、可诊断、可复现，再追求覆盖更多能力。
- docs 目录必须有状态分层。历史归档、学习复盘、评估报告不能覆盖当前执行依据；新增或修改文档时必须标明状态和用途。清理 docs 前先查引用，不确定时归档，不直接删除。

- **注释精准铁律（最高优先）**：注释必须精准、客观、可验证，只解释“为什么”和非显然约束；禁止写对话上下文、阶段性决策过程、方案对比、历史演变、情绪化判断或已被代码直接表达的信息。迭代背景进 commit / PR / docs，不进代码注释。发现旧注释与当前实现不一致、过期、含糊或污染上下文时，应优先修正或删除，不能继续在其上叠加新注释。文档同样避免长铺垫，提示用简短 tips。

## 参考文档

当前训练方案：

`docs/README.md`

`docs/AI应用开发训练方案-K8s-YAML-Copilot.md`

实现路线：

`docs/AI应用开发能力训练实现方案.md`

RAG 评估参考：

`docs/RAG能力训练评估报告.md`

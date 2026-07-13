# Docs 入口

> 状态：当前文档入口。
> 用途：说明 `docs/` 下各类文档的权威级别，避免历史迭代文档被误当成当前执行依据。

## 当前执行依据

- `AI应用开发训练方案-K8s-YAML-Copilot.md`：当前项目定位与能力地图，不维护动态实现状态。
- `AI应用开发能力训练实现方案.md`：唯一实施 roadmap，维护当前事实、质量门禁和执行顺序。
- `AGENTS.md`：agent 执行规则和工程铁律。
- `superpowers/plans/` 中最新且已确认的 plan：当前具体任务拆解。

## 当前纠偏方案

2026-07-10 的 eval harness 计划已完成 Task 1-8 的结构重构，但 correctness review 未通过，旧计划的 Task 9/10 不再执行。以下四组 spec/plan 已完成交叉自审，按顺序逐 Task 实施：

1. `superpowers/specs/2026-07-12-eval-artifact-protocol-design.md` / `superpowers/plans/2026-07-12-eval-artifact-protocol.md`：run、trace、artifact 与 bad case 证据协议。已实施并完成 review。
2. `superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md` / `superpowers/plans/2026-07-12-knowledge-provenance-corpus-identity.md`：知识来源、目标资源、corpus 指纹与索引一致性。
3. `superpowers/specs/2026-07-12-evaluator-validity-design.md` / `superpowers/plans/2026-07-12-evaluator-validity.md`：retrieval 分层、grounded answer、judge、generation/fix 的判定有效性。
4. `superpowers/specs/2026-07-12-eval-metric-semantics-design.md` / `superpowers/plans/2026-07-12-eval-metric-semantics.md`：指标方向、分母、可比较性与 baseline 晋升门禁。

当前执行第 2 份 Knowledge Provenance / Corpus Identity plan。四份 plan 不合并成巨型 plan；每个 Task 完成后停止并等待 review，未经明确要求不 commit。

纠偏完成后的恢复顺序统一维护在 `AI应用开发能力训练实现方案.md` 的“唯一执行顺序”中。Stage 6/7、Claim-level Grounding、检索遗留项和工程 cleanup 不在本文件重复维护，避免多份 roadmap 漂移。

## 命令入口

- 根目录 `README.md`：唯一面向使用者的命令说明，后续 cleanup 会补齐常用命令、推荐工作流、风险提示和旧 npm scripts 迁移表；不再维护平行 `docs/CLI.md`。

## 评估报告

- `RAG能力训练评估报告.md`：RAG 能力客观评估。使用时必须结合当前实现方案和最新 eval 结果，不单独作为执行计划。

## 学习复盘

以下文档用于学习沉淀和经验复盘，不作为当前实现约束：

- `RAG-复盘-01-检索原理与工程难点.md`
- `RAG-复盘-02-检索硬化与评估驱动.md`
- `RAG-复盘-03-生成层评估与修尺子.md`

## 历史归档

以下文档保留历史背景或旧产品设想，不作为当前执行依据：

- `PROJECT_CONTEXT.md`
- `产品设计-K8s智能助手.md`

## Superpowers

- `superpowers/specs/`：设计稿，记录问题、边界、架构和取舍。
- `superpowers/plans/`：实施计划，按 task 拆分执行和验证。

同一主题同时存在 spec 与 plan 时，以 plan 的 task 边界执行；若 plan 与当前代码事实冲突，应先修订 plan，再实施。

## 清理规则

- 历史文档不能覆盖 `AGENTS.md`、当前训练方案和当前实现方案。
- 移动或删除文档前必须检查引用，更新 `AGENTS.md`、`CLAUDE.md`、`README.md` 和 docs 内部链接。
- 不确定是否仍有价值的文档先归档，不直接删除。
- 文档顶部必须标明状态：当前执行依据、评估报告、学习复盘、历史归档或已废弃。

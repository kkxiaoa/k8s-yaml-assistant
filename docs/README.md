# Docs 入口

> 状态：当前文档入口。
> 用途：说明 `docs/` 下各类文档的权威级别，避免历史迭代文档被误当成当前执行依据。

## 当前执行依据

- `AI应用开发训练方案-K8s-YAML-Copilot.md`：当前项目定位与能力地图，不维护动态实现状态。
- `AI应用开发能力训练实现方案.md`：唯一实施 roadmap（路线图），维护当前事实、质量门禁和执行顺序。
- `AGENTS.md`：agent 执行规则和工程铁律。
- `superpowers/specs/2026-07-19-k3s-production-deployment-design.md`：已审核的华为云单机 K3s（轻量 Kubernetes）生产部署设计依据。
- `superpowers/plans/2026-07-19-k3s-production-deployment.md`：当前生产部署总实施计划；Phase 0-2（阶段 0-2）以及 Task 12-14（任务 12-14）的私有发布、部署、人工回滚和节点重启证据已完成审核，Step 5/6（步骤 5/6）的长期观测生命周期与自动恢复生产演练保留明确延期风险。
- `superpowers/specs/2026-07-20-k3s-deployment-adapter-design.md` / `superpowers/plans/2026-07-20-k3s-deployment-adapter.md`：Task 12（任务 12）的特权 deployment adapter（部署适配器）设计和独立实施计划；Task 1-6（任务 1-6）已完成实现和审核，Task 7（任务 7）已完成真实发布、部署、人工回滚、恢复、节点重启及事实状态收敛。Step 5/6（步骤 5/6）保持未完成并记录明确延期风险。
- `superpowers/specs/2026-07-17-case-governance-design.md` / `superpowers/plans/2026-07-17-case-governance.md`：Case Governance（评估用例治理）的已实施设计与执行记录。
- `superpowers/plans/2026-07-16-phase-b-engineering-cleanup.md`：已完成审核的 Phase B（阶段 B）工程清理与 Deferred Risk Closure（延期风险收敛）记录。
- `doc-inventory.md`：docs lifecycle inventory（文档生命周期清单）。

## 质量纠偏记录

2026-07-10 的 eval harness（评估框架）计划完成 Task 1-8（任务 1-8）的第一轮结构重构后，correctness review（正确性审核）未通过；旧计划的 Task 9/10（任务 9/10）已废弃。以下四组 spec/plan（设计稿 / 实施计划）均已完成结构实现与逐 Task（任务）审核：

1. `superpowers/specs/2026-07-12-eval-artifact-protocol-design.md` / `superpowers/plans/2026-07-12-eval-artifact-protocol.md`：run、trace、artifact 与 bad case（运行、轨迹、产物与问题用例）证据协议。
2. `superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md` / `superpowers/plans/2026-07-12-knowledge-provenance-corpus-identity.md`：knowledge provenance / corpus identity（知识来源 / 语料身份）与索引一致性。
3. `superpowers/specs/2026-07-12-evaluator-validity-design.md` / `superpowers/plans/2026-07-12-evaluator-validity.md`：retrieval、grounded answer、judge、generation/fix（检索、有依据回答、裁判、生成 / 修复）的判定有效性。
4. `superpowers/specs/2026-07-12-eval-metric-semantics-design.md` / `superpowers/plans/2026-07-12-eval-metric-semantics.md`：metric semantics（指标语义）、可比较性与 baseline（基线）晋升门禁。

四份计划完成不代表正式评估完成：当前没有新口径 full eval（完整评估）或 baseline（基线），也没有根据旧指标继续优化模型或检索。

## 当前执行

1. Phase B（阶段 B）工程清理与 Deferred Risk Closure（延期风险收敛）第 1-6 项已完成审核。
2. Case Governance（评估用例治理）已完成实现和本地门禁。
3. Production Deployment（生产部署）的私有阶段已完成审核：生产当前固定在 `v0.1.1` 镜像摘要，单副本 Deployment（工作负载）为 `1/1` 可用；真实人工回滚、恢复、新鲜分离备份和节点重启均已验证。公网 80/443/6443 仍不可达，没有 Ingress（入口）；Step 5/6（步骤 5/6）的长期观测生命周期和自动恢复生产演练保留明确延期风险。
4. 当前主线进入 Production Deployment Phase 4 Task 15（生产部署阶段 4 任务 15）的本地访问策略、请求解码和费用前置保护实现；不配置 DNS（域名系统）、公开端口或生产入口。Task 16/17（任务 16/17）的受限入口与公开路由选择通过审核后，才进入 Task 18（任务 18）正式质量审核；索引重建、模型调用、正式评估和 baseline（基线）晋升均尚未开始，仍需明确授权。
5. 当前仍没有新口径 full eval（完整评估）或 baseline（基线），不得根据旧指标调优模型或检索。

完整顺序只维护在 `AI应用开发能力训练实现方案.md` 的“唯一执行顺序”中。每个 Task（任务）完成后停止等待审核；未经明确要求不暂存、不提交、不晋升 baseline（基线）。

## 命令入口

- 根目录 `README.md`：唯一面向使用者的命令说明，已记录常用命令、外部调用、写盘和成本边界；不维护平行 `docs/CLI.md`。
- `scripts/README.md`：只面向维护者记录脚本生命周期和保留依据，不承担使用者命令说明。

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

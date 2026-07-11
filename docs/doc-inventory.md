# Docs Inventory

> 状态：docs 生命周期盘点。
> 用途：记录每份文档的当前权威级别和建议动作，支持后续 cleanup / 目录重构。

| 文档 | 状态 | 用途 | 当前权威级别 | Referenced by | 建议动作 |
|---|---|---|---|---|---|
| `AI应用开发训练方案-K8s-YAML-Copilot.md` | current | 项目定位与能力地图 | 当前定位依据，不维护执行状态 | `AGENTS.md`, `CLAUDE.md`, `README.md`, docs 内部链接 | 保留在根层；后续可迁移到 `docs/current/` |
| `AI应用开发能力训练实现方案.md` | current | 当前事实、质量契约与执行路线 | 唯一实施 roadmap | `AGENTS.md`, `CLAUDE.md`, docs 内部链接 | 保留在根层；后续可迁移到 `docs/current/` |
| `RAG能力训练评估报告.md` | report | RAG 能力评估 | 参考依据 | `AGENTS.md`, `AI应用开发训练方案-K8s-YAML-Copilot.md` | 保留；使用时结合当前实现方案 |
| `RAG-复盘-01-检索原理与工程难点.md` | learning | 检索原理学习复盘 | 学习资料 | `CLAUDE.md`, `AI应用开发训练方案-K8s-YAML-Copilot.md`, `RAG能力训练评估报告.md` | 保留；后续可迁移到 `docs/learning/` |
| `RAG-复盘-02-检索硬化与评估驱动.md` | learning | 检索硬化复盘 | 学习资料 | `CLAUDE.md`, `AI应用开发训练方案-K8s-YAML-Copilot.md`, `RAG能力训练评估报告.md` | 保留；后续可迁移到 `docs/learning/` |
| `RAG-复盘-03-生成层评估与修尺子.md` | learning | 生成层评估复盘 | 学习资料 | `CLAUDE.md`, `AI应用开发训练方案-K8s-YAML-Copilot.md`, `RAG能力训练评估报告.md` | 保留；后续可迁移到 `docs/learning/` |
| `PROJECT_CONTEXT.md` | archive | 早期上下文交接 | 历史背景 | 无当前规则引用 | 标明历史归档；后续可迁移到 `docs/archive/` |
| `产品设计-K8s智能助手.md` | archive | 旧产品草稿 | 历史背景 | docs 内部历史引用 | 已有历史状态；后续可迁移到 `docs/archive/` |
| `superpowers/specs/*.md` | design-record | 已落盘设计稿 | 设计记录 | 对应 plan 或同主题后续文档 | 保留；按日期和主题索引 |
| `superpowers/plans/*.md` | implementation-plan | 已落盘实施计划 | 执行计划 | 当前任务执行入口 | 保留；执行时以最新确认 plan 为准 |

## 当前不做的事

- 本轮不直接删除历史文档。
- 本轮不立即物理移动根层文档，避免断链。
- 目录重构前先更新引用并确认外部工具是否依赖现有路径。

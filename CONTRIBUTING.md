# Contributing

感谢你改进 K8s YAML Authoring Copilot（K8s YAML 编写辅助）。项目聚焦编辑器中的 Kubernetes YAML 编写、理解、检查、修复和生成，不把集群运行时运维能力混入同一变更。

## 开始之前

1. 先搜索已有 Issue（议题）和 Pull Request（合并请求），避免重复工作。
2. 对行为变化先说明用户问题、直接消费者和可复现输入。
3. 涉及第三方 API（应用程序接口）、文件格式或命令行时，先提供官方契约或真实样本，再定义内部输入。
4. 不提交凭据、真实 Secret（密钥）、用户 YAML、模型回答、评估运行轨迹或生产观测数据。

## 本地开发

项目要求 Node.js `24.18.0`：

```bash
npm ci
cp .env.example .env
npm run dev
```

提交前至少运行：

```bash
npm test
npm run typecheck
npm run build
npm run schemas:check
npm run aliases:check
npm run corpus:closure
npm run eval:check
npm run workflow:check
npm run deploy:check
```

这些门禁不调用模型，也不重建索引。需要访问 DeepSeek 或 Voyage AI 的评估必须在 Pull Request（合并请求）说明中明确标注费用、输入范围和结果来源，不能用手写送分用例代替真实流水线输入。

## 变更约束

- Schema（模式定义）是字段事实层；组织策略、示例和说明文档保持独立来源。
- 新资源先通过 `ingest:schemas -- --out data/schemas/snapshots/<name>` 生成独立快照，审核来源和精选闭包后再更新仓库，不手写大规模 Schema（模式定义）覆盖。
- 检索、Prompt（提示词）、生成或修复行为变化应同步提供对应评估用例或差异说明。
- 来源不足必须显式拒答；不要新增静默回退或单资源特判。
- 注释只解释非显然约束和原因，不记录讨论过程、阶段编号或历史演变。
- 新增配置、日志字段或导出前，指出当前直接消费者和失败语义。

## Pull Request（合并请求）

请保持变更单一、提交说明清晰，并在描述中包含：

- 问题与范围；
- 实现边界和未包含内容；
- 测试命令与结果；
- 对检索、生成、修复、隐私、费用或部署链的影响；
- 需要人工审核的证据。

提交贡献即表示你同意按照本项目的 [Apache License 2.0](LICENSE) 提供该贡献。

# Script inventory

本目录包含可复现的本地门禁、评估工具、Schema（模式定义）维护工具和发布契约工具。优先使用 `package.json` 中的 npm 入口，避免绕过固定参数与运行时配置。

## 只读门禁

| 入口 | 作用 | 外部调用 |
| --- | --- | --- |
| `npm run aliases:check` | 校验已审核字段别名及目标闭包 | 无 |
| `npm run schemas:check` | 校验生成 Schema（模式定义）及 `$ref` 定义闭包 | 无 |
| `npm run corpus:stats` | 输出精选语料覆盖和身份摘要 | 无 |
| `npm run corpus:closure` | 计算精选资源的 `$ref` 传递闭包 | 无 |
| `npm run eval:check` | 校验评估用例、来源标识和数据分布契约 | 无 |
| `npm run deploy:check` | 校验 K3s（轻量 Kubernetes）、应用清单和部署适配器边界 | 无 |
| `npm run release:check` | 校验运行时版本和发布构建边界 | 无 |
| `npm run workflow:check` | 校验合并请求、发布、部署和回滚流水线权限 | 无 |

## 评估与人工审核

| 入口 | 写盘 | 边界 |
| --- | --- | --- |
| `npm run eval:compare -- <runId>` | 无 | 只比较兼容运行和基线 |
| `npm run eval:promote -- <runId>` | `data/eval/baselines/<kind>.json` | 仅接受完整、已审核且通过晋升门禁的运行 |
| `npm run badcases:faith -- <runId> [--write]` | 默认不写；显式 `--write` 更新问题台账 | Holdout（留出集）轨迹不能回灌 |
| `npm run build:calibration` | `data/eval/judge-calibration.jsonl` | 从人工标签物化校准快照 |
| `npm run aliases:review -- <draft> [--apply]` | 默认只预览；显式 `--apply` 更新正式别名 | 草稿必须完整审核且可追溯 |

`npm run eval`、`npm run eval:faith`、`npm run eval:judge`、`npm run eval:gen`、`npm run eval:fix`、`npm run aliases:generate`、`npm run aliases:ab` 和 `npm run voyage:ab` 会访问外部模型或检索供应商。运行前必须核对输入范围、索引身份和费用预算。

## 数据与发布工具

| 入口 | 作用 | 写盘边界 |
| --- | --- | --- |
| `npm run ingest:schemas -- ...` | 从 OpenAPI（开放应用程序接口规范）、集群或 CRD（自定义资源定义）生成 Schema（模式定义）快照 | 只写调用方指定的输出目录 |
| `npm run index:build` | 构建持久化向量索引 | 只写显式 `INDEX_DIR`；身份命中时跳过 |
| `npm run release:manifest -- ...` | 创建和验证发布身份、附件与证明 | 只写调用方指定的输出文件 |
| `npm run deployment:authorize -- ...` | 创建和验证有界生产部署授权 | 只写调用方指定的授权、身份或状态文件 |
| `npm run adapter:check` | 类型检查并测试固定生产部署适配器 | 只写测试临时目录 |

共享逻辑应放在无副作用模块中。不要从带 `main()` 的 runner（运行器）文件导入能力，也不要让只读门禁隐式调用模型、重建索引或修改生产状态。

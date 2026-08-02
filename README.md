# K8s YAML Authoring Copilot

面向 Kubernetes YAML 编写工作流的 AI Copilot（人工智能编写辅助）。它在 Monaco Editor（代码编辑器）中结合当前 YAML、光标上下文、集群 OpenAPI Schema（开放应用程序接口模式定义）和组织策略，提供有依据、可拒答、可校验的字段解释、错误解释、资源生成与修复建议。

[在线演示](https://120.46.57.214/k8s-yaml-assistant) · [版本记录](CHANGELOG.md) · [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

> 在线演示的模型能力受模式、个人额度和全局费用门禁控制；无需模型的 YAML 检查始终是独立能力。

## 能力

| 场景             | 行为                                                                          | 失败语义                                       |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Ask（询问）      | 结合问题、当前资源、光标路径、选区和校验错误检索依据，再流式回答              | 索引缺失、身份不匹配或来源不足时显式失败或拒答 |
| Validate（校验） | 使用本地生成的 Schema（模式定义）检查 YAML                                    | 不调用模型，不修改输入                         |
| Generate（生成） | 根据自然语言生成 Kubernetes 资源，并在返回前执行 Schema（模式定义）校验与修正 | 无法得到合法结果时返回结构化错误               |
| Fix（修复）      | 根据真实校验错误修复 YAML，并重新校验目标值                                   | 不把仅有 `kind` 或字段路径视为修复成功         |
| Feedback（反馈） | 对本次生成、修复或回答记录正负反馈；负反馈可附通用原因                        | 反馈与回答主体分离，不改变原响应内容           |

Web（网页）界面提供：

- Monaco Editor（代码编辑器）中的 YAML 编写与示例切换；
- Ask / Validate / Generate / Fix（询问 / 校验 / 生成 / 修复）四条工作流；
- GitHub OAuth 2.0（GitHub 开放授权 2.0）登录、匿名体验额度和管理员模式控制；

## 为什么答案可核对

项目把不同来源的职责分开，而不是让模型把所有内容混成一段文字：

- `data/schemas/generated/` 是字段事实层，保存资源入口和 `$ref` 定义闭包；
- `data/policies.json` 是组织策略层，不覆盖 Kubernetes Schema（模式定义）事实；
- `data/aliases/` 只为已审核的字段别名补充查询表达；
- 检索结果使用 `sourceType + provenance + targets` 表达来源、出处和目标字段；
- Ask（询问）先发送 `sources` 事件，再发送 `delta` 事件，前端可以在答案完成前展示依据；
- readiness（就绪检查）会验证 Schema（模式定义）、策略、别名和索引身份，运行时不会偷偷重建索引。

## 架构

```text
OpenAPI / CRD
      │
      ▼
schema ingestion ──► generated schema registry ──► validation
                              │
policies + reviewed aliases ──┼──► corpus + immutable index
                              │                │
                              └────────────────┴──► retrieval
                                                     │
Monaco editor context ───────────────────────────────┼──► Ask SSE
                                                     ├──► Generate loop
                                                     └──► Fix loop
```

主要实现位置：

- `app/`：Next.js（React 全栈框架）页面和 API（应用程序接口）；
- `src/knowledge/`：Schema（模式定义）、策略和语料装配；
- `src/retrieval/`：字段精确命中、查询扩展、向量检索和重排；
- `src/server/`：Ask / Validate / Generate / Fix（询问 / 校验 / 生成 / 修复）共享流水线；
- `src/eval/`：检索、忠实度、生成和修复评估；
- `deploy/`：K3s（轻量 Kubernetes）、应用清单和受限生产部署适配器；
- `.github/workflows/`：合并请求门禁、索引构建、发布证据和生产部署授权链。

## 本地运行

要求 Node.js `24.18.0`。

```bash
npm ci
cp .env.example .env
npm run dev
```

默认地址通常为：

```text
http://localhost:3000/k8s-yaml-assistant
```

`.env.example` 默认关闭模型访问。此时可以匿名使用 Validate（校验）；Ask / Generate / Fix（询问 / 生成 / 修复）需要按示例配置 DeepSeek、Voyage AI、索引、控制库和体验门禁。真实凭据只写入未提交的 `.env`，不要写入命令参数、仓库、日志或 YAML。

生产构建：

```bash
npm run build
npm run start
```

## 本地门禁

以下命令不调用模型，也不重建索引：

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

调用 `npm run eval`、`npm run eval:faith`、`npm run eval:judge`、`npm run eval:gen` 或 `npm run eval:fix` 会访问外部模型或检索供应商并产生费用。评估运行、逐用例轨迹和观测分段默认不提交。

## Schema ingestion（模式定义摄取）

资源覆盖通过 ingestion pipeline（摄取流水线）扩展，不在源码中手写大规模字段集合：

```bash
# Kubernetes OpenAPI（开放应用程序接口规范）
npm run ingest:schemas -- --source kubernetes --input openapi.json

# 单个 CRD（自定义资源定义）
npm run ingest:schemas -- --source crd --input path/to/resource.yaml

# 当前 kubeconfig 指向集群的 OpenAPI v3（开放应用程序接口规范版本 3）
npm run ingest:schemas -- --source cluster-discovery --out data/schemas/generated
```

每次输出都是一份带清单的完整快照。仓库只跟踪 `data/schemas/curated.json` 所选资源及其 `$ref` 传递闭包；完整集群快照和向量索引保持在版本控制之外。

## 评估与交付证据

仓库包含四条相互独立的质量评估链：

- Retrieval（检索）：命中率、排序和来源闭包；
- Faithfulness（忠实度）：回答声明是否由检索内容支持；
- Generation（生成）：生成值、目标约束和校验闭环；
- Fix（修复）：错误定位、目标值和跨资源关系。

评估用例区分 tuning（调优集）、Holdout（留出集）和 full（完整集）；只有完整运行且通过人工审核的结果才能晋升为 baseline（基线）。仓库不发布未经复核的分数。

发布链在 GitHub Actions（自动化流水线）中构建不可变索引和镜像，并生成 SBOM（软件物料清单）、SLSA provenance（供应链来源证明）与 Sigstore（无密钥签名）证明。正式 Release（发布版本）发布后，生产任务只消费托管阶段生成并验证的有界授权，不检出合并请求代码。

## 隐私与成本

- Validate（校验）只处理本地 Schema（模式定义），不调用模型；
- Ask / Generate / Fix（询问 / 生成 / 修复）会把完成任务所需的问题、YAML 上下文和校验信息发送给配置的外部供应商；
- 本地 serving observation（在线观测）默认关闭；启用后只允许严格脱敏、采样和有保留周期的字段集合，不保存完整 YAML、问题、回答、Cookie（浏览器会话）或 OAuth（开放授权）令牌；
- 模型能力受紧急开关、运行模式、主体额度和全局费用预算共同控制。

在处理生产 Secret（密钥）或其他敏感清单前，应先在可信环境中完成脱敏，并确认供应商的数据处理条款。

## 已知限制

- 只面向 YAML 编写、理解、检查、修复和生成，不是集群运行时排障或自动执行 `kubectl` 的运维助手；
- 当前覆盖是精选资源闭包，不承诺所有 Kubernetes 版本和第三方 CRD（自定义资源定义）；
- 光标字段定位依赖编辑器上下文推断，复杂或不完整 YAML 中可能定位到相邻字段；
- Ask / Generate / Fix（询问 / 生成 / 修复）的可用性受外部供应商、索引身份和费用门禁影响；
- 参考生产拓扑是单节点、单副本，不承诺高可用。

## 参与项目

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题不要提交公开 Issue（议题），请按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

项目采用 [Apache License 2.0](LICENSE)。生成 Schema（模式定义）的第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# Scripts Inventory（脚本清单）

> 状态：当前维护清单。
> 用途：记录 `scripts/` 中脚本的生命周期、外部调用和写盘边界。面向使用者的命令说明只维护在根 `README.md`，本文件不作为平行 CLI（命令行界面）文档。

## 分类口径

- 稳定只读：当前质量门禁或人工审核流程需要，不修改项目数据。
- 稳定写入：当前数据维护或评估治理需要，会修改明确的派生数据或提交数据。
- 人工审核工具：输出不能直接进入运行时或 baseline（基线），必须先人工检查。
- 实验诊断：用于回答特定实验问题，不参与正式评估或 baseline（基线）晋升。

## 稳定只读脚本

| 脚本 | npm 入口 | 读取内容 | 外部调用 | 写盘 | 保留依据 |
|---|---|---|---|---|---|
| `check-schema-aliases.ts` | `npm run aliases:check [-- --draft <path>]` | alias targets（别名目标）、正式 registry（注册表）或 draft（草稿）、当前语料与 retrieval cases（检索用例） | 无 | 无 | 默认校验正式注册表；`--draft` 只读校验草稿的格式和可追溯关系；目标引用 Holdout（留出集）用例时失败。 |
| `check-schemas.ts` | `npm run schemas:check` | 当前加载的 generated schemas（生成的模式定义）及 definition registry（定义注册表） | 无 | 无 | 按运行时逐层解析契约遍历精选资源，拒绝缺失、非法和直接成环 `$ref`，并覆盖 map schema（映射模式）及 `anyOf` / `oneOf` 联合分支。 |
| `corpus-stats.ts` | `npm run corpus:stats` | 当前语料、语料 manifest（清单）与 curated whitelist（精选白名单） | 无 | 无 | 输出资源覆盖、语料数量、身份版本和 manifest hash（清单哈希）。 |
| `curated-closure.ts` | `npm run corpus:closure` | curated whitelist（精选白名单）、generated resources/definitions（生成资源 / 定义） | 无 | 无 | 计算应纳入版本控制的 `$ref` 传递闭包；`--list` 只输出文件路径。 |
| `eval-check.ts` | `npm run eval:check` | 当前语料、retrieval cases（检索用例）与 grounded-answer cases（有依据回答用例） | 无 | 无 | 本地验证用例契约、来源 ID 和资源覆盖。 |
| `eval-compare.ts` | `npm run eval:compare -- <runId>` | 指定或最新 `run` 及同 kind（类型）的 baseline（基线） | 无 | 无 | 在兼容性门禁通过后解释指标差异，不修改任何评估产物。 |
| `deployment-contract.test.ts` | `npm run deploy:check` | `deploy/k3s` 的 release identity（发布身份）、K3s（轻量 Kubernetes）配置、准入配置与恢复边界，`deploy/adapter` 的固定信任根、sudoers（提权规则）和 systemd（系统服务管理器）加固配置，以及 `deploy/k8s` 的 bootstrap（引导配置）和固定 Deployment（工作负载）模板 | 无 | 无 | 解析真实 YAML（配置文件）并校验特权边界与固定资源契约，拒绝浮动版本、弱权限、缺失加密、放宽准入、公网控制面、占位 Secret（密钥）、不可恢复的备份边界、动态 root（超级用户）命令、运行器管理组、无界目录、默认命名空间、可变镜像、越权 RBAC（基于角色的访问控制）、无界卷和夸大的 NetworkPolicy（网络策略）能力。 |
| `release-build-contract.test.ts` | `npm run release:check` | Node.js（JavaScript 运行时）与已审核运行依赖版本声明、Next.js（React 全栈框架）构建配置和前端字体依赖 | 无 | 无 | 拒绝 Node.js、Next.js、js-yaml、postcss 或 sharp（JavaScript 运行时 / React 全栈框架 / YAML 解析库 / CSS 处理库 / 图像处理库）安全版本漂移、重复易受影响依赖、缺失 standalone output（独立运行产物）、外部字体加载、自带字体二进制和旧 IBM Plex 变量。 |
| `container-smoke.test.ts` | `node --import tsx --test scripts/container-smoke.test.ts` | `Dockerfile`、`.dockerignore` 和容器发布契约 | 无 | 无 | 无 Docker daemon（Docker 后台服务）也可执行的纯契约门禁；覆盖不可变基础镜像、构建阶段、密钥挂载、干净上下文和运行时内容边界。 |
| `workflow-contract.test.ts` | `npm run workflow:check` | Pull Request / release lifecycle / index-build / release artifacts / published release deployment / rollback candidate workflow（合并请求 / 发布生命周期 / 索引构建 / 发布证据 / 已发布版本部署 / 回滚候选流水线）、发布配置和 `.github/CODEOWNERS` | 无 | 无 | 解析真实 YAML（配置文件），拒绝特权触发器、固定生产工作流以外的自托管运行器、越权 Secret（密钥）、浮动 Action（流水线动作）、可变镜像标签和自动发布；固定 Pull Request（合并请求）镜像漏洞门禁、发布证据与索引身份、标签提交中的 `release.published` trigger（发布事件触发器）到 `main` reusable deployment workflow（默认分支可复用部署工作流）的授权链、空权限生产任务、部署状态收尾以及只接受历史发布标签的回滚草稿边界。 |

## 部署适配器本地门禁

| npm 入口 | 测试入口 | 读取内容 | 外部调用 | 写盘 | 边界与保留依据 |
|---|---|---|---|---|---|
| `npm run adapter:check` | `pyrightconfig.json`、`deploy/adapter/test_k8s_yaml_assistant_deploy.py` | 固定 deployment adapter（部署适配器）实现、类型配置与测试自建 fixture（测试夹具） | 仅调用测试临时目录中的 fake executable（伪可执行文件）；不联网、不调用模型、不连接服务器或 Kubernetes（容器编排系统） | 仅写 Python（Python 运行时）测试临时目录并在退出时清理 | 使用固定开发依赖 Pyright（Python 静态类型检查器）校验 Python 3.12（Python 运行时）类型边界，再使用标准库 `unittest`（单元测试）覆盖严格输入、原始证明包字节、固定子进程、离线双证明、锁与台账、幂等、失败恢复和日志脱敏；不安装 Python package（Python 软件包）。 |

## 部署授权脚本

| 脚本 | npm 入口 | 读取内容 | 外部调用 | 写盘 | 边界与保留依据 |
|---|---|---|---|---|---|
| `deployment-authorization.ts` | `npm run deployment:authorize -- <inspect-tag\|create\|request\|current-production\|result\|rollback-candidate\|verify-rollback\|verify-rollback-draft>` | 已下载并验证的 Published Release（已发布版本）身份、原始 Sigstore bundle（签名证明包）、GitHub deployment/status（GitHub 部署 / 状态）快照和适配器单行结果 | 无 | 只写调用方指定的 authorization/request/status/identity/notes（授权 / 请求 / 状态 / 身份 / 说明）文件或 GitHub output（GitHub 任务输出） | 生产消费者是由 `published-release.yml` 调用的 `published-release-deploy.yml`；回滚候选消费者是 `rollback-candidate.yml`；发布证据流水线只使用 `current-production`。请求总上限为 64 KiB，JSON string encoding（JSON 字符串编码）后的授权、授权证明包和来源证明包预算分别为 2 KiB、28 KiB、32 KiB。所有发布、证明和部署快照必须先由工作流从固定 GitHub API（GitHub 应用程序接口）下载，脚本不接受任意镜像摘要、URL（统一资源定位符）、清单或命令。 |

## 容器交付脚本

| 脚本 | npm 入口 | 外部调用 | 写盘 | 边界与保留依据 |
|---|---|---|---|---|
| `container-smoke.ts` | `npm run container:build:runtime-base` / `npm run container:smoke:runtime-base` | Docker daemon（Docker 后台服务）和构建时使用的官方镜像仓库 | 只创建固定名称的本地测试镜像、随机名称的临时容器和系统临时目录 | 构建入口只复制 Git 跟踪文件与本 Task（任务）新增的容器文件到临时 context（构建上下文），排除工作区 ignored artifacts（被忽略产物）；冒烟入口以禁网、只读根文件系统和受限 `/tmp` 启动真实 `runtime-base` stage（运行时基础阶段），验证无索引时 `index_missing`，随后审计 uid/gid、文件和工具边界。不会调用模型或构建索引。 |

## 稳定写入与人工审核脚本

| 脚本 | npm 入口 | 外部调用 | 写盘 | 边界与保留依据 |
|---|---|---|---|---|
| `build-calibration.ts` | `npm run build:calibration` | 无 | 覆盖 `data/eval/judge-calibration.jsonl` | 从人工标签绑定的 completed non-smoke faith run（已完成非冒烟忠实度运行）物化 judge calibration snapshot（裁判校准快照）；来源运行或用例不存在、标签命中 Holdout（留出集）轨迹时失败，不把旧标签自动套用到同名新回答。 |
| `eval-promote.ts` | `npm run eval:promote -- <runId>` | 无 | 写入 `data/eval/baselines/<kind>.json` | 只接受通过完整 promotion gates（晋升门禁）的运行；必须在人工审核后显式执行。 |
| `faith-bad-cases.ts` | `npm run badcases:faith -- <runId> [--write]` | 无 | 默认不写；`--write` 覆盖 `data/eval/bad-cases.jsonl` | 先预览 faithful bad-case candidates（忠实度问题候选）；显式写入时合并长期问题台账并校验证据；Holdout（留出集）轨迹不生成候选。 |
| `check-schema-aliases.ts` | `npm run aliases:review -- <draft> [--apply]` | 无 | 默认不写；`--apply` 原子合并 `data/aliases/schema-field-aliases.jsonl` | 只接受位于草稿目录、全部完成人工审核且可追溯的记录；默认输出合并预览，并保留草稿未覆盖的正式记录。 |
| `generate-schema-aliases.ts` | `npm run aliases:generate` | DeepSeek；每个目标失败时最多尝试 3 次 | 独占新建 `data/aliases/drafts/schema-field-aliases.<timestamp>.jsonl` | 输出全部为 `reviewed=false`，不会修改正式注册表；草稿需要先校验和人工编辑，再经显式预览与 `--apply` 合并。 |
| `index-build.ts` | `npm run index:build` | index miss（索引未命中）时调用 Voyage document embedding（文档向量嵌入） | 写入显式 `INDEX_DIR` 下的 `manifest.json` / `chunks.jsonl` / `embeddings.f32` v5 文件哈希索引 | 只依赖无副作用 builder（构建器）；索引身份命中时跳过，失效时对全量当前语料重新嵌入，写入后立即回读完整校验。在线服务不导入或调用该脚本。 |
| `ingest-schemas.ts` | `npm run ingest:schemas -- ...` | 文件来源无；`cluster-discovery` 通过 `kubectl get --raw` 访问当前集群 | 默认写入 `data/schemas/generated/`，可由 `--out` 改写 | 支持目录、CRD（自定义资源定义）、Kubernetes / cluster OpenAPI（Kubernetes / 集群开放应用程序接口规范）和集群发现来源；通过版本化 manifest（清单）只覆盖或删除明确归属 `ingest-schemas` 的文件，旧清单和无清单的非空目录失败关闭。 |
| `release-manifest.ts` | `npm run release:manifest -- <check\|gate\|prepare\|index-identity\|verify-index\|finalize\|verify-draft\|verify-published>` | 受保护源码版本、`CHANGELOG.md`、GitHub Release / Git tag / associated Pull Request（GitHub 发布版本 / Git 标签 / 关联的合并请求）状态、Release Please Draft Release（发布自动化工具草稿发布版本）的实际正文、当前语料、独立索引产物、SBOM（软件物料清单）、SLSA provenance（供应链来源证明）、Sigstore bundle（签名证明包）和发布回读 | 只写调用方显式指定的 GitHub output（GitHub 任务输出）、发布身份或 `release-manifest.json`；不生成发布说明文件 | `gate`（门禁）在运行 Release Please（发布自动化工具）前拒绝不一致状态，并在活动应用草稿期间暂停下一版本准备；`RELEASE_INDEX_EMBEDDING_MODEL` 是发布索引模型的单一源码身份；`verify-published` 对发布标签、提交、六份原始附件、清单哈希和 BuildKit provenance（Docker 构建后端来源证明）主体执行闭环校验。 |

## 实验诊断脚本

| 脚本 | npm 入口 | 外部调用 | 写盘 | 实验边界 |
|---|---|---|---|---|
| `query-expansion-ab.ts` | `npm run aliases:ab [-- --all]` | 有效索引命中后调用 Voyage query embedding/rerank（查询向量嵌入 / 重排）；index miss（索引未命中）时失败关闭 | 无 | 运行前要求兼容索引；默认只比较通过 alias target gate（别名目标门禁）的非 Holdout（非留出）用例；`--all` 比较 retrieval tuning suite（检索调优套件）。结果只用于诊断，不写 bad case（问题用例）或 baseline（基线）。 |
| `voyage-ab.ts` | `npm run voyage:ab` | Voyage query embedding/rerank（查询向量嵌入 / 重排） | 无 | 比较 `voyage-3` 与 `voyage-4`；要求 `data/index` 和 `data/index-ab` 已分别存在兼容索引。只输出 bad case（问题用例）及 policy conflict cases（策略冲突用例）的对比。 |

## Cleanup（清理）结论

- 当前操作脚本均有 npm 入口，且代码仍对应本地门禁、数据维护、人工审核或实验诊断流程；部署适配器、部署授权、发布构建和发布清单分别有独立入口。本轮没有足够证据删除其他脚本。
- 实验脚本继续留在 `scripts/`，避免仅为目录整齐而修改 npm 入口和历史引用。是否下线实验必须由新的使用证据决定。
- 原有 13 项 `latest` 直接依赖已固定为当前 lockfile（锁文件）的既有解析版本；`scripts/dependency-versions.test.ts` 校验直接依赖不使用 `latest`、根清单声明一致，以及精确版本与解析版本一致。本次没有升级、重新解析或安装依赖。

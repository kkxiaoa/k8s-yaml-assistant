# 华为云单机 K3s 生产部署设计

> 状态：已通过 review（审核），作为 implementation plan（实施计划）的设计依据；2026-07-20 审核批准使用系统字体栈替代 IBM Plex 自带资产，2026-07-23 审核批准六项发布证据和 Cosign（签名与证明工具）无密钥证明方案，2026-07-24 审核批准 Release Please（发布自动化工具）单一版本所有权与独立索引产物流程，2026-07-26 审核批准把候选镜像 `HIGH/CRITICAL`（高危 / 严重）漏洞扫描前移到 Pull Request（合并请求）门禁，2026-07-27 审核批准发布阶段以单次 Trivy（容器漏洞扫描）完整报告同时承担证据与失败关闭门禁；同日 `v0.1.0` 已通过人工 Publish（正式发布）和 Attempt 5（第 5 次尝试）完成首次私有部署。2026-07-28 Task 15 Step 2（任务 15 步骤 2）依据生产 Traefik（入口控制器）和 oauth2-proxy（认证代理）实际版本证据，把受保护路由从 ForwardAuth（前置认证）修订为 oauth2-proxy reverse proxy（认证代理反向代理）；Step 3/5/6/7（步骤 3/5/6/7）的应用授权、最小隐私提示、本地验证和 Task 16（任务 16）交接已经通过用户 review（审核）。Step 4（步骤 4）的精确输入 token（令牌）前置上限和供应商费用硬额度证据作为显式延期风险继续未勾选；该审核不构成发布或部署授权。同日用户决定当前不注册域名，Task 16（任务 16）入口改为 `https://120.46.57.214/k8s-yaml-assistant` 和公网 IP 短期证书；该修订及 `set-access-mode`（设置访问模式）扩展设计已通过独立 review（审核），Step 2（步骤 2）的本地反例、候选实现和 review（审核）修正已经完成，固定 GitHub scope（GitHub 授权范围）为 `user:email read:org`，域名只保留为未来单独变更。生产安装、证书签发、真实 GitHub OAuth callback（GitHub 开放授权回调）、安全组和集群写入尚未执行。
> 2026-07-31 修订：SWR（华为云容器镜像服务）企业版可用前，应用或回滚 Draft Release（草稿发布版本）通过对应证据核对后，使用仓库脚本完成精确摘要预热；预热成功后才可另行确认 Publish（正式发布），失败时保留草稿并停止。
> 用途：定义当前项目在华为云单机 K3s（轻量 Kubernetes）上的生产部署架构、实施边界和验收门禁。
> 本文维护设计边界；实际实施状态和审核停止点以对应实施计划为准。

## 1. 结论与边界

### 1.1 推荐结论

当前阶段推荐以下最小生产架构：

1. 华为云 Flexus 应用服务器 L 实例运行单节点 K3s（轻量 Kubernetes），使用 K3s 自带的 Traefik（入口控制器）和 ServiceLB（服务负载均衡器）。
2. 应用构建为一个 Next.js（React 全栈框架）standalone output（独立运行产物）容器，以 non-root user（非 root 用户）运行；应用镜像推送到私有 GHCR（GitHub 容器镜像仓库），发布时同时固定 commit SHA（提交哈希）标签和镜像 digest（内容摘要），禁止使用 latest。
3. 应用使用一个 Deployment（工作负载）、一个 ClusterIP Service（集群内服务）和一个逻辑 Ingress（入口）边界，replicas（副本数）为 1；该边界可以由多个固定、预审核的 IngressRoute（Traefik 入口路由）对象表达不同路径策略，但当前只有一个公开 origin（访问源）`https://120.46.57.214`、一个 TLS（传输层安全）入口和一个固定基础路径 `/k8s-yaml-assistant`。管理员控制的 ACCESS_MODE（访问模式）只允许 private（私有）和 portfolio（作品集展示）两个值；private（私有）模式的全部业务流量由 Traefik（入口控制器）转发到 oauth2-proxy reverse proxy（认证代理反向代理），认证代理完成 GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单校验、客户端身份头清理和受控身份注入后才访问应用。portfolio（作品集展示）模式只允许固定匿名路由由 Traefik（入口控制器）直接访问应用，其余路由仍经过认证代理。匿名模型体验必须等待独立 token/usage/cost metering（令牌 / 用量 / 成本计量）设计和实现通过审核后才能开放。cert-manager（证书管理器）负责公网 IP 短期证书和自动续期；未来改用域名时单独审核证书与回调身份，不影响当前前置条件。
4. 当前约 37 MiB 的检索索引仍随最终应用镜像交付，但付费构建从发布证据生成中拆出：管理员只在需要的新 corpus/model/index identity（语料 / 模型 / 索引身份）缺失时手工运行 `index-build`（索引构建）流水线，生成、签名并按 digest（内容摘要）固定独立 GHCR index artifact（GHCR 索引产物）。release artifacts workflow（发布证据流水线）不读取 Voyage 密钥、不重建索引，只验证该不可变产物并通过外部 BuildKit context（BuildKit 构建上下文）把它烘焙进最终镜像；运行时只读加载，禁止因索引缺失或失效而在线重建。
5. 第一阶段由 GitHub Actions（GitHub 自动化流水线）直接发布 release（发布版本）：`.github/workflows/release.yml` 是 Release lifecycle（发布生命周期）入口。每次普通 `main` push（主分支推送）先核对源码版本、GitHub Release（GitHub 发布版本）、Git tag（Git 标签）和关联 Pull Request（合并请求）状态；没有活动应用草稿时，Release Please（发布自动化工具）创建或更新一个 Release Pull Request（发布合并请求），不会调用 Voyage 或构建候选镜像。该合并请求合并后，Release Please（发布自动化工具）只创建并拥有当前 Draft Release（草稿发布版本）、版本、标签名和发布说明，不在同一次运行继续准备下一版本，再以自身输出调用无人工参数的 `.github/workflows/release-artifacts.yml` reusable workflow（可复用发布证据流水线）。发布证据流水线只构建、证明应用镜像并向既有草稿附加六项证据；当前唯一维护者核对后，在 SWR（华为云容器镜像服务）企业版可用前先运行 `scripts/k3s-image-preheat.sh` 预热精确镜像摘要，预热成功后才另行手工 Publish（发布）。同一预热步骤也适用于 rollback candidate workflow（回滚候选流水线）创建的规范回滚草稿，目标摘要直接来自回滚标签，完整来源证明仍由正式部署流水线校验。Publish（发布）此时创建 Git tag（Git 标签），并由 `release.published`（发布版本已发布）事件调度专用 self-hosted deployment runner（自托管部署运行器）。该流程仍是单人确认，不宣称独立复核；预热只导入镜像，不修改 Deployment（工作负载），运行器绝不处理 Pull Request（合并请求），公网仍不向 GitHub 动态地址开放 SSH 22 或 Kubernetes API（Kubernetes 应用程序接口）6443。
6. 生产 serving observation（在线观测）在安全协议、生产存储和运维门禁全部通过后持续启用；初始采用低流量单节点可审计的安全本地写入方案。现有原始 RetrievalTrace（检索轨迹）必须先隔离，任何失败都不得回退写入原文。持续启用不等于保存原始 YAML、无限期保留或保证每条请求都落盘。
7. 当前不为应用索引引入数据库、向量数据库、Redis（内存数据存储）或对象存储。匿名额度和 Interview Pass（面试临时通行证）依赖尚未贯通的 token/usage/cost metering（令牌 / 用量 / 成本计量）；其事实源、持久化介质、扣减协议和恢复语义留到该阶段单独设计，不在本文预选 SQLite（嵌入式数据库）、PVC（持久卷声明）或其他基础设施。计量门禁完成前，portfolio（作品集展示）只公开页面和不调用外部模型的 YAML 检查。

该方案优先保证可复现发布、费用隔离、隐私边界和可回滚性，不承诺 high availability（高可用）。单节点、单系统盘、单副本和单公网链路都属于同一 failure domain（故障域）。

### 1.2 当前不做

- 本文不执行服务器连接、K3s 安装、安全组修改或 DNS（域名系统）修改。
- 本文不创建 Dockerfile、.dockerignore、GitHub Actions（GitHub 自动化流水线）、Kubernetes（容器编排系统）清单或 Secret（密钥）。
- 本文不修改应用代码，不调用 DeepSeek、Voyage、embedding（向量嵌入）或 rerank（重排），不重建 data/index。
- 本文不设计多节点控制面、自动扩缩容、跨区域容灾、通用集群运维平台、开放注册或匿名无限模型服务。
- 部署只承载编辑器中的 YAML 编写、解释、检查、生成和修复闭环；不授予应用集群管理凭据，不新增 kubectl（Kubernetes 命令行工具）执行、运行时排障、多集群治理或日志分析能力。
- 本文不恢复后续质量主线，也不晋升 baseline（基线）。

### 1.3 强制语义

文中的“必须”是进入下一阶段的门禁；“推荐”是当前事实下的默认选择；“候选值”必须在私有压测和资源观测后才能转为生产值。每个 Phase（阶段）完成后都必须停止并等待单独 review（审核），不得自动进入下一阶段。

## 2. 已核对的当前事实

### 2.1 Git 与工程基线

| 核对项 | 结果 |
| --- | --- |
| 唯一工作目录 | /Users/xiaokuangkuang/workspace/k8s-yaml-assistant |
| 分支 | main |
| HEAD | 273704fb72133abed5d70678d0259de9c600c21c |
| 最新提交摘要 | 273704f Merge pull request #1 from kkxiaoa/feat/github-pr-gates |
| Git remote（Git 远程仓库） | 私有 `git@github.com:kkxiaoa/k8s-yaml-assistant.git` |
| Task 11（任务 11）开始时工作区 | 已包含经逐项 review（审核）的本地计划和规则差异；本任务继续保留未暂存边界 |
| 本轮依赖恢复 | 已按要求执行 npm ci |

GitHub private repository（GitHub 私有仓库）、GitHub Pro（GitHub 专业版）、MFA（多因素认证）、默认分支门禁和 Pull Request verify（合并请求验证）已经建立。Task 11（任务 11）实现已经合入 `main`；8,410 条正式索引已经由独立流水线生成、校验和签名。Release Pull Request #3（发布合并请求 #3）压缩合并后形成的 `v0.1.0` 已整体重定向到审核提交 `1cec0b4cc6e57a2b018ec260627bbb651a1dcb3b`、重建六项证据并由唯一管理员 Publish（正式发布）。发布镜像 `sha256:8b512c49ce0c434f0b65eaf69d2fd827209b56e8859473a274230612e9e0b5a4` 已通过运行 `30265452918/5` 部署到私有 K3s（轻量 Kubernetes）；公开入口仍未创建。

### 2.2 构建与运行时

| 类别 | 当前事实 | 部署影响 |
| --- | --- | --- |
| 依赖 | 当前安全修复固定 next 16.2.12、sharp 0.35.3、js-yaml 4.3.0、postcss 8.5.23、react 19.2.7 和 typescript 6.0.3，package-lock.json 已锁定 | 依赖安装必须使用 npm ci；运行镜像必须通过固定 Trivy（容器漏洞扫描器）的高危 / 严重门禁 |
| Node.js（JavaScript 运行时）约束 | `.nvmrc`、`package.json` 和 `package-lock.json` 固定为 Node.js 24.18.0；本机默认 shell（命令行环境）仍是 Node.js 25.6.1 | 本地、流水线和容器门禁必须显式使用固定版本，不能继承默认 shell |
| Next.js（React 全栈框架）配置 | `next.config.mjs` 已启用 standalone output（独立运行产物），并固定开发与文件追踪根目录 | Task 5（任务 5）必须用真实构建验证 `.next/standalone/server.js` |
| 当前构建 | Node.js 24.18.0 下真实构建通过，`.next/standalone/server.js` 已生成 | Task 5（任务 5）审核后才进入容器实现 |
| 字体 | 已移除 `next/font` 和 IBM Plex，使用浏览器系统 sans/monospace（无衬线 / 等宽）字体栈 | 不下载外部字体，也不向仓库加入无能力收益的字体二进制 |
| 现有交付文件 | Dockerfile、.dockerignore、Pull Request workflow、Release lifecycle、独立 index-build 与 release artifacts workflow（合并请求流水线 / 发布生命周期 / 索引构建 / 发布证据流水线）已经实现并审核；正式索引和草稿已经创建，旧源码候选因高危依赖被拒绝，六项证据未生成；尚无应用 Kubernetes 清单、Helm（Kubernetes 包管理）或 Kustomize（清单定制工具） | 当前先合入依赖安全与合并前镜像扫描门禁，再重定向未发布草稿并恢复候选证据；Phase 3（阶段 3）再实现应用资源 |
| API（应用程序接口）路由 | /api/ask、/api/check、/api/generate、/api/fix，以及 /api/health/live、/api/health/ready | 存活端点只证明进程存活；就绪端点校验运行时配置和索引身份 |
| 认证与保护 | 没有身份认证、授权、请求限流、请求体字节上限或费用硬门禁 | 不允许直接匿名公开 |
| 请求解析 | 路由直接调用 req.json() 并做 TypeScript（类型化 JavaScript）类型断言，没有严格 runtime decode（运行时解码） | 仅配置入口 Content-Length（内容长度）不足以覆盖分块请求和字段语义 |
| 模型客户端 | DeepSeek 兼容端点、在线回答模型 `deepseek-v4-flash` 和离线 judge（裁判）模型 `deepseek-v4-pro` 已显式固定；Voyage endpoint/model（端点 / 模型）同样经过严格运行时解码 | 在线作答与离线裁判保持能力分层；缺失、未知或非法配置 fail-closed（失败关闭） |

2026-07-20 核对 Node.js（JavaScript 运行时）官方发布页后，24 系列仍为 LTS（长期支持），当前补丁版本为 24.18.0；仓库工具链固定为该版本。后续基础镜像仍须固定真实 digest（内容摘要），升级补丁时单独审核，不使用移动标签作为最终身份。参考：[Node.js 24 下载归档](https://nodejs.org/en/download/archive/v24)。

Next.js（React 全栈框架）官方文档说明 standalone output（独立运行产物）会生成可直接部署的最小服务文件，但 public 和 .next/static 仍需显式复制；该行为必须用容器 smoke test（冒烟测试）验证。参考：[Next.js standalone output 文档](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)。

### 2.3 环境变量的实际使用

| 变量 | 当前用途 | 生产归属 |
| --- | --- | --- |
| DEEPSEEK_API_KEY | /api/ask、/api/generate、/api/fix 调用 DeepSeek | Kubernetes Secret（Kubernetes 密钥），只在运行时注入 |
| VOYAGE_API_KEY | 查询 embedding（向量嵌入）、rerank（重排）和当前索引构建 | 独立 `index-build` Environment secret（索引构建环境密钥）与运行时 Kubernetes Secret（Kubernetes 密钥）分别管理；候选发布不可读取 |
| DEEPSEEK_BASE_URL | DeepSeek Anthropic-compatible API（Anthropic 兼容接口）地址 | ConfigMap（普通配置），显式固定 HTTPS（安全超文本传输协议）地址 |
| DEEPSEEK_ANSWER_MODEL | 在线 Ask/Generate/Fix（询问 / 生成 / 修复）模型，当前只接受 `deepseek-v4-flash` | ConfigMap（普通配置），不使用别名或隐式默认值 |
| VOYAGE_EMBEDDING_URL | 查询和索引构建的 embedding endpoint（向量嵌入端点） | ConfigMap（普通配置），显式固定 HTTPS 地址 |
| VOYAGE_RERANK_URL | 在线 rerank endpoint（重排端点） | ConfigMap（普通配置），显式固定 HTTPS 地址 |
| VOYAGE_EMBEDDING_MODEL | embedding model（向量嵌入模型），当前发布身份为 `voyage-3` | ConfigMap（普通配置），不使用隐式默认值 |
| VOYAGE_RERANK_MODEL | rerank model（重排模型），当前只接受 `rerank-2.5` | ConfigMap（普通配置），不使用移动别名 |
| INDEX_DIR | 索引目录 | ConfigMap（普通配置），容器内显式固定为只读绝对路径 |
| ENABLE_QUERY_EXPANSION | 查询扩展开关，严格接受 `true` 或 `false` | ConfigMap（普通配置），不得依赖隐式默认值 |

当前根目录存在被 Git 忽略的 .env，只核对了变量名，没有读取、输出或复制任何值。仓库已提供安全的 .env.example，只记录密钥变量名和经过审核的非敏感固定配置，不包含可用凭据或看似可用的密钥占位值。严格解码后的配置快照不包含 Secret（密钥）值；密钥只在调用供应商前校验存在并按能力读取。

### 2.4 运行时读取和写入

应用通过 process.cwd() 读取：

- data/schemas/generated/resources
- data/schemas/generated/definitions
- data/schemas/curated.json
- data/policies.json
- alias（别名）相关 JSONL（逐行 JSON）文件
- data/index

应用唯一主动持久化的数据是 serving observation（在线观测）。当前实现默认 `off`（关闭）；启用 `local`（本地）模式时，先按稳定 requestId（请求标识）采样，再对问题文本脱敏或拒绝记录，只允许通过严格 schema（模式）的最小观测对象写入。local sink（本地写入端）使用受限文件权限、按 UTC（协调世界时）日期和字节轮转、保留期清理、总磁盘上限及固定安全错误码，任何失败都不会回退写入原始 RetrievalTrace（检索轨迹）。生产仍需通过 PVC（持久卷声明）挂载、单副本单写入端、Pod（容器组）权限和告警验证后才能把模式从 `off` 切换为 `local`。

最终容器必须使用 read-only root filesystem（只读根文件系统），只给经过证明的临时路径挂载受限 emptyDir（临时卷），候选路径为 /tmp。不能用只读文件系统掩盖当前轨迹问题：在启用只读根文件系统前，必须先从默认请求路径移除不安全写入，使其不会持续报错或产生噪声。

安全 serving observation（在线观测）实现并通过生产审核后，会新增唯一明确的持久生产写入目录，用于受控轮转文件；该目录与只读 data/index、容器根文件系统及未来可能存在的计量状态隔离。匿名额度和 Interview Pass（面试临时通行证）的运行时写入需求尚无既有计量设计，本文不提前指定目录或存储介质。

### 2.5 语料与索引

当前语料身份：

- corpus count（语料数量）：8,410
- curated resources（精选资源）：28
- corpus identityVersion（语料身份版本）：2
- corpus manifest hash（语料清单哈希）：82621edc73530dffc86e21fe6488a332e98f7d2e1efba3d0d995e7b66fb880c4

当前本地 data/index 身份：

- formatVersion：2
- embedding model（向量嵌入模型）：voyage-3
- dimension（维度）：1,024
- chunk count（知识片段数量）：8,127
- 大小：约 37 MiB
- index hash（索引哈希）：52c2249fb2e103aa26803dd844ce02f68b2c0920371e76534f11c0642cd08d85

当前 v2 索引会被 v5 加载器以 format_mismatch（格式不匹配）明确拒绝。在线加载器已经 fail closed（失败关闭）：索引身份无效时 readiness probe（就绪探针）失败，不接流量、不调用模型、不在线重建。

### 2.6 本地门禁结果

以下命令均未调用真实模型，也未重建索引：

| 命令 | 结果 |
| --- | --- |
| npm ci | 通过 |
| npm test | 208 个测试通过，0 个失败 |
| npx tsc --noEmit -p tsconfig.json | 通过 |
| npm run build | 通过 |
| npm run release:check / workflow:check | 通过：发布构建 9 项、工作流 6 项 |
| npm run schemas:check | 通过 |
| npm run corpus:closure | 通过：28 个资源入口、240 个依赖定义、268 个闭包文件 |
| npm run corpus:stats | 通过，8,410 个知识片段、28 个精选资源 |
| npm run eval:check | 通过：Retrieval（检索）83、Grounded Answer（有依据回答）88、Generation（生成）27、Fix（修复）9 |
| npm run aliases:check | 通过：11 个已审核别名、0 个未审核别名 |
| npm run container:build:runtime-base / container:smoke:runtime-base | 通过：500 个文件的 clean context（干净上下文），容器内 208/208；`live=200`、`ready=503/index_missing`、无供应商网络 |

Task 11（任务 11）的本地容器门禁使用“HEAD 已跟踪文件 + 当前 Task 明确审核的新文件”构造 clean context（干净上下文）：schema（模式）闭包为 28 个 resource（资源）文件和 240 个 definition（定义）文件，完整测试、类型和禁网 Next.js build（Next.js 构建）均通过，语料仍为 8,410 条。data/schemas/generated 虽被通用忽略规则覆盖，但发布上下文必须保留其中已跟踪的真实闭包，不能在 .dockerignore 中整体排除该目录；未暂存文件只能通过封闭白名单进入本地审核上下文，不能扫描并复制全部未跟踪文件。

当前工作目录还存在被 Git 忽略的 node_modules、.next、旧 data/index 和 generated schema（生成模式）额外文件；本轮按禁止事项没有清理它们。发布构建必须从 clean checkout（干净检出）开始，而不是把当前工作目录直接作为不受控 Docker context（Docker 构建上下文）。

本轮没有执行真实 retrieval（检索）、faith（忠实度）、judge（裁判）、generation（生成）或 fix（修复）评估，没有验证模型供应商可用性和费用，也没有进行服务器只读核对。

## 3. 目标架构

### 3.1 请求与交付路径

~~~text
匿名访客 / 受邀用户 / 管理员
  │ HTTPS
  ▼
华为云安全组：公开阶段仅 80/443；22 保持固定来源；6443 不公开
  │
  ▼
K3s Traefik（入口控制器）
  ├─ TLS 终止：cert-manager（证书管理器）管理证书
  ├─ 请求体大小、入口速率、并发保护
  ├─ private（私有）：全部业务路由转发到 oauth2-proxy reverse proxy（认证代理反向代理）
  └─ portfolio（作品集展示）：固定匿名路由直达应用；其余路由仍转发到认证代理
                                  │
                                  ▼
                  oauth2-proxy（OAuth 2.0 认证代理）
                  GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单
                  清理客户端身份头并注入会话主体
                                  │
                                  ▼
                    应用 ClusterIP Service（应用集群内服务）
                                  │
                                  ▼
                    Next.js Deployment（Next.js 工作负载）
                    replicas=1，non-root（非 root），只读根文件系统
                      ├─ 只读 schema / corpus / data/index
                      ├─ 服务端访问策略：private / portfolio
                      ├─ portfolio：公开本地检查；匿名模型能力受后续计量门禁约束
                      ├─ Interview Pass（面试临时通行证）：保留需求，等待计量设计
                      ├─ DeepSeek / Voyage：仅出站 HTTPS
                      ├─ stdout/stderr：仅安全结构化元数据
                      └─ serving observation（在线观测）：安全协议通过后持续启用

GitHub Actions（GitHub 自动化流水线）
  ├─ 普通 Pull Request：无密钥测试、类型检查、无索引构建
  ├─ 手工 index-build（索引构建）：付费生成 → 校验 → 签名
  │    └─ 不可变 GHCR index artifact（GHCR 索引产物）
  └─ Release Please（发布自动化工具）
       ├─ main push（主分支推送）：创建或更新唯一 Release Pull Request（发布合并请求）
       └─ Release Pull Request 合并：创建 Draft Release（草稿发布版本）
            → release artifacts（发布证据流水线）验证索引产物 → 构建、证明并推送应用镜像
       │ release manifest（发布清单）：commit / image digest / index artifact digest / index identity
       ▼
     单人确认：draft GitHub Release（GitHub 草稿发布版本）
       │ 操作者核对清单并手工 Publish release（发布版本）
       │ release.published（发布版本已发布）后才调度
       ▼
     生产专用 self-hosted runner（自托管运行器，仅出站 443）
       │ 固定部署适配器；只接受已验证的 GHCR image digest（镜像内容摘要）
       ▼
     本机 K3s API（K3s 应用程序接口，不经过公网 6443）

人工操作者
  ├─ 在 GitHub 审核 release manifest（发布清单）并批准/拒绝
  └─ 固定来源 SSH 只用于初始 bootstrap（引导配置）和 break-glass（紧急处置）
~~~

### 3.2 deployment access mode（部署访问模式）

ACCESS_MODE（访问模式）是生产部署配置，不是前端 feature flag（功能开关），也不提供公共管理 API（应用程序接口）。允许值和语义如下：

| 值 | 网络入口后的访问策略 | 模型能力 |
| --- | --- | --- |
| private（私有） | 页面、静态资源和全部业务 API（应用程序接口）均要求 GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单身份 | 只有管理员或明确允许用户可调用，仍受请求体、并发、单请求 token（令牌）和全局费用上限保护 |
| portfolio（作品集展示） | 页面、静态资源和不调用外部模型的 YAML 检查可匿名访问；管理员路由仍要求允许名单身份 | 在计量设计完成前，匿名模型路由保持关闭；完成后才允许按审核后的匿名额度和 Interview Pass（面试临时通行证）规则启用，且不能绕过全局费用熔断 |

缺失或非法值必须解释为 private（私有），不能默认为 portfolio（作品集展示）。应用是最终授权边界：即使 Ingress（入口）误开放，private（私有）模式也必须拒绝匿名业务请求；portfolio（作品集展示）模式只有在独立计量设计已经审核并实现，且 Turnstile（人机验证）服务端校验、跨重启费用硬边界、请求体限制、限流、并发和费用熔断全部健康时，才允许匿名模型调用。任一门禁缺失或异常都只关闭付费模型路由，公开页面和不调用外部模型的 YAML 检查继续服务。

只有生产管理员可以修改模式。当前“生产管理员”特指唯一维护者控制、启用强 MFA（多因素认证）的私有部署仓库 GitHub 身份，以及对应的固定来源 SSH（安全远程登录）运维身份；普通 OAuth（开放授权）允许名单用户和 Interview Pass（面试临时通行证）持有者都不是管理员。正常变更来自私有部署仓库中经过人工确认的固定动作，紧急关闭可由 42.232.250.220/32 固定来源的 SSH break-glass（SSH 紧急处置）执行。浏览器、应用公共 API（应用程序接口）、Interview Pass（面试临时通行证）和应用 ServiceAccount（服务账户）都没有修改 ConfigMap（普通配置）或 Ingress（入口）的权限。每次变更必须记录操作者、前后模式、时间、原因和验证结果，不记录任何 Secret（密钥）。

模式切换不是单字段热更新：

- private → portfolio（私有 → 作品集展示）：先部署并验证应用保护；如需开放匿名模型能力，还必须先完成独立计量门禁。保持全部业务路由经过 oauth2-proxy reverse proxy（认证代理反向代理）完成私有反例测试，最后才开放经过审核且删除受信身份头的匿名路由。
- portfolio → private（作品集展示 → 私有）：先让 Ingress（入口）恢复全部业务路由到 oauth2-proxy reverse proxy（认证代理反向代理），并把应用入站 NetworkPolicy（网络策略）收紧为只允许认证代理，验证匿名请求被拒绝，再把应用配置切回 private（私有）。安全或费用异常时允许直接执行这一收紧动作，不等待常规发布窗口。

固定部署适配器只能接受枚举动作 set-access-mode private 或 set-access-mode portfolio（设置访问模式），不得接收任意 ConfigMap（普通配置）、Ingress（入口）内容或 kubectl（Kubernetes 命令行工具）参数。启用 portfolio（作品集展示）需要与正式发布相同的人工清单确认；关闭到 private（私有）始终允许作为低风险紧急动作，但事后必须补录审计。

### 3.3 单节点故障边界

- K3s server（K3s 服务端）、etcd（分布式键值存储）高可用和外部 datastore（数据存储）均不启用；单节点使用 K3s 默认 SQLite（嵌入式数据库）即可。
- 节点宕机、系统盘损坏、华为云区域或公网链路故障会使服务整体不可用。
- replicas=1 不能抵御 Pod（容器组）故障窗口；RollingUpdate（滚动更新）只能在同一节点临时并存两个 Pod（容器组），不等于高可用。
- 节点重启期间必然不可用。镜像、K3s 数据、证书和本地缓存都位于同一节点或同一云服务边界。
- 当前不承诺 RTO（恢复时间目标）和 RPO（恢复点目标）的具体数值；必须在 Phase 5（阶段 5）恢复演练后才能记录实测目标。

K3s（轻量 Kubernetes）文档说明默认安装包含 Traefik（入口控制器），ServiceLB（服务负载均衡器）会使用节点的 80/443 端口；安装前必须确认端口未被其他服务占用。参考：[K3s 网络服务](https://docs.k3s.io/networking/networking-services)。

## 4. 容器构建与发布产物

### 4.1 固定工具链

实施时必须：

1. 选择当日仍受支持的 Node.js 24 LTS（Node.js 24 长期支持版）具体补丁版本。
2. 在 package.json 中声明 engines，并让本地、GitHub Actions（GitHub 自动化流水线）和容器阶段使用同一版本。
3. deps/verify/index-build/build（依赖 / 验证 / 索引构建 / 构建）阶段使用 Node.js 24.18.0 Debian bookworm-slim（Debian 精简镜像），index-artifact（索引产物）阶段使用 scratch image（空基础镜像），runtime（运行时）阶段使用提供 Node 所需 C/C++ 动态库且不含 shell/package manager（命令解释器 / 包管理器）的 distroless cc-debian12（无发行版工具的 Debian C/C++ 运行时镜像）；有基础镜像的阶段都固定真实 digest（内容摘要）。升级补丁或基础镜像时通过单独 Pull Request（合并请求）更新 digest（内容摘要）并重跑门禁。
4. package-lock.json 作为依赖身份，所有安装只执行 npm ci，不执行 npm install。
5. 所有第三方 GitHub Action（GitHub 流水线动作）固定到完整 commit SHA（提交哈希），不只固定版本标签。

### 4.2 multi-stage build（多阶段构建）

正式 Dockerfile 至少分为以下职责，不允许把开发依赖、凭据或本地 ignored artifacts（被忽略产物）带入 runtime image（运行时镜像）：

| 阶段 | 输入与动作 | 输出 |
| :-- | :-: | --- |
| deps（依赖） | 干净 Git 上下文、package.json、package-lock.json；npm ci | 锁定的完整依赖 |
| verify（验证） | 源码和依赖；运行测试、类型、schema（模式）、eval contract（评估契约）和 clean build（干净构建）门禁 | 可审核的门禁结果 |
| index-build（索引构建） | 已核对语料、显式模型名、仅 `index-build`（索引构建）流水线可见的 Voyage 构建凭据 | 通过身份校验的 data/index |
| index-artifact（索引产物） | 只从 index-build（索引构建）阶段复制 data/index | 只包含 `/data/index` 的 scratch image（空基础镜像），推送后按 digest（内容摘要）固定并签名 |
| build（构建） | 启用 standalone output（独立运行产物），使用系统字体栈 | .next/standalone 和静态资源 |
| runtime（运行时） | 只复制服务文件、静态资源、运行必需 data，并从按 digest（内容摘要）固定的外部 `verified-index` BuildKit context（BuildKit 构建上下文）复制已验证索引 | 最小 non-root（非 root）应用镜像 |

verify（验证）阶段至少运行：

~~~sh
npm ci
npm test
npx tsc --noEmit -p tsconfig.json
npm run schemas:check
npm run eval:check
npm run build
~~~

corpus:stats（语料统计）也应进入发布门禁，用于把语料数量和哈希写入发布证明。它不能替代正式质量评估。

Next.js（React 全栈框架）必须设置 output: 'standalone'，并显式复制 public（如果存在）和 .next/static。最终进程使用固定工作目录，以 PORT=3000、HOSTNAME=0.0.0.0 启动 node server.js。最终镜像不得包含 TypeScript（类型化 JavaScript）编译器、测试工具、Git 元数据、.env 或 npm 缓存。

Next.js 16.2.9 会把构建时加载的 `.env` 和 `.env.production` 主动复制到 standalone output（独立运行产物）。因此本地 `.next/standalone` 不是可直接发布的镜像输入；正式 Docker build（容器构建）必须从不含 `.env*` 的 clean checkout（干净检出）开始，由 `.dockerignore` 再次排除，并扫描 runtime image（运行时镜像）。不能用构建后删除文件替代最终镜像门禁。

### 4.3 字体的离线可复现构建

`next/font/google` 会在构建期下载 Google 字体 CSS（层叠样式表）和字体文件。2026-07-20 审核确认 IBM Plex 只提供视觉风格，不服务 K8s YAML Authoring Copilot（K8s YAML 编写助手）的核心能力，因此不再为它引入本地二进制、许可证和供应链维护。

生产要求：

1. 页面和 Monaco（代码编辑器）只使用 CSS（层叠样式表）系统 sans/monospace（无衬线 / 等宽）字体栈。
2. 应用源码不得导入 `next/font`，仓库不提交 `.woff`、`.woff2`、`.ttf` 或 `.otf` 字体资产。
3. 发布构建契约必须拒绝外部字体加载、字体二进制和旧 IBM Plex CSS variable（CSS 变量）回归。
4. 在禁止网络访问的容器 build（构建）阶段运行 `npm run build`，证明完整构建不依赖外网。

系统字体在不同客户端操作系统上的具体字形可能不同，这是明确接受的视觉一致性取舍；它不影响构建身份、服务端运行或 YAML 编辑能力。缓存字体下载结果或在 CI（持续集成）中伪造响应仍不能作为生产通过条件。

### 4.4 .dockerignore 边界

未来 .dockerignore 必须排除：

- .git、.next、node_modules、编辑器缓存和操作系统临时文件；
- .env 及其他本地密钥文件；
- data/index、旧索引和索引临时文件，索引只能由受信任构建阶段生成；
- data/observability、eval run（评估运行）输出、trace（轨迹）、报告和其他 ignored artifacts（被忽略产物）；
- 本地测试缓存、覆盖率、日志和临时归档。

同时必须保留：

- package-lock.json；
- 应用源码；
- data/schemas/generated 中已被 Git 跟踪的 schema closure（模式闭包）；
- curated corpus（精选语料）、policy（策略）、alias（别名）及构建索引所需的真实输入；

镜像只能从 clean checkout（干净检出）构建。不能用宽泛的 data/** 忽略规则后再手工补少量资源，这会破坏真实 ingestion pipeline（摄取流水线）和语料身份。

### 4.5 runtime hardening（运行时加固）

最终容器要求：

- 固定 uid/gid，例如 10001；USER 指令和 Pod securityContext（Pod 安全上下文）一致；
- runAsNonRoot=true、allowPrivilegeEscalation=false、capabilities.drop=[ALL]；
- readOnlyRootFilesystem=true、seccompProfile=RuntimeDefault；
- automountServiceAccountToken=false；
- 只为 /tmp 挂载带 sizeLimit 的 emptyDir（临时卷）；如果 smoke test（冒烟测试）证明还有其他合法写路径，必须逐路径说明原因，禁止把整个 /app 设为可写；
- 不安装 shell、curl 或包管理器到最终镜像；探针使用应用 HTTP（超文本传输协议）端点；
- 处理 SIGTERM（终止信号），给现有 SSE（服务器发送事件）连接保留有上限的 terminationGracePeriodSeconds（终止宽限期）。

### 4.6 镜像身份

发布产物必须同时记录：

- 源 commit SHA（提交哈希）；
- image digest（镜像内容摘要）；
- Node.js（JavaScript 运行时）版本和基础镜像 digest（内容摘要）；
- corpus identityVersion/count/manifest hash（语料身份版本 / 数量 / 清单哈希）；
- embedding model/dimension/index hash（向量嵌入模型 / 维度 / 索引哈希）；
- 独立 index artifact repository/tag/digest/signature identity（索引产物仓库 / 标签 / 内容摘要 / 签名身份）；
- workflow run（流水线运行）和构建时间；
- 软件物料清单和 provenance attestation（来源证明）。

镜像标签使用完整提交哈希；人工部署最终写入 image@sha256:...，避免标签被移动。不得构建或部署 latest。

## 5. 索引交付设计

### 5.1 方案比较

| 维度 | 镜像内置 data/index | PVC + Kubernetes Job（持久卷 + Kubernetes 独立任务） |
| --- | --- | --- |
| 原子发布 | 应用、语料和索引同一个 digest（内容摘要），天然原子 | 应用与索引是两个生命周期，必须额外协调 |
| 回滚 | 回滚镜像即可同时回滚索引 | 必须维护版本目录、指针切换和 Job（任务）回滚 |
| Secret（密钥）边界 | Voyage 构建凭据只进入受信任 build secret（构建密钥）挂载 | 凭据进入集群 Job Secret（任务密钥），运行时集群需承担构建权限 |
| 单节点持久性 | 不依赖本地 PVC（持久卷声明） | K3s local-path PVC（本地路径持久卷）仍绑定同一节点和系统盘 |
| 启动 | 只读校验后加载 | 需等待 Job（任务）、PVC（持久卷声明）和版本切换 |
| 镜像体积 | 当前增加约 37 MiB，可接受 | 镜像更小，但多出 Job（任务）、PVC（持久卷声明）、清理和备份 |
| 适用变化频率 | 语料、应用和索引按同一提交发布 | 索引需要独立、高频、超大规模更新 |
| 当前复杂度收益 | 高 | 当前没有足够收益 |

明确推荐把校验通过的 data/index 烘焙进最终不可变应用镜像。为避免每次功能提交或 Draft Release（草稿发布版本）重复调用 Voyage，构建期先把同一索引保存为独立、已签名、按 digest（内容摘要）固定的 GHCR OCI artifact（GHCR 开放容器规范产物），再由候选应用构建复制进去。该产物是发布构建的可复用中间交付物，不是运行时远程依赖，也不改变“应用镜像内置索引”的生产架构。当前索引较小、单节点单副本，PVC + Job（持久卷 + 独立任务）仍只会增加时序、状态和回滚风险。

以下任一条件出现时，重新 review（审核）索引交付：

- 索引体积或构建时间显著拖慢镜像发布和 6 Mbps 拉取；
- 语料或模型更新频率明显高于应用；
- 多副本需要共享同一索引；
- 索引必须独立回滚或热切换；
- 单节点 local-path（本地路径）不再满足恢复要求。

届时应同时比较“对象存储中的不可变索引 artifact（产物）+ init container（初始化容器）校验下载”，不能默认直接引入向量数据库。

### 5.2 corpus/model/index identity（语料 / 模型 / 索引身份）

独立索引产物的确定性 identity（身份）至少绑定：

- index formatVersion（索引格式版本）；
- corpus identityVersion（语料身份版本）；
- corpus count（语料数量）；
- corpus manifest hash（语料清单哈希）；
- embedding provider/model（向量嵌入供应商 / 模型）；
- vector dimension（向量维度）；
- chunks file hash（知识片段文件哈希）；
- embeddings file hash（向量文件哈希）；
- index hash（索引哈希）。

其中 `formatVersion + corpus identityVersion + corpus manifest hash + embedding model`（格式版本 + 语料身份版本 + 语料清单哈希 + 向量嵌入模型）计算稳定 `indexHash`（索引哈希）并形成 content-addressed tag（内容寻址标签）`index-v5-<indexHash>`；GHCR（GitHub 容器镜像仓库）不保证该标签不可变，发布和部署只信任已验证的 digest（内容摘要）。当前 `voyage-3` 的期望 `indexHash` 为 `fc5b2110fea1339106aacc3829ac19404dab4dc1c9d81ae26c63fa11119ed15a`。`RELEASE_INDEX_EMBEDDING_MODEL` 是受版本控制的发布索引模型单一来源，三个 workflow（流水线）只消费 `index-identity` 输出，Dockerfile（容器构建文件）通过显式 build argument（构建参数）接收同一值。source commit SHA（源提交哈希）、构建工具版本、workflow identity/run（流水线身份 / 运行）和构建时间属于 provenance（来源证明），不进入可复用索引身份；候选 release manifest（发布清单）再把本次 source commit（源提交）、精确 index artifact digest（索引产物内容摘要）和最终应用镜像 digest（内容摘要）绑定在一起。

容器 build（构建）失败条件：

- 索引数量不等于语料数量；
- 语料清单哈希、文件哈希、模型或维度任一不匹配；
- 索引包含非有限向量值、缺文件、额外未知文件或路径逃逸；
- 构建后的独立加载检查失败。

启动时只做本地身份校验和有限加载，不访问 Voyage 验证模型。readiness（就绪状态）不通过时不能触发在线重建。

### 5.3 索引构建与 VOYAGE_API_KEY

Pull Request（合并请求）、Release lifecycle（发布生命周期）和 release artifacts workflow（发布证据流水线）都不得获得 VOYAGE_API_KEY，也不得调用真实 embedding（向量嵌入）。唯一可读取该密钥的是管理员手工触发的 `index-build`（索引构建）流水线；它从受保护 `main` 分支读取源码，并在接触 Secret（密钥）和产生费用前完成源码、语料、测试、类型与流水线契约检查。

`index-build`（索引构建）先根据确定性 identity（身份）查询 GHCR（GitHub 容器镜像仓库）：

1. 已存在时必须解析为唯一 digest（内容摘要），验证固定 `index-build` workflow identity（索引构建流水线身份）的 Cosign（签名工具）签名，并完整加载和校验 `manifest.json`、`chunks.jsonl`、`embeddings.f32`；有效则直接结束，不重复调用 Voyage。
2. 只有 registry（镜像仓库）明确返回 `manifest unknown/not found`（清单未知 / 未找到）才进入 `index-build` Environment（索引构建环境）执行付费构建。
3. 网络、认证、签名、内容或身份错误一律 fail-closed（失败关闭），不得把异常误判为“索引缺失”后自动付费重建。

新索引通过 BuildKit secret mount（BuildKit 密钥挂载）把凭据只挂载到单个 `index-build`（索引构建）指令。凭据不得：

- 作为 Docker ARG（Docker 构建参数）或 ENV（环境变量层）写入镜像历史；
- 被 COPY（复制）进构建上下文或镜像层；
- 出现在 shell trace（命令跟踪）、构建日志、cache metadata（缓存元数据）或错误信息；
- 进入索引 manifest（索引清单）、软件物料清单或 provenance（来源证明）。

索引文件本身进入只包含 `/data/index` 的 scratch image（空基础镜像）；推送后立即按 digest（内容摘要）回读、完整校验并使用 Cosign keyless signature（Cosign 无密钥签名）固定来源。只把密钥隔离在 secret mount（密钥挂载）并不足够，还必须审计镜像历史和构建脚本不会输出环境变量。

### 5.4 失效、重建和回滚

- 失效：启动检查输出封闭错误码，例如 index_identity_mismatch，不输出用户数据或凭据；readiness（就绪状态）失败，Pod（容器组）不接流量。
- 重建：只由管理员手工运行 `index-build`（索引构建）流水线。身份相同且已有有效产物时复用；语料、索引格式或模型变化时生成新的 content-addressed tag（内容寻址标签）和 digest（内容摘要），后续只使用 digest。运行中 Pod（容器组）和候选发布都不得修补或重建索引。
- 回滚：部署上一条已验收的 image digest（镜像内容摘要）。因为索引随镜像，应用和索引一起回滚。
- Registry（镜像仓库）不可用：已拉取的当前 Pod（容器组）可继续运行；节点重建或镜像被回收时可能无法恢复，因此节点至少保留当前和上一已验收镜像，并在发布前验证 GHCR 可拉取。
- 备份：索引的 durable source of truth（持久事实源）是源语料、构建代码、身份报告和 GHCR 中固定 digest（内容摘要）且签名有效的独立索引产物；最终应用镜像还包含同一索引副本，不额外备份本地解压目录。

### 5.5 数据库与计量边界

当前应用不需要关系数据库、Redis（内存数据存储）或向量数据库。索引是随镜像交付的只读 artifact（产物），OAuth（开放授权）会话由认证代理的签名 cookie（签名浏览器会话）承担；数据库或向量数据库都不能改善当前索引交付。

仓库现状中没有独立 token/usage/cost metering（令牌 / 用量 / 成本计量）设计。`RetrievalTrace.usage` 的可选字段和路线文档中的“尚未贯通”只表明观测需求，不构成计量事实源、结算协议或额度实现。因此本文不预选 SQLite（嵌入式数据库）、PVC（持久卷声明）、Redis（内存数据存储）或外部数据库，也不指定额度数值、预留/结算算法、保留期和恢复方式。

实施匿名模型体验和 Interview Pass（面试临时通行证）前，必须先形成独立设计并审核：供应商实际 usage（用量）的可信来源、流式请求中断和重试的计量语义、单请求与累计费用上限、并发原子性、跨重启事实源、失败关闭、对账、轮换、数据最小化、备份与恢复。只有该设计证明需要持久状态后，才能基于单节点、单副本和实测负载选择最小存储；不得为了提前完成部署文档引入没有实际收益的基础设施。

## 6. Secret（密钥）设计

### 6.1 职责矩阵

| 凭据 | 存放位置 | 创建方式 | 轮换 | 泄露处理 |
| --- | --- | --- | --- | --- |
| 本地 DEEPSEEK_API_KEY | 被 Git 忽略的 .env，仅开发机 | 从密码管理器写入仓库外或权限 0600 的本地文件；不通过命令行参数传值 | 创建新 key（密钥）→ 本地替换 → 验证 → 吊销旧 key（密钥） | 立即吊销、检查本地日志和 Git 历史、清理不安全 artifact（产物），不得只删除文件 |
| 本地 VOYAGE_API_KEY | 同上 | 同上 | 同上 | 同上，并检查是否发生异常索引构建或费用 |
| 索引构建 VOYAGE_API_KEY | 独立 `index-build` Environment secret（索引构建环境密钥），不属于 release artifacts（发布证据）或 production environment（生产环境） | 仓库管理员在网页设置；使用独立索引构建凭据，只有手工 `index-build`（索引构建）任务可见，Pull Request / Release lifecycle / release artifacts（合并请求 / 发布生命周期 / 发布证据）任务均不可读取 | 新旧短暂并存，成功构建并校验新索引产物后吊销旧凭据 | 吊销、暂停 `index-build` workflow（索引构建流水线）、检查 Actions log/artifact 与供应商费用（流水线日志 / 产物）、使受影响索引产物退出发布资格并生成新身份 |
| 运行时 DEEPSEEK_API_KEY | Kubernetes Secret（Kubernetes 密钥） | 操作者从密码管理器生成仓库外 0600 临时输入，通过服务器本地 kubectl（Kubernetes 命令行工具）创建；不提交 YAML | 创建新版本、触发 rollout（滚动发布）、验证后吊销旧值 | 吊销、更新 Secret（密钥）、重启 Pod（容器组）、检查访问与费用、关闭公开入口直到确认 |
| 运行时 VOYAGE_API_KEY | Kubernetes Secret（Kubernetes 密钥） | 同上；与索引构建凭据使用不同 key（密钥） | 同上 | 同上；索引不因此自动重建 |
| GHCR 推送权限 | GitHub 托管 runner（运行器）的短期 GITHUB_TOKEN | workflow（流水线）声明最小 contents:read 和 packages:write | 每次运行自动签发，无长期轮换 | 取消运行、撤销会话，审核 package（软件包）写入和 workflow（流水线）变更 |
| GHCR 拉取凭据 | 独立 imagePullSecret（镜像拉取密钥） | 专用 GitHub machine user（机器用户）或只读 token（令牌），仅 read:packages；从服务器本地受限文件创建 | 新 token（令牌）创建并验证拉取后删除旧 token（令牌） | 立即撤销、重建 imagePullSecret（镜像拉取密钥）、检查包访问记录 |
| 生产部署 runner identity（运行器身份） | 生产服务器专用低权限账号的 runner（运行器）目录 | GitHub 一次性 registration token（注册令牌）只在初始 SSH bootstrap（SSH 引导配置）中使用；持久 runner credential（运行器凭据）不进入仓库或 Actions secret（流水线密钥） | 在 GitHub 移除旧 runner（运行器）并用新身份重新注册；系统或所有权变化时强制轮换 | 立即在 GitHub 禁用/移除 runner（运行器）、停止本地服务、检查已接收任务和部署记录、重新注册 |
| OAuth client secret / cookie secret（OAuth 客户端密钥 / 浏览器会话密钥） | 独立 Kubernetes Secret（Kubernetes 密钥） | GitHub OAuth App（GitHub OAuth 应用）与密码管理器生成，不与模型密钥混放 | 新 Secret（密钥）滚动，cookie secret（浏览器会话密钥）轮换会使现有会话失效 | 撤销 OAuth secret（OAuth 密钥）、轮换会话密钥、强制重新登录、检查允许名单 |
| Turnstile secret key（Turnstile 服务端密钥，仅未来匿名模型体验） | 独立 Kubernetes Secret（Kubernetes 密钥）；sitekey（站点公钥标识）放 ConfigMap（普通配置） | 独立计量设计批准后，管理员在 Cloudflare Turnstile（人机验证服务）创建限定生产域名的 widget（组件），只把 secret key（服务端密钥）注入应用 | 创建新 widget（组件）或密钥，双配置验证后撤销旧值 | 立即切回 private（私有），撤销旧值，检查校验失败和供应商费用，不把密钥输出到日志 |
| TLS private key（TLS 私钥） | cert-manager（证书管理器）管理的 Kubernetes Secret（Kubernetes 密钥） | ACME（自动证书管理环境）签发流程生成 | cert-manager（证书管理器）自动续期；异常时人工重新签发 | 撤销证书、重新签发、检查 DNS（域名系统）和入口配置 |

GitHub 官方建议工作流优先使用短期 GITHUB_TOKEN，并说明 GHCR 私有镜像拉取仍需正确范围的认证；权限必须按用途拆分。参考：[GitHub Actions 发布容器镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 认证与权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

生产 deploy job（部署任务）不需要 DEEPSEEK_API_KEY、VOYAGE_API_KEY、GHCR 拉取 token（令牌）、SSH 私钥或完整 kubeconfig（Kubernetes 客户端配置）。应用模型密钥和 imagePullSecret（镜像拉取密钥）已经由 K3s 管理；部署任务只传递经过确认的镜像 digest（内容摘要）。只有手工发布 draft GitHub Release（GitHub 草稿发布版本）产生 release.published（发布版本已发布）事件后才调度任务；本地 runner credential（运行器凭据）在运行器上长期存在，因此该人工确认不能替代运行器访问策略和本地最小权限。

### 6.2 Kubernetes Secret（Kubernetes 密钥）边界

- ConfigMap（普通配置）只能放模型名称、ACCESS_MODE（访问模式）、目录、公开域名、Turnstile sitekey（Turnstile 站点公钥标识）和非敏感阈值。ACCESS_MODE（访问模式）虽然不是密钥，但属于高影响生产配置，只允许管理员控制的固定适配器修改。
- 模型密钥、OAuth secret（OAuth 密钥）、cookie secret（浏览器会话密钥）、Turnstile secret key（Turnstile 服务端密钥）和镜像拉取 token（令牌）必须按职责分 Secret（密钥）管理，避免一个轮换动作重启所有组件。匿名会话和 Interview Pass（面试临时通行证）是否需要额外密钥及其轮换语义，留给后续计量与访问控制设计，当前不创建占位 Secret（密钥）。
- 不在 Git 仓库保存 base64（Base64 编码）后的 Secret（密钥）；base64 不是加密。
- 不使用 --from-literal 把真实值留在 shell history（命令历史）或 process list（进程列表）。
- 不执行 kubectl get secret -o yaml 作为常规备份，也不复制完整 kubeconfig（Kubernetes 客户端配置）。
- K3s 必须启用 secrets encryption at rest（静态密钥加密），但它不替代外部密码管理器中的恢复源。
- Namespace（命名空间）、ServiceAccount（服务账户）和 RBAC（基于角色的访问控制）遵循最小权限；应用本身不需要读取 Kubernetes API（Kubernetes 应用程序接口）。

Kubernetes 官方建议启用静态加密、限制 Secret（密钥）的 watch/list（监听 / 列举）权限，并把外部密钥管理作为更强边界。参考：[Kubernetes Secret 良好实践](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)。

### 6.3 泄露响应统一流程

1. 先关闭或限制入口，立即撤销受影响凭据。
2. 用新凭据更新事实源和 Kubernetes Secret（Kubernetes 密钥），滚动重启相关 Pod（容器组）。
3. 检查 Git、GitHub Actions（GitHub 自动化流水线）、GHCR（GitHub 容器镜像仓库）、K3s、应用安全日志和供应商费用；检查过程不复制秘密值。
4. 删除或隔离包含秘密的日志、artifact（产物）和缓存；如秘密进入 Git 历史，按事故处理重写并通知所有使用者更新克隆。
5. 重建可能受污染的镜像，失效现有登录会话，记录不含秘密的时间线和影响范围。
6. 只有确认旧凭据失效、入口受控和新版本验证通过后才恢复流量。

## 7. GitHub Actions（GitHub 自动化流水线）边界

### 7.1 Pull Request（合并请求）门禁

使用 GitHub-hosted runner（GitHub 托管运行器），从 clean checkout（干净检出）执行：

- npm ci；
- npm test；
- TypeScript type check（TypeScript 类型检查）；
- schema/corpus/eval contract check（模式 / 语料 / 评估契约检查）；
- 禁止外网字体依赖后的 Next.js build（Next.js 构建）；
- Docker build（Docker 镜像构建）到本地但不推送，或验证同一正式 Dockerfile 的无密钥阶段；
- 固定 Trivy（容器漏洞扫描器）版本扫描同一无索引运行镜像，发现 `HIGH/CRITICAL`（高危 / 严重）操作系统或运行时库漏洞时在合并前失败；该步骤不读取 Secret（密钥）、不推送 GHCR（GitHub 容器镜像仓库）、不构建索引或调用模型；
- 无密钥镜像 smoke test（冒烟测试）：证明非 root、只读根文件系统，以及索引缺失或不匹配时 readiness（就绪状态）安全失败且不调用 Voyage；带真实索引并达到 ready（就绪）的测试只在受保护发布流水线执行。

repository secret scan（仓库密钥扫描）和低于 `HIGH`（高危）的依赖风险处置仍是独立门禁；不得把当前镜像 `HIGH/CRITICAL`（高危 / 严重）扫描描述为已经覆盖所有供应链风险。发布证据流水线仍须对按 digest（内容摘要）固定的最终候选执行独立扫描，防止基础镜像或漏洞数据库在合并后发生变化；该阶段只扫描一次并生成完整 `trivy-results.json`，随后使用固定版本的 `trivy convert`（Trivy 报告转换）从同一报告筛选 `HIGH/CRITICAL`（高危 / 严重）并以退出码 1 失败关闭。报告缺失、损坏或无法转换同样必须失败，不能为了表格日志再次扫描同一镜像。

来自 fork（分叉仓库）的不可信 Pull Request（合并请求）不能获得 repository secret（仓库密钥）、protected environment secret（受保护环境密钥）或有写权限的 token（令牌）。禁止用 pull_request_target 直接运行未审核代码。

Release Please（发布自动化工具）创建的 Release Pull Request（发布合并请求）额外需要 `release_index`（发布索引）检查。该任务只检出受保护的 `main`，不检出或执行合并请求代码，不读取 Secret（密钥），只用 `packages:read`（软件包读取权限）确认当前语料和模型要求的索引产物存在、解析为唯一 digest（内容摘要）且具有固定 `index-build` workflow identity（索引构建流水线身份）的有效签名。普通 Pull Request（合并请求）跳过该检查，不因尚未发布索引而阻塞开发。

GitHub 当前对内置 `GITHUB_TOKEN`（流水线令牌）创建或更新 Pull Request（合并请求）的 `opened/synchronize/reopened`（打开 / 同步 / 重新打开）事件提供例外：可以生成处于 approval-required state（等待批准状态）的流水线运行，维护者批准后才执行。维护者对 Release Pull Request（发布合并请求）提交实际修改也会触发常规运行。两种路径都必须让常规门禁、活动草稿状态门禁与 `release_index`（发布索引）检查实际通过；必需的 `PR verify`（合并请求验证）在状态门禁失败时必须显式失败，不能因 dependency skip（依赖跳过）变成可能被规则集接受的 `skipped`（已跳过）。不能把自动创建成功、等待批准或 Release Please（发布自动化工具）自身运行成功视为可合并。参考：[GitHub 触发流水线](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)、[Release Please Action](https://github.com/googleapis/release-please-action)。

### 7.2 构建并推送 GHCR

版本准备、索引构建和候选镜像构建是三条独立职责：

1. 普通 `main` push（主分支推送）先通过 release state gate（发布状态门禁）。首发占位状态或当前版本已有匹配的正式 GitHub Release / Git tag（GitHub 发布版本 / Git 标签）时，Release Please（发布自动化工具）创建或更新同一个 Release Pull Request（发布合并请求），根据 Conventional Commit（约定式提交）维护 `package.json`、`package-lock.json`、`.release-please-manifest.json` 和 `CHANGELOG.md`。当前版本存在唯一且一致的活动应用草稿时跳过 Release Please（发布自动化工具），普通开发不受阻，但下一版本准备延后；其余缺失或冲突状态失败关闭。仓库只允许 Squash merge（压缩合并），默认使用 Pull Request title（合并请求标题）并把提交正文留空，避免原功能提交和包含相同 Conventional Commit（约定式提交）正文的 merge commit（合并提交）重复进入发布说明。没有历史 Release（发布版本）的首次启动使用一次性 `release-as: 0.1.0`；Release Pull Request（发布合并请求）更新到 `0.1.0` 后必须在该分支删除该覆盖，只保留 `bump-minor-pre-major: true` 的长期 `1.0.0` 前版本策略。
2. 管理员只在确定性 index identity（索引身份）缺少有效产物时手工运行 `index-build`（索引构建）。该工作流是唯一读取 `VOYAGE_API_KEY` 的位置，生成独立 GHCR index artifact（GHCR 索引产物）后按 digest（内容摘要）固定、完整校验并签名。
3. Release Pull Request（发布合并请求）合并后，状态门禁通过当前提交关联的 bot branch / merge commit（机器人分支 / 合并提交）识别该事件。Release Please（发布自动化工具）使用 `draft: true` 创建 Draft Release（草稿发布版本），自动生成 release notes（发布说明），并输出精确 `sha/tag_name/version`（提交哈希 / 标签名 / 版本）；该场景同时固定 `skip-github-pull-request: true`，避免尚无真实标签时在同一次调用错误创建下一版本发布合并请求。同一次 Release lifecycle run（发布生命周期流水线运行）只在 `release_created == true` 时调用 reusable release artifacts workflow（可复用发布证据流水线）。
4. release artifacts workflow（发布证据流水线）不接受 `workflow_dispatch`（手工触发）或 PR ID（合并请求标识）、提交、版本、标签等人工输入，不读取 Voyage 或 DeepSeek 密钥，也不创建/编辑 Release（发布版本）或 Git tag（Git 标签）。它校验 Release Please（发布自动化工具）输出和既有草稿正文，验证精确索引产物 digest（内容摘要）及签名，再把该索引作为只读外部 BuildKit context（BuildKit 构建上下文）烘焙进应用镜像。
5. 候选应用只构建服务器实际的 `linux/amd64`（Linux AMD64 架构），推送完整 commit SHA（提交哈希）标签并回读 image digest（镜像内容摘要）；然后执行就绪冒烟、镜像内容、`HIGH,CRITICAL`（高危 / 严重）漏洞阻断、SPDX SBOM（SPDX 软件物料清单）、SLSA provenance（SLSA 来源证明）与 Cosign（签名工具）验证。
6. `release-manifest.json` 绑定 source commit、Release Please notes hash、image digest、corpus/model/index identity、index artifact tag/digest/signature identity、当前生产 digest、回滚 digest 和六项证据（源提交、发布说明哈希、镜像内容摘要、语料 / 模型 / 索引身份、索引产物标签 / 内容摘要 / 签名身份、当前生产内容摘要、回滚内容摘要）。

Release Please Action（发布自动化流水线动作）的 `release_created`、`sha`、`tag_name` 和 `version` 输出及 manifest-driven release（清单驱动发布）边界以其官方说明为准；release artifacts workflow（发布证据流水线）使用 GitHub reusable workflow（GitHub 可复用流水线）直接接收这些输出，不通过人工复制。参考：[Release Please Action](https://github.com/googleapis/release-please-action)、[GitHub reusable workflows（GitHub 可复用流水线）](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)。

`manifest.ts` 只验证 `CHANGELOG.md` 的完整身份和 Draft Release（草稿发布版本）的实际正文，不从 changelog（变更日志）摘取发布说明，也不生成 `release-notes.md`。发布说明由 Release Please（发布自动化工具）生成并拥有；release artifacts workflow（发布证据流水线）只能读取、校验和哈希绑定，不能修改。

索引不存在时，Release Pull Request（发布合并请求）的 `release_index`（发布索引）检查先 fail-closed（失败关闭）。如果该门禁被绕过或索引在发布证据阶段失效，该流水线同样失败；恢复顺序是手工运行 `index-build`（索引构建），审核结果后重新运行原失败检查或原 Release lifecycle run（发布生命周期流水线运行）的 failed job（失败任务）。若只需修复流水线，合入修复后手工运行无参数 Release lifecycle（发布生命周期）仍验证并重建同一旧源提交的证据。若失败原因属于旧 source SHA（源提交哈希）的应用或依赖缺陷，重跑旧源码没有修复意义；只能在安全修复通过受保护 Pull Request（合并请求）门禁并合入 `main` 后，由管理员把尚未发布且无附件的草稿目标重定向到该精确提交、同步已审核发布说明，再运行无参数恢复。`resolve_draft`（解析草稿）必须重新验证版本、目标提交和 `main` 祖先关系；不得接受分支名、人工 SHA 输入、已发布版本或已有证据的草稿。两条路径都不重新运行版本准备、不修改 package version（包版本），也不创建第二个草稿；release artifacts workflow（发布证据流水线）本身仍无权编辑草稿正文或目标。

候选 Release（发布版本）只附加以下六项正式证据；Release Please（发布自动化工具）的正文就是唯一发布说明，不存在临时发布说明附件：

1. SPDX SBOM（SPDX 软件物料清单）。
2. SLSA provenance（SLSA 来源证明）。
3. release manifest（发布清单）。
4. 绑定镜像 digest（内容摘要）的软件物料清单证明包。
5. 绑定同一镜像 digest（内容摘要）的来源证明包。
6. 绑定发布清单文件摘要的签名包。

Cosign `v3.1.2`（签名工具版本）默认生成当前 Sigstore bundle（Sigstore 证明包）格式；流水线只能使用该版本实际支持的参数，不能保留已删除的 `--new-bundle-format` 兼容参数。镜像证明必须同时从 registry（镜像仓库）和下载的 bundle（证明包）验证，发布清单则按 blob（文件）验证。

### 7.3 第一阶段 GitHub Actions（GitHub 自动化流水线）直接发布

K3s、Namespace（命名空间）、运行时 Secret（密钥）、imagePullSecret（镜像拉取密钥）、生产部署运行器和最小部署权限必须先通过一次固定来源 SSH bootstrap（SSH 引导配置）建立。这是 Actions（自动化流水线）能够访问本机部署边界的前提，不属于应用 release（发布版本）。bootstrap（引导配置）完成后，第一条及后续应用 release（发布版本）均由 GitHub Actions（GitHub 自动化流水线）直接部署；SSH 只保留给审计和 break-glass（紧急处置）。

Phase 3（阶段 3）的 direct release（直接发布）授权范围只包括“把固定 Deployment（工作负载）的应用镜像切换为已审核 digest（内容摘要），并验证或回滚”。Namespace（命名空间）、Secret（密钥）、Ingress（入口）、RBAC（基于角色的访问控制）、资源上限或其他清单变化仍按 Phase（阶段）单独审核和 bootstrap（引导配置）；不得借发布工作流扩大部署适配器能力。

Phase 4（阶段 4）完成访问模式反例测试后，可以给同一 root-owned deployment adapter（root 所有的部署适配器）增加独立、固定的 set-access-mode private|portfolio（设置访问模式）动作。它只能在两个预安装、版本固定的路由配置之间切换，并同步一个枚举 ConfigMap（普通配置）值；不能接收任意清单或参数。两个方向的正常变更都先生成引用当前 image digest（镜像内容摘要）、前后模式、安全门禁、固定模式清单摘要和回退动作的 draft operational Release（草稿运维发布版本），只有管理员手工 Publish（正式发布）后，固定 access-mode workflow（访问模式流水线）才能签发授权并调度生产运行器。紧急关闭到 private（私有）可以使用固定来源 SSH（安全远程登录）调用同一 private（私有）收敛函数，不能由该路径开启 portfolio（作品集展示）；正常和紧急路径都必须记录结果。

| job（任务） | runner（运行器） | GITHUB_TOKEN 最小权限 | 可见 Secret（密钥） | 生产权限 |
| --- | --- | --- | --- | --- |
| Pull Request verify（合并请求验证） | GitHub-hosted（GitHub 托管） | contents:read | 无 | 无 |
| Release Pull Request state gate（发布合并请求状态门禁） | GitHub-hosted（GitHub 托管） | contents:write | 无 | 无；只在 Release Please bot branch（发布自动化机器人分支）上读取活动草稿，不检出或执行合并请求代码，不调用第三方 Action（流水线动作） |
| Release Pull Request index check（发布合并请求索引检查） | GitHub-hosted（GitHub 托管） | contents:read、packages:read | 无 | 无；只读取受保护 `main` 与索引产物 |
| Release state inspection（发布状态检查） | GitHub-hosted（GitHub 托管） | contents:write、pull-requests:read | 无 | 无；只检出受保护 `main`，读取 Draft Release（草稿发布版本）、Git tag（Git 标签）和关联的合并请求 |
| Release Please（发布自动化） | GitHub-hosted（GitHub 托管） | contents:write、issues:write、pull-requests:write | 无 | 只能维护 Release Pull Request（发布合并请求）和 Draft Release（草稿发布版本），不部署 |
| index inspect（索引检查） | GitHub-hosted（GitHub 托管） | contents:read、packages:read | 无 | 无 |
| index build（索引构建） | GitHub-hosted（GitHub 托管） | contents:read、packages:write、id-token:write | 仅 `index-build` Environment（索引构建环境）的 VOYAGE_API_KEY | 无 |
| release artifacts verify（发布证据验证） | GitHub-hosted（GitHub 托管） | contents:write、packages:read | 无 | 无；写权限只用于读取仅对 push access（推送权限）可见的草稿，校验后通过短期任务产物传递快照 |
| release artifacts build（发布证据构建） | GitHub-hosted（GitHub 托管） | contents:read、packages:write、id-token:write | 无 | 无；不读取或修改 Draft Release（草稿发布版本） |
| release artifacts attach（发布证据附加） | GitHub-hosted（GitHub 托管） | contents:write | 无 | 只能向既有草稿附加并回读六项证据，不创建、编辑或发布草稿 |
| published release validate（已发布版本验证） | GitHub-hosted（GitHub 托管） | contents:read、actions:read、attestations:read | 无 | 无 |
| deploy/rollback/access mode（部署 / 回滚 / 访问模式） | self-hosted production（生产自托管） | contents:read、actions:read、deployments:write | 无 environment secret（环境密钥） | 只能调用固定部署适配器；回滚只能回到台账内 digest（内容摘要），访问模式只能在 private/portfolio（私有 / 作品集展示）之间切换 |

每个 job（任务）在 workflow（流水线）中显式声明 permissions（权限）；未列出的权限设为 none（无）。production environment（生产环境）只用于部署记录和非敏感变量，不承担人工审核，也不承载模型、SSH、Kubernetes（容器编排系统）或 GHCR 长期密钥。

release workflow（发布流水线）固定为以下 job graph（任务图）：

1. inspect and prepare（检查与准备）：普通 `main` push（主分支推送）先运行状态门禁。只有首发占位状态、已正式发布版本后的正常开发，或当前 Release Pull Request merge（发布合并请求合并）三类明确状态可以继续；活动应用草稿时跳过，其他状态失败。前两类允许 Release Please（发布自动化工具）创建或更新唯一 Release Pull Request（发布合并请求）；发布合并场景只创建当前草稿并跳过下一版本合并请求。该步骤不读取模型密钥、不构建索引或镜像。
2. index preflight（索引预检）：Release Pull Request（发布合并请求）由维护者实际提交审核变更后，常规门禁与独立 `release_index`（发布索引）检查运行；缺少有效索引产物时失败关闭，维护者手工运行 `index-build`（索引构建）并重新运行该检查。
3. draft release（草稿发布版本）：Release Pull Request（发布合并请求）合并后，Release Please（发布自动化工具）创建 Draft Release（草稿发布版本）和发布说明，但不创建 Git tag（Git 标签）；它把 `source_sha/tag/version`（源提交哈希 / 标签名 / 版本）直接传给可复用发布证据流水线。
4. release artifacts verify（发布证据验证）：GitHub-hosted runner（GitHub 托管运行器）复核精确源码、既有草稿正文和目标提交，再验证独立索引产物 digest（内容摘要）、签名和完整内容；草稿 JSON snapshot（JSON 快照）通过保留 1 天的 GitHub Artifact（GitHub 任务产物）传给构建任务。schema/corpus/eval contract、无索引容器门禁（模式 / 语料 / 评估契约 / 无索引容器门禁）不在这里重复执行；受保护 Pull Request（合并请求）负责这些源码门禁，最终 Dockerfile 的 `verify/build` 阶段仍执行测试、类型检查和 Next.js build（Next.js 构建）。
5. release artifacts build（发布证据构建）：使用已校验草稿快照和按 digest（内容摘要）固定的外部索引构建上下文构建最终应用镜像，推送 GHCR（GitHub 容器镜像仓库），生成漏洞结果、SPDX SBOM（SPDX 软件物料清单）、SLSA provenance（SLSA 来源证明）、Cosign bundle（Cosign 证明包）和 release manifest（发布清单）；该任务没有草稿写权限，也不调用 Release API（发布接口）。
6. release artifacts attach（发布证据附加）：上传前重新读取草稿并核对正文哈希，确认长时间构建期间没有漂移后，才向既有草稿上传六项证据；上传后再次回读正文、附件名称、文件哈希和签名。证据构建失败时草稿保留但不可进入部署。
7. manual review（人工审核）：唯一维护者在 GitHub 页面核对正文、release manifest（发布清单）和六项证据。发现漂移或缺失时保留/删除草稿，不进入预热或发布。
8. image preheat（镜像预热）：SWR（华为云容器镜像服务）企业版可用前，维护者在获得本次生产节点写入授权后，以目标草稿标签运行仓库内 `scripts/k3s-image-preheat.sh`。应用草稿从 `release-manifest.json` 接受精确 `linux/amd64` 根摘要；规范回滚草稿从标签接受精确根摘要，完整回滚来源证明和台账不在脚本中重复校验。脚本在本机生成并校验 OCI（开放容器镜像）归档，经 SSH（安全远程登录）导入 K3s（轻量 Kubernetes）并回读同一摘要；失败时保留草稿并停止。预热不创建标签、不修改 Deployment（工作负载）也不触发部署。
9. manual Publish（人工正式发布）：只有人工审核和镜像预热均成功后，唯一维护者才可另行确认 Publish release（发布版本）；也可继续保留或删除草稿。发布动作仍是当前人工门禁；同一账号完成审核和发布确认，因此没有 separation of duties（职责分离）。
10. deploy（部署）：独立 production deploy workflow（生产部署流水线）只监听 `release.published`（发布版本已发布）。Publish（发布）此时创建 Git tag（Git 标签）；部署流水线先在 GitHub-hosted runner（GitHub 托管运行器）验证 tag/commit/release manifest/digest/provenance（标签 / 提交 / 发布清单 / 内容摘要 / 来源），通过后才调度生产专用 self-hosted deployment runner（自托管部署运行器）。部署任务不 checkout（检出）仓库、不执行仓库脚本、不下载任意 manifest（清单），只把已确认的 image digest（镜像内容摘要）和有界证明包交给服务器上 root-owned deployment adapter（root 所有的部署适配器）。
11. verify and record（验证与记录）：适配器更新固定 Namespace/Deployment/container（命名空间 / 工作负载 / 容器），等待 rollout/readiness（滚动发布 / 就绪状态），核对实际 digest/index identity（内容摘要 / 索引身份），更新 GitHub deployment 与 release ledger（GitHub 部署记录 / 发布台账）；模型 smoke test（冒烟测试）仍需单独批准费用。

production-deploy concurrency group（生产部署并发组）只允许一个活动部署，cancel-in-progress=false，禁止新发布中断正在进行的发布。重跑 workflow（流水线）仍使用原 GITHUB_SHA/GITHUB_REF（GitHub 提交 / 引用）；部署新 digest（内容摘要）必须对应一条新的人工发布记录，不能用重跑绕过草稿确认。

### 7.4 单一维护者人工确认门禁

prevent self-review（禁止自我审核）的含义是：发起某次 deployment workflow（部署流水线）的人不能批准同一次 deployment job（部署任务）。GitHub 官方明确说明，启用后，workflow run（流水线运行）的发起人无法批准该部署。当前仓库计划为 private repository（私有仓库），且只有一名维护者；启用该选项会使部署永久等待，因此当前不启用 required reviewers/prevent self-review（必需审核人 / 禁止自我审核），也不把 production Environment（生产环境）当成人工门禁。参考：[GitHub Reviewing deployments（GitHub 部署审核）](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)。

套餐边界也不适合把它作为当前前提：GitHub 官方说明，GitHub Free/Pro/Team（GitHub 免费版 / 专业版 / 团队版）的 required reviewers（必需审核人）只对公开仓库可用，私有仓库要使用该规则需要 GitHub Enterprise（GitHub 企业版）；私有仓库的 Environment secret（环境密钥）则至少需要 GitHub Pro/Team/Enterprise（GitHub 专业版 / 团队版 / 企业版）。当前 GitHub Pro private repository（GitHub 专业版私有仓库）只使用 `index-build` Environment secret（索引构建环境密钥）隔离 Voyage 凭据，不配置 required reviewer（必需审核人）；唯一维护者仍以下述草稿发布版本作为人工门禁。参考：[GitHub Deployments and environments（GitHub 部署与环境）](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。

当前采用 draft GitHub Release（GitHub 草稿发布版本）的单人确认，并在 SWR（华为云容器镜像服务）企业版可用前增加发布前镜像预热：

1. 应用版本由 Release Please（发布自动化工具）在审核后的 Release Pull Request（发布合并请求）合并后创建 Draft Release（草稿发布版本）；回滚版本由 rollback candidate workflow（回滚候选流水线）创建规范回滚草稿。两者的 `draft: true` 都只保存预期标签名，尚不创建 Git tag（Git 标签）。
2. release artifacts workflow（发布证据流水线）向应用草稿附加 release manifest（发布清单）和六项证据；rollback candidate workflow（回滚候选流水线）向回滚草稿附加对应 provenance bundle（来源证明包）。两条路径都不自动 Publish（正式发布）或调用生产运行器。
3. 对应 workflow（流水线）结束后没有 waiting deploy job（等待中的部署任务），K3s 不发生变化。证据生成失败时只允许修复前置条件并重跑原 failed jobs（失败任务），不能用新的手工输入替换发布身份。
4. 唯一维护者打开草稿，人工核对下方清单中除预热结果外的发布证据项。核对不通过时选择 Save draft/Delete（保留草稿 / 删除），不运行预热也不部署。
5. 获得本次生产节点镜像导入授权后，维护者运行 `bash scripts/k3s-image-preheat.sh <目标草稿标签>`。脚本必须拒绝已发布版本、Pre-release（预发布）、错误仓库、非法标签和非法摘要；应用草稿从发布清单读取固定镜像、`linux/amd64` 平台和摘要，回滚草稿从规范标签读取摘要。传输后必须校验归档哈希、导入并回读同一根摘要，退出时清理两端临时文件。
6. 只有脚本成功并完成下方预热结果核对后，维护者才可另行确认并手工点击 Publish release（发布版本），表示批准并创建 Git tag（Git 标签）。预热结果不替代这次确认。
7. production deploy workflow（生产部署流水线）只声明 `release: types: [published]` 触发器，并且工作流文件必须存在于默认分支。GitHub 文档说明 Draft Release（草稿发布版本）的创建或编辑不会触发该部署事件，从草稿发布时 `published`（已发布）事件会触发。参考：[GitHub release 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)、[GitHub 管理发布版本](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。
8. 部署流水线在 GitHub-hosted runner（GitHub 托管运行器）重新验证 release/tag/commit/manifest/digest/signature（发布版本 / 标签 / 提交 / 清单 / 内容摘要 / 签名）后，才把固定输入交给生产运行器。
9. 仓库支持 immutable release（不可变发布版本）时必须启用；不支持时，部署任务记录 Release ID、asset hash（发布版本标识 / 附件哈希）并拒绝与发布瞬间记录不一致的输入。

该流程提供“构建完成后停下、展示精确产物、由人再次确认、留下发布记录”，但发起和确认都属于同一个 GitHub 账号，不具备 two-person review/separation of duties（双人复核 / 职责分离）。因此：

- GitHub 账号必须启用强 MFA（多因素认证），优先 passkey/security key（通行密钥 / 硬件安全密钥），恢复凭据离线保存；
- production deploy workflow（生产部署流水线）、release artifacts workflow（发布证据流水线）和部署适配器变更必须单独查看 diff（差异），不能和普通功能改动混在一次大变更中；
- release artifacts attach job（发布证据附加任务）虽因上传附件需要 contents:write，但设计上禁止创建、编辑或自动 Publish release（发布版本）；任何自动发布行为视为门禁失效；
- `workflow_dispatch`（手工触发）只允许无参数的 Release lifecycle（发布生命周期）恢复入口和独立付费 `index-build`（索引构建）入口：前者只解析当前活动草稿并完整恢复同一发布证据，不运行 Release Please（发布自动化工具）；后者只能处理确定性索引身份。release artifacts workflow（发布证据流水线）仍只能由这两个受控调用路径以已校验身份调用，三者都不能继续部署；
- GitHub 账号、runner credential（运行器凭据）或默认分支写权限失陷时，攻击者可能同时生成并发布版本，这是当前单人治理无法消除的剩余风险。

私有或内部仓库使用 GitHub artifact attestation（GitHub 产物证明）需要 GitHub Enterprise Cloud（GitHub 企业云）。非企业私有仓库可使用固定版本 Sigstore Cosign（Sigstore 镜像签名工具）和 GitHub OIDC（GitHub 开放式身份认证）做无长期密钥签名，验证时分别把 certificate identity/issuer（证书身份 / 签发者）固定到受保护的 `index-build` 与 `release-artifacts` workflow（索引构建 / 发布证据流水线）。该方案会把签名身份和摘要写入公开 transparency log（透明日志）；实施前必须接受这项元数据暴露，否则停止并重新评审 KMS-backed signing（密钥管理服务签名），不能静默取消证明门禁。参考：[GitHub 私有仓库证明可用性](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)、[Sigstore GitHub Actions 签名](https://docs.sigstore.dev/quickstart/quickstart-ci/)、[Sigstore 身份验证](https://docs.sigstore.dev/cosign/verifying/verify/)。

人工确认时必须核对：

- source commit（源提交）属于受保护分支，质量门禁全部通过；
- GHCR image digest（GHCR 镜像内容摘要）与 provenance attestation（来源证明）一致；
- 节点回读已存在与应用清单或规范回滚标签一致的 GHCR image digest（GHCR 镜像内容摘要）；
- 语料、模型、索引 identity（身份）是本次预期值；
- 漏洞扫描没有未接受的 critical/high finding（严重 / 高危发现）；
- 当前版本、目标版本和回滚 digest（内容摘要）明确；
- 数据、Secret（密钥）、Ingress（入口）或资源策略变更是否超出“只更新镜像”的适配器边界；
- 维护窗口、模型费用授权和回滚动作明确。

未来增加第二名维护者且 GitHub 套餐支持 Environment required reviewers（环境必需审核人）后，再把 production Environment（生产环境）升级为独立审核门禁，并启用 prevent self-review（禁止自我审核）；这不是当前第一阶段配置。

### 7.5 self-hosted deployment runner（自托管部署运行器）安全边界

直接发布选用生产节点上的专用 self-hosted deployment runner（自托管部署运行器），原因是它只需出站连接 GitHub，不要求向 GitHub 动态公网地址开放 22 或 6443。该选择同时引入“GitHub 工作流可在生产节点执行代码”的高权限边界，必须满足：

- 绑定生产运行器的仓库必须是 private repository（私有仓库）。第一阶段可以在仍为私有的当前源码仓库验证流程；源码仓库转为 public（公开）前必须先创建独立私有部署仓库，迁移生产 workflow/manifest/ledger/access-mode control（工作流 / 清单 / 台账 / 访问模式控制），从源码仓库移除并下线运行器，再把同一服务器运行器重新注册到私有部署仓库。Secret（密钥）仍只在 GitHub/Kubernetes（GitHub / 容器编排系统）配置面创建，不随文件迁移。
- 如果仓库属于支持该能力的 GitHub organization（GitHub 组织），运行器放入独立 runner group（运行器组），只允许当前仓库和固定 production deploy workflow（生产部署流水线）。工作流访问使用完整 owner/repository/path@ref（所有者 / 仓库 / 路径 / 引用），固定到受保护分支或完整 SHA（哈希）。参考：[GitHub runner group 访问控制](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)。
- 如果最终使用 personal private repository（个人私有仓库），只能注册 repository-level runner（仓库级运行器）时，必须明确接受它不能按单一 workflow（工作流）隔离的较低保证；所有能修改默认分支工作流的人都属于生产信任边界。此时唯一标签、专用 runner label（运行器标签）和“约定只由某个工作流使用”都不是访问控制，固定部署适配器、无 Secret（密钥）、不检出源码和默认分支保护成为强制门禁。
- production deploy workflow（生产部署流水线）和部署适配器路径由 CODEOWNERS（代码所有者）标识并单独查看 diff（差异）。当前只有一名维护者时，CODEOWNERS（代码所有者）不能形成独立批准，只提供变更可见性和审计线索。
- 运行器绝不执行 pull_request、pull_request_target、fork（分叉仓库）或任意分支的任务；Pull Request（合并请求）始终使用 GitHub-hosted runner（GitHub 托管运行器）。
- 运行器使用独立无登录、非 root 系统账号；不加入 docker group（Docker 组），不挂载 Docker socket（Docker 套接字），没有 SSH 私钥、模型 Secret（模型密钥）、GHCR 推送凭据或完整 K3s kubeconfig（K3s 客户端配置）。
- deploy job（部署任务）不运行 actions/checkout（仓库检出动作）、第三方 Action（流水线动作）或仓库中的 shell/JavaScript（命令行 / JavaScript）脚本。工作流只能调用 root 所有、不可由运行器账号修改的固定部署适配器。
- deploy job（部署任务）的 GITHUB_TOKEN 只授予验证 provenance（来源）和更新 deployment status（部署状态）所需的只读/写入最小权限；不得授予 contents:write、packages:write 或管理权限。
- 运行器账号的 sudoers（提权规则）只允许无参数、无交互调用该适配器；适配器只接受 deploy/rollback（部署 / 回滚）及经过 Phase 4（阶段 4）单独审核后增加的 set-access-mode private|portfolio（设置访问模式）签名信封。部署输入只接受 sha256:<64-hex> 格式的 digest（内容摘要）和大小受限的签名 provenance bundle（来源证明包）；模式输入只接受两个固定枚举值、已发布运维版本身份、当前镜像摘要和固定模式清单摘要。目标 GHCR repository/Namespace/Deployment/container/ConfigMap/Ingress（GHCR 仓库 / 命名空间 / 工作负载 / 容器 / 普通配置 / 入口）全部固定，禁止传入命令、文件路径、URL（网址）、manifest（清单）或额外 kubectl argument（Kubernetes 命令行参数）。
- 适配器在修改前用固定 trust root/workflow identity（信任根 / 工作流身份）独立验证证明包、镜像仓库、digest（内容摘要）和当前版本，证明包中的 subject digest（主体摘要）必须等于审核值；适配器不接收 GitHub token（GitHub 令牌），内部通过本机 K3s API（K3s 应用程序接口）操作，不把 admin kubeconfig（管理员客户端配置）暴露给运行器。
- 运行器只需出站 TCP 443 到经过审核的 GitHub Actions/GHCR（GitHub 流水线 / 容器仓库）端点；安装后重新核对监听端口，不能新增公网入站。
- runner work directory（运行器工作目录）权限受限并在每个任务后清理；日志只保留发布元数据，不输出环境、Secret（密钥）或 kubeconfig（Kubernetes 客户端配置）。
- runner service（运行器服务）、runner binary（运行器二进制）和部署适配器纳入版本、完整性、升级和撤销台账；runner offline（运行器离线）时部署安全失败，不回退公网 SSH 自动化。

不直接给运行器一个可任意 patch Deployment（修改工作负载）的 namespace kubeconfig（命名空间客户端配置），因为这类权限足以把恶意镜像放进现有 Secret（密钥）环境，实际影响接近读取应用密钥。固定部署适配器把可变输入收敛到已审核 digest（内容摘要），是本设计选择它的实际安全收益。

证明验证必须复用固定版本的 GitHub CLI（GitHub 命令行工具）或 Cosign（镜像签名工具），不自行实现签名算法：GitHub 证明使用离线 bundle/custom trusted root（证明包 / 自定义信任根），Sigstore（软件签名基础设施）证明固定 GitHub workflow identity/OIDC issuer（工作流身份 / 开放式身份签发者）。参考：[GitHub 离线验证 artifact attestation（产物证明）](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)、[Sigstore 验证签名](https://docs.sigstore.dev/cosign/verifying/verify/)。

部署适配器本身是 privileged security boundary（特权安全边界），不得以未经测试的几行 shell（命令行脚本）落盘。实现前必须单独设计并先写反例测试，至少覆盖参数注入、错误仓库、非 SHA-256、非法模式、未满足 portfolio（作品集展示）前置门禁、证明包超限/篡改/身份不符、并发发布或切换、切换顺序错误、超时、部分失败、回滚失败、日志泄露和重复执行；该实现不在本文授权范围内。

GitHub 明确说明 self-hosted runner（自托管运行器）不提供隔离，不可信 workflow（工作流）可能永久破坏运行器环境或窃取凭据。Environment approval（环境审核）只控制任务何时开始，不能修复运行器隔离问题。参考：[GitHub self-hosted runner 安全](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)、[GitHub Actions 安全加固](https://docs.github.com/en/actions/reference/security/secure-use)。

### 7.6 发布失败与回滚

- 部署适配器更新前记录当前 image digest（镜像内容摘要）。
- 新 Pod（容器组）在 rollout timeout（滚动发布超时）内未 ready（就绪）时，同一个已批准任务自动恢复记录的上一 digest（内容摘要），等待旧版本恢复，并把 GitHub deployment（GitHub 部署记录）标记为 failure（失败）。
- 部署已经成功但功能审核失败时，先由 GitHub-hosted runner（GitHub 托管运行器）生成只引用 release ledger（发布台账）内已验收历史 digest（内容摘要）的 draft rollback release（草稿回滚发布版本）；唯一维护者核对后手工 Publish release（发布版本）。同一个 release.published（发布版本已发布）部署流水线验证这是允许的回滚 digest（内容摘要）后，才调度生产运行器和固定部署适配器。
- 回滚后重新验证运行镜像 digest（内容摘要）、index identity（索引身份）、探针和关键安全反例。
- GitHub 或运行器不可用时，固定来源 SSH 是 break-glass（紧急处置）通道；人工回滚必须使用同一已验收 digest（内容摘要），完成后补录事故、命令和版本，不临时开放 22/6443。

### 7.7 引入 GitOps（拉取式部署管理）的触发条件

满足以下至少两项且 Actions direct deployment（流水线直接发布）已经稳定后再评审 Flux（拉取式持续交付工具）或 Argo CD（声明式持续交付工具）：

- 每月重复发布，人工操作成为主要失误来源；
- 出现 staging/production（预发布 / 生产）多个环境；
- 多名操作者需要审计、审批和漂移检测；
- 清单成为独立版本化事实源；
- 需要自动对账和声明式回滚。

GitOps（拉取式部署管理）必须由集群主动出站拉取，不因此开放公网 22 或 6443。没有上述收益时不增加控制器、凭据和运维面。

## 8. Kubernetes 资源设计

### 8.1 资源清单

| 资源 | 职责 | 核心约束 |
| --- | --- | --- |
| Namespace（命名空间） | 隔离应用、认证和证书资源 | 启用 Pod Security Standards restricted（Pod 安全标准受限级别）标签 |
| ServiceAccount（服务账户） | 应用身份 | 不绑定额外 RBAC（基于角色的访问控制），不自动挂载 token（令牌） |
| ConfigMap（普通配置） | 模型名、索引路径、ACCESS_MODE（访问模式）、公开主机名和 serving observation（在线观测）非敏感配置；Turnstile sitekey（Turnstile 站点公钥标识）仅在未来匿名模型体验启用 | 所有生产行为显式配置，不放秘密；访问模式只允许管理员固定动作修改 |
| Secret（密钥） | DeepSeek、Voyage、OAuth 和 cookie（浏览器会话）密钥；Turnstile（人机验证）及未来计量凭据只在对应设计批准后创建 | 按职责拆分；不进入 Git，不创建占位密钥 |
| imagePullSecret（镜像拉取密钥） | 拉取私有 GHCR 镜像 | 只读 packages（软件包）权限 |
| Deployment（工作负载） | 运行 Next.js（React 全栈框架） | replicas=1、固定 digest（内容摘要）、安全上下文和探针 |
| PersistentVolumeClaim（持久卷声明） | 安全 serving observation（在线观测）的轮转分段 | 小容量 local-path（本地路径）卷；只存严格协议的安全观测，不存索引、原始 YAML、回答、计量状态或 Secret（密钥） |
| ClusterIP Service（集群内服务） | 稳定暴露容器 3000 端口 | 不使用 NodePort（节点端口）或 LoadBalancer（负载均衡器）直接公开应用 |
| Ingress / IngressRoute（入口 / Traefik 入口路由） | 入口身份、TLS（传输层安全）、访问模式路由和保护中间件 | private（私有）只指向认证代理 Service（服务）；portfolio（作品集展示）只能额外开放已审核匿名路由 |
| oauth2-proxy Deployment/Service（认证代理工作负载 / 服务） | GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单和受保护路由反向代理 | 镜像固定 digest（内容摘要）；只接受 Traefik（入口控制器）入站，限制可信代理网段，删除其负责注入的客户端身份头后从已验证会话重新注入 |
| Certificate/Issuer（证书 / 签发器） | ACME（自动证书管理环境）签发和续期 | 先 staging（预发布签发器）验证，再 production（生产签发器） |
| NetworkPolicy（网络策略） | 限制入站和不必要的东西向访问 | 不宣称标准策略能按域名限制 DeepSeek/Voyage 出站 |

### 8.2 Deployment（工作负载）策略

初始候选值：

| 字段 | 候选值 | 验证要求 |
| --- | --- | --- |
| replicas | 1 | 明确无高可用 |
| strategy | RollingUpdate（滚动更新） |
| maxUnavailable | 1 | 单副本更新时允许短暂不可用，为本地 observation sink（观测写入端）的单写入进程创造前提 |
| maxSurge | 0 | 不主动扩出第二个应用副本；仍需验证 terminating Pod（终止中的容器组）不会与新进程同时写入 |
| revisionHistoryLimit | 3 | 结合 GHCR 固定 digest（内容摘要）保留回滚入口 |
| minReadySeconds | 10 | 私有压测后调整 |
| progressDeadlineSeconds | 600 | 索引加载必须在上限内，否则发布失败 |
| terminationGracePeriodSeconds | 60 | 验证 SSE（服务器发送事件）断开边界 |

单副本 RollingUpdate（滚动更新）明确接受应用更新窗口：镜像拉取、索引加载和探针就绪期间可能不可用，SSE（服务器发送事件）连接会中断。`maxSurge=0` 不能单独证明进程级无重叠；Phase 3（阶段 3）必须通过终止钩子、writer lifecycle（写入端生命周期）和故障注入证明旧 writer（写入端）关闭后新 writer（写入端）才打开。若该不变量不能在标准 Deployment（工作负载）中可靠成立，必须停止并在 Recreate（重建更新）或真实多写入端 observation backend（观测后端）之间重新 review（审核），不能接受短暂双写。以后要求 `maxUnavailable=0`、多副本或跨节点时必须选择后者。

只有受控的 `data/observability/` 挂载为持久可写目录，应用固定使用其内部自行创建的 `0700` `segments/` 子目录作为写入根目录；`/tmp` 使用有上限的 emptyDir（临时卷），其他应用路径保持只读。Pod securityContext（Pod 安全上下文）使用与 non-root user（非 root 用户）一致的 `fsGroup` 候选值 10001 和 `fsGroupChangePolicy=OnRootMismatch`，Phase 3（阶段 3）必须验证 local-path（本地路径）卷权限；不得添加 privileged init container（特权初始化容器）执行宽泛 `chmod`。未来计量模块需要的持久状态必须等待独立设计，不能复用 observation PVC（观测持久卷声明）。

### 8.3 probes（探针）

必须新增两个不调用外部模型的端点：

- /api/health/live：只证明进程事件循环和 HTTP（超文本传输协议）服务存活，不读取 DeepSeek/Voyage。
- /api/health/ready：校验显式配置、schema closure（模式闭包）、alias/policy（别名 / 策略）输入和 index identity（索引身份）已成功加载；不发送外部探测。

两个端点只返回状态和封闭错误码，不返回路径、哈希明细、环境变量或供应商错误。Kubernetes probe（Kubernetes 探针）直接访问 Pod（容器组）；健康端点不经公网 Ingress（入口）暴露。OAuth callback（OAuth 回调）和 cert-manager solver（证书管理器验证路由）是独立的最小旁路，不能复用为匿名模型入口。serving observation（在线观测）的单次写入失败不触发 liveness（存活状态）失败或重启循环，但 recorder（记录器）关闭、配置非法、目录不可写和连续错误必须暴露为独立安全状态、告警并阻止 portfolio（作品集展示）公开验收。未来计量或 Turnstile（人机验证）异常不使公开静态页面整体 liveness（存活状态）失败，但必须关闭匿名模型能力并返回封闭错误码。

探针建议：

- startup probe（启动探针）：允许首次索引加载和 Node.js（JavaScript 运行时）预热；在它成功前不执行 liveness probe（存活探针）。
- readiness probe（就绪探针）：失败立即摘流；索引失效必须失败。
- liveness probe（存活探针）：只检测本地进程，不因 DeepSeek/Voyage 故障重启 Pod（容器组），避免 retry storm（重试风暴）。

具体 periodSeconds、timeoutSeconds 和 failureThreshold 必须用私有部署的冷启动、负载和故障注入数据确定，不能把候选值冒充实测值。参考：[Kubernetes 探针文档](https://kubernetes.io/docs/concepts/workloads/pods/probes/)。

### 8.4 资源 requests/limits（资源请求 / 上限）

4 vCPU、8 GiB 节点的第一轮候选值：

| 资源 | requests（请求） | limits（上限） |
| --- | ---: | ---: |
| CPU | 500m | 2 |
| memory（内存） | 768 MiB | 2 GiB |
| ephemeral-storage（临时存储） | 256 MiB | 1 GiB |

这些值没有经过生产流量测量。Phase 3（阶段 3）必须记录：

- 冷启动和索引加载峰值 RSS（常驻内存）；
- Ask/Generate/Fix（询问 / 生成 / 修复）并发时的内存、CPU 和 event loop lag（事件循环延迟）；
- K3s、Traefik（入口控制器）、cert-manager（证书管理器）、oauth2-proxy（认证代理）和单个应用 Pod（容器组）同时存在时的节点余量；
- serving observation（在线观测）的轮转、清理、磁盘增长、目录权限和滚动更新单写入端边界；
- OOMKilled（内存超限终止）、CPU throttling（CPU 节流）和临时存储增长。

JavaScript 内存中的向量和对象会明显大于约 37 MiB 的磁盘索引，不能按文件大小估算内存。资源限制的语义参考：[Kubernetes 容器资源管理](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)。

### 8.5 网络和配置

- private（私有）模式中，oauth2-proxy（认证代理）是应用唯一业务入站来源，Traefik（入口控制器）只能访问认证代理；应用和认证代理 Service（服务）均仅使用 ClusterIP（集群内地址）。
- portfolio（作品集展示）模式只为固定匿名路由增加 Traefik（入口控制器）到应用的访问；对应入口必须删除应用认可的全部身份头。受保护路由仍经过 oauth2-proxy（认证代理），模式切换必须替换同名 NetworkPolicy（网络策略），不能依赖多个策略相互覆盖，因为 NetworkPolicy（网络策略）规则按并集生效。
- 应用允许 DNS（域名系统）解析和出站 443 到模型供应商。标准 NetworkPolicy（网络策略）不提供可靠的域名 allowlist（允许名单）；未部署专用 egress proxy（出站代理）前不能声称已按域名隔离。
- ConfigMap（普通配置）显式设置 DEEPSEEK_BASE_URL、DEEPSEEK_ANSWER_MODEL、VOYAGE_EMBEDDING_URL、VOYAGE_RERANK_URL、VOYAGE_EMBEDDING_MODEL、VOYAGE_RERANK_MODEL、INDEX_DIR、ENABLE_QUERY_EXPANSION、ACCESS_MODE、MODEL_ACCESS_ENABLED、NODE_ENV、PORT、HOSTNAME 和 serving observation（在线观测）的完整非敏感配置。缺失、未知或非法供应商配置使就绪检查失败；缺失或非法 ACCESS_MODE（访问模式）按 private（私有）处理，MODEL_ACCESS_ENABLED 只有精确 `true` 才启用模型路由。不在计量设计前添加 Turnstile sitekey（Turnstile 站点公钥标识）或匿名额度变量。
- DEEPSEEK_API_KEY 和 VOYAGE_API_KEY 使用 secretKeyRef（密钥引用）注入；Turnstile secret key（Turnstile 服务端密钥）、未来计量或 Interview Pass（面试临时通行证）密钥由对应设计确定，日志不得打印完整环境。
- 应用 ServiceAccount（服务账户）不授予读取或修改 ConfigMap/Secret/Ingress（普通配置 / 密钥 / 入口）的 Kubernetes API（Kubernetes 应用程序接口）权限；配置只在 Pod（容器组）启动时注入，模式变更必须经过受控 rollout（滚动更新）。

## 9. 网络、域名与公开访问

### 9.1 已核对服务器事实

Phase 1（阶段 1）实施后核对：

- 华为云 Flexus 应用服务器 L；
- 华北-北京四；
- Ubuntu 24.04.4；
- 4 vCPU、8 GiB 内存、180 GiB 系统盘；
- 峰值带宽 6 Mbps、流量包 1,200 GB；
- 公网 IPv4：120.46.57.214；
- SSH 已从本机验证；
- SSH 22 只允许实施日核对的 `42.232.250.103/32`，来源变化时必须重新审核；
- K3s（轻量 Kubernetes）`v1.36.2+k3s1` 已安装，节点和系统组件健康；
- 6443、10250、8472、80 和 443 均不对公网开放。

详细非敏感证据维护在 `deploy/k3s/README.md`；服务器 Secret（密钥）、完整 kubeconfig（客户端配置）和云控制面详情不写入本文。

### 9.2 公网入口身份

- 当前不注册或依赖域名，不创建 A/AAAA record（IPv4 / IPv6 地址记录），也不把临时免费域名作为生产事实。
- 固定访问源为 `https://120.46.57.214`，固定基础路径为 `/k8s-yaml-assistant`。Next.js（前端框架）在构建时固定同一 `basePath`（基础路径）；前端请求、探针、IngressRoute（入口路由）和 oauth2-proxy（认证代理）必须复用该路径。
- Certificate（证书）只声明 `ipAddresses: [120.46.57.214]`，Issuer（签发器）使用 Let’s Encrypt（免费证书颁发机构）的 `shortlived`（短期证书）profile（配置档）。IP 证书约 6 天有效，只有自动续期和故障告警通过后才能进入公开门禁。
- IP 客户端可能不发送 SNI（服务器名称指示）。Traefik（入口控制器）必须把同一证书配置为集群唯一 `default` TLSStore（默认传输层安全证书仓库）证书；发现其他 `default` TLSStore（默认传输层安全证书仓库）时停止，不覆盖未知入口。
- GitHub OAuth callback（GitHub OAuth 回调）固定为 `https://120.46.57.214/k8s-yaml-assistant/oauth2/callback`。未来如注册域名，必须把证书、回调、路由和 OAuth App（OAuth 应用）作为同一单独审核变更，不能同时保留两个未审核入口。

### 9.3 安全组和端口

| 端口 | Phase 3（阶段 3） | Phase 4（阶段 4） | Phase 5（阶段 5） |
| --- | --- | --- | --- |
| 22/TCP | 仅 42.232.250.220/32 | 保持不变 | 保持不变，来源变化时先审核再改 |
| 80/TCP | 不公开 | 对公网开放，但只服务 ACME HTTP-01（ACME HTTP 验证）；其他路径固定拒绝，不代理应用 | 保持开放，只服务挑战和跳转 |
| 443/TCP | 不公开 | 只允许 42.232.250.220/32 或另行审核的测试来源，暴露 TLS（传输层安全）入口、认证和保护中间件 | 全部门禁通过后才对公网开放；private（私有）只服务允许名单，portfolio（作品集展示）开放页面、不调用外部模型的 YAML 检查和受控匿名体验 |
| 6443/TCP | 不公开 | 不公开 | 不公开 |
| K3s 内部端口 | 不在公网安全组开放 | 同左 | 同左 |

80 端口对 HTTP-01（HTTP 验证）签发和续期需要公网可达；Phase 4（阶段 4）只允许 cert-manager solver（证书管理器验证路由）响应 challenge（挑战），其他路径不得代理到应用。Phase 5（阶段 5）才增加到 HTTPS（安全超文本传输协议）的固定跳转。参考：[Let's Encrypt 允许 80 端口的说明](https://letsencrypt.org/docs/allow-port-80/)、[cert-manager HTTP-01 文档](https://cert-manager.io/docs/configuration/acme/http01/)。

公网 IP 证书不能使用 DNS-01（DNS 验证）。如果不能接受签发和约每 6 天续期所需的 80/TCP HTTP-01（HTTP 验证），当前方案停止；不能临时关闭证书验证或降级为明文 HTTP（超文本传输协议）。

K3s（轻量 Kubernetes）与 Ubuntu firewall（Ubuntu 防火墙）的组合必须按官方网络要求审核。不能一边随意启用 UFW（Ubuntu 防火墙），一边遗漏 Pod/Service CIDR（容器组 / 服务网段）和 K3s 端口；华为云安全组仍是外层边界。参考：[K3s 安装要求](https://docs.k3s.io/installation/requirements)、[K3s 基础网络选项](https://docs.k3s.io/networking/basic-network-options)。

### 9.4 首次私有验证

Phase 3（阶段 3）不开放 80/443。推荐两种只读访问路径：

1. 在服务器上把 ClusterIP Service（集群内服务）临时 port-forward（端口转发）到 127.0.0.1，再从本机建立 SSH tunnel（SSH 隧道），验证 UI（用户界面）、API（应用程序接口）和探针。
2. Ingress（入口）和临时证书就绪后，把本机 8443 隧道到服务器 127.0.0.1:443，验证 IP SAN（IP 主题备用名称）、无 SNI（服务器名称指示）证书选择、认证跳转和固定语义路径；不改变安全组。

示意命令中的 <namespace>、<service> 和 <server-alias> 必须替换为审核后的真实值：

~~~sh
sudo k3s kubectl -n <namespace> port-forward service/<service> 18080:3000 --address=127.0.0.1
ssh -N -L 18080:127.0.0.1:18080 <server-alias>
curl --fail http://127.0.0.1:18080/api/health/ready

ssh -N -L 8443:127.0.0.1:443 <server-alias>
curl --fail --head --resolve 120.46.57.214:8443:127.0.0.1 https://120.46.57.214:8443/k8s-yaml-assistant
~~~

port-forward（端口转发）只用于人工验证，不是常驻代理或生产入口。不得把完整 kubeconfig（Kubernetes 客户端配置）复制到本机来图省事。

### 9.5 access mode（访问模式）与管理员控制

明确推荐保留 GitHub OAuth 2.0（GitHub 开放授权 2.0）、oauth2-proxy（OAuth 2.0 认证代理）和显式 allowlist（允许名单），但不再要求所有作品集访客登录。受保护路由采用 oauth2-proxy reverse proxy（认证代理反向代理），不采用 ForwardAuth（前置认证）：固定版本认证代理先删除它负责设置的、包括大小写和下划线变体在内的客户端 `X-Forwarded-*` 身份头，再从成功会话注入 `X-Forwarded-User`；应用只把该字段作为当前主体输入，不把 `X-Auth-Request-*`、`Authorization` 或任意客户端字段当作身份。private（私有）NetworkPolicy（网络策略）只允许认证代理访问应用，认证代理只允许 Traefik（入口控制器）访问；两者共同构成信任边界。参考：[oauth2-proxy 配置文档](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/)。

| 路由类别 | private（私有） | portfolio（作品集展示） |
| --- | --- | --- |
| 页面和静态资源 | GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单 | 匿名公开 |
| /api/check | 允许名单 | 匿名公开，但保留入口速率和请求体限制 |
| Ask/Generate/Fix（询问 / 生成 / 修复） | 允许名单和费用门禁 | 默认仍要求允许名单；只有独立计量设计和保护门禁完成后才增加匿名会话及 Interview Pass（面试临时通行证） |
| 管理操作 | 不提供公网管理 API（应用程序接口） | 不提供公网管理 API（应用程序接口） |
| 健康端点 | 仅 Kubernetes probe（Kubernetes 探针）内部访问 | 同左 |

ACCESS_MODE（访问模式）由 ConfigMap（普通配置）注入，但只有私有部署仓库、固定部署适配器和固定来源 SSH（安全远程登录）紧急路径可以修改；应用 ServiceAccount（服务账户）、oauth2-proxy（OAuth 2.0 认证代理）、浏览器和公开路由都没有写权限。不能把模式开关做成隐藏网页、特殊请求头、URL（网址）参数或未记录的“后门”。

BasicAuth（基础认证）只可作为 Phase 3（阶段 3）短期私有验证的第二道临时门，不是 Phase 5（阶段 5）公开发布或模式管理方案。

### 9.6 匿名体验与 Interview Pass（面试临时通行证）

portfolio（作品集展示）模式不建立用户注册、密码、邮箱或个人资料系统。计量模块完成前，访客可以直接打开页面并使用不调用外部模型的 YAML 检查；Ask/Generate/Fix（询问 / 生成 / 修复）仍要求 allowlist（允许名单）身份，匿名付费模型路由保持关闭。

后续匿名模型体验继续采用 Cloudflare Turnstile（Cloudflare 人机验证服务）和短期安全会话的方向：第一次付费模型调用必须由服务端通过 Siteverify API（令牌校验接口）验证 challenge token（挑战令牌），不能只相信浏览器结果。Turnstile（人机验证服务）只能降低自动化滥用，不能证明身份或替代费用硬边界。参考：[Turnstile 概览](https://developers.cloudflare.com/turnstile/)、[Turnstile 服务端校验流程](https://developers.cloudflare.com/turnstile/get-started/)、[Turnstile 套餐](https://developers.cloudflare.com/turnstile/plans/)。

匿名额度的数值、会话状态、来源约束、存储介质、原子扣减、预留/结算、对账、过期和恢复均不在本文提前设计。实施到该阶段时，必须先基于真实 token/usage/cost（令牌 / 用量 / 成本）数据形成独立计量设计，再决定最小实现。无论最终方案如何，都不得保存原始请求、回答、明文 IP（互联网协议地址）、cookie（浏览器会话）或供应商凭据；会话凭据不得进入 URL（网址）、localStorage（浏览器本地存储）或前端脚本可读区域。参考：[OWASP Session Management（OWASP 会话管理）](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[OWASP 敏感数据 URL 边界](https://cornucopia.owasp.org/taxonomy/asvs-5.0/14-data-protection/02-general-data-protection)。

Interview Pass（面试临时通行证）保留为后续明确需求，而不是隐藏“后门”。它必须由管理员签发、明文只显示一次、不可放入简历 URL（网址）或日志、仅能兑换一次、自动过期、可提前撤销，并始终受有限总预算、单请求上限、并发限制、全局费用熔断和 emergency stop（紧急停止）约束。禁止真正无限 token（令牌）、无限费用或永不过期的角色。具体签发方式、凭据哈希、有效期、额度、持久状态和删除机制与计量模块一起设计；在该设计审核前不创建占位命令、数据库表或 Secret（密钥）。

### 9.7 公开前共同保护门禁

无论 ACCESS_MODE（访问模式）为何值，付费模型调用都必须具备：

1. body limit（请求体上限）：Traefik（入口控制器）先限制总字节，应用再做流式有界读取和 runtime schema decode（运行时模式解码）。全局硬上限不得超过既有 observation design（观测设计）的 256 KiB；不同路由可更低。Content-Length 缺失或 chunked transfer（分块传输）也必须受限，超限返回 413。入口实现参考：[Traefik Buffering 文档](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/)。
2. edge rate limit（入口速率限制）：认证前按可信来源 IP（互联网协议地址）限制登录、Turnstile（人机验证）和通行证兑换；会话建立后按受控主体标识限制模型路由。Traefik（入口控制器）负责第一层，应用负责角色、路由权重和费用语义。只能信任 Traefik（入口控制器）覆盖后的代理头，不能直接信任客户端 X-Forwarded-For。参考：[Traefik RateLimit 文档](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/)。
3. concurrency limit（并发限制）：全局和单主体并发必须显式受限；真实值根据 8 GiB 内存、上游配额和延迟验证，匿名与 Interview Pass（面试临时通行证）的角色值等待计量设计。
4. endpoint quota（端点配额）：/api/check 是本地校验，可使用独立速率限制；Ask/Generate/Fix（询问 / 生成 / 修复）的 token/cost（令牌 / 成本）权重、累计额度和角色差异由后续计量设计决定，不能用一个通用每分钟次数冒充费用控制。
5. cost circuit breaker（费用熔断器）：private（私有）少量允许名单阶段至少配置单请求最大输入、最大输出 token（令牌）、模型超时、有限重试、人工预算和已验证的供应商侧硬额度。匿名和 Interview Pass（面试临时通行证）必须等待本地计量事实源、调用前费用边界及调用后实际 usage（用量）对账全部通过审核；本文不指定数据库或结算算法。
6. safe failure（安全失败）：超限返回 413/429，Turnstile（人机验证）、未来计量模块、供应商或 key（密钥）失败返回不泄露细节的 502/503 和 request ID（请求标识）；响应、日志均不回显供应商原始错误体、用户 YAML 或密钥。费用状态不确定时不能“先放行后补账”。
7. abnormal traffic response（异常流量响应）：入口 401/403/413/429/5xx 比例、验证失败、通行码猜测、并发拒绝和上游费用异常触发告警；首先把 ACCESS_MODE（访问模式）切回 private（私有）或把模型路由额度降为 0，必要时再关闭 443 安全组或停用 Ingress（入口），不能依赖应用继续承压。

Phase 4（阶段 4）的 allowlist（允许名单）保守速率测试候选值仍为：认证前每 IP 每分钟 30 次、burst（突发）10 次；/api/check 每主体每分钟 60 次、突发 20 次；/api/ask 每主体每分钟 6 次、突发 2 次；/api/generate 每主体每分钟 2 次、突发 1 次；/api/fix 每主体每分钟 3 次、突发 1 次。这些值只验证入口和应用拒绝语义，不是 token/usage/cost（令牌 / 用量 / 成本）额度，也不是容量承诺。匿名和 Interview Pass（面试临时通行证）的所有累计值等待独立计量设计；必须保留把模型路由调用能力立即关闭的 emergency stop（紧急停止）能力。

2026-07-28 Task 15（任务 15）候选已把上述应用侧速率、有限键空间、全局/单主体并发、模型紧急停止、上游超时和有限重试落盘。DeepSeek（回答模型）每次上游调用的输出固定为 `max_tokens=2048`，构造后的模型请求另受 256 KiB 序列化字节上限；该字节边界不等于精确输入 token（令牌）计数。DeepSeek（回答模型）官方说明不同模型的分词方法可能不同，实际处理量以响应 usage（用量）为准；在 V4（第 4 代模型）调用前精确计数契约和供应商费用硬额度得到验证前，cost circuit breaker（费用熔断器）门禁仍未完成，匿名模型能力保持关闭。参考：[DeepSeek Token Usage（DeepSeek 令牌用量）](https://api-docs.deepseek.com/quick_start/token_usage/)。

Traefik（入口控制器）的短窗口内存限流重启后会清空，只是第一层削峰，不能作为费用事实源。未来计量设计必须另行证明跨重启总预算和 Interview Pass（面试临时通行证）状态；在此之前匿名模型调用保持关闭。

## 10. 数据、隐私与 serving trace（在线轨迹）

### 10.1 数据分类

Ask 请求可能包含用户 YAML、选中内容、校验错误、Kubernetes Secret（Kubernetes 密钥）、私钥、token（令牌）、URL credential（网址凭据）和集群资源配置。它们默认按敏感工作负载数据处理，而不是普通聊天文本。

portfolio（作品集展示）页面必须明确区分“只在服务内执行、不调用外部模型的本地检查”和“会把必要输入发送给 DeepSeek/Voyage 的模型能力”。第一次模型调用前展示简短隐私告知和“不要提交 Secret（密钥）、私钥或生产集群敏感配置”的提示，并链接完整隐私说明；未完成供应商数据处理条款、数据保留和跨境边界审核前不能开启匿名模型体验。Turnstile（人机验证服务）只接收浏览器挑战信号和验证 token（令牌），应用不得把 YAML、选中内容、prompt（提示词）或回答发送给 Turnstile（人机验证服务）。如果使用 invisible mode（不可见模式），隐私说明必须引用 Cloudflare Turnstile Privacy Addendum（Cloudflare Turnstile 隐私附录）。参考：[Turnstile 隐私要求](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/turnstile/)。

应用和入口日志只允许记录：

- 服务端 request ID（请求标识）；
- 路由、状态码、总耗时、有限的错误码；
- 访问主体的不可逆受控标识：当前为允许名单主体；未来计量设计实施后可以增加匿名会话或 Interview Pass（面试临时通行证）grant ID（授权标识）的受控哈希；不记录邮箱、原始 IP（互联网协议地址）、OAuth token（OAuth 令牌）、通行码或 cookie（浏览器会话）；
- 上游名称、结果类别和有限 usage/cost metadata（用量 / 成本元数据），前提是没有输入输出内容；
- index/corpus identity（索引 / 语料身份）。

禁止记录 request body（请求体）、YAML、选中内容、模型 prompt（提示词）、模型 answer（回答）、Authorization header（认证头）、cookie（浏览器会话）、环境变量值或供应商原始错误体。

### 10.2 复用既有安全设计

docs/superpowers/specs/2026-07-14-serving-observation-safety-design.md 是 serving observation（在线观测）落盘的现有设计依据。生产部署必须复用其契约：

- 未配置或配置非法时默认 mode=off；这是代码安全默认值，不是通过门禁后的生产目标状态；
- 持久化前做 allowlist projection（允许名单投影），不直接序列化 RetrievalTrace；
- 在 JSON（JavaScript 对象表示）序列化前进行结构化 YAML/JSON（YAML / JavaScript 对象表示）脱敏；
- 脱敏失败、不确定或二次敏感扫描失败时丢弃字段或整条 observation（观测），绝不回退原文；
- 按服务端 request ID（请求标识）做与内容无关、稳定的采样；
- maxInputBytes 不超过 256 KiB、maxTextBytes 不超过 16 KiB、maxFileBytes 不超过 128 MiB、maxTotalBytes 不超过 1 GiB、retentionDays 为 1..30；
- 按 UTC（协调世界时）日期和文件大小轮转，同时执行保留期和总容量上限；
- 只删除受控命名的普通文件，不跟随 symlink（符号链接），提供人工删除机制；
- 配置、脱敏、采样、轮转、写入或删除失败不影响 Ask 主流程，但只发出不含 payload（负载）的安全错误码。

这些数值是 hard cap（硬上限），不是生产默认值。真正启用前仍需显式选择更小的 file size/total size/retention（文件大小 / 总容量 / 保留期），并写反例测试。持续启用的是安全 recorder（记录器）及其生命周期管理，不是原始 `RetrievalTrace`（检索轨迹）；即使 `sampleRate=1`，疑似敏感、脱敏失败、超限或写入失败的 observation（观测）仍必须丢弃。

### 10.3 生产决策

生产目标是安全 serving observation（在线观测）持续启用，且不随 ACCESS_MODE（访问模式）切换而关闭。在以下所有门禁完成前，只允许关闭现有原始落盘，不能提前启用生产持久化：

- app/api/ask/route.ts 不再默认注入 raw trace sink（原始轨迹写入端）；
- src/retrieval/trace.ts 不再暴露可绕过安全协议的原始文件 writer/reader（写入器 / 读取器）；
- schema（模式）、allowlist projection（允许名单投影）、redaction（脱敏）、稳定采样和安全失败已按既有计划实现并通过反例测试；
- rotation transport（轮转传输）和同步请求路径或有界队列的执行模型经过单独审核；
- 文件权限、轮转、保留、删除、1 GiB 以下生产实际磁盘上限和磁盘告警经过故障测试；
- 隐私告知、访问权限和人工删除流程已确认。

当前单节点、单副本和低流量作品集阶段推荐显式审核后的 local sink（本地写入端），不引入远程 observability backend（可观测后端）。生产值先按以下 candidate profile（候选配置）做私有容量、隐私和故障测试，审核后才能固化：

| 配置 | 候选值 | 原因与门禁 |
| --- | ---: | --- |
| mode | local | 安全实现全部通过后显式启用；缺失或非法仍关闭 |
| sampleRate | 1 | 低流量阶段保留每个符合安全协议的 Ask（询问）观测，支持后续 feedback correlation（反馈关联）；不改变敏感记录丢弃规则 |
| maxInputBytes | 128 KiB | 小于既有 256 KiB hard cap（硬上限）；超过后不处理或保存 question（问题文本） |
| maxTextBytes | 8 KiB | 限制脱敏后文本体积；超过后按 UTF-8（Unicode 字符编码）安全截断并标记 |
| maxFileBytes | 16 MiB | 便于轮转、检查和删除 |
| maxTotalBytes | 256 MiB | 与 180 GiB 系统盘隔离出明确应用硬边界 |
| retentionDays | 7 | 给人工筛选留出短窗口，不把 trace（轨迹）当长期数据仓库 |

安全文件写入独立 local-path PVC（本地路径持久卷），挂载到应用固定的 `data/observability/` 目录，local sink（本地写入端）只使用应用创建的 `data/observability/segments/` 私有子目录；申请容量候选值为 1 GiB，但应用自身仍以 256 MiB 候选总量硬边界执行轮转和清理，因为 K3s local-path provisioner（K3s 本地路径制备器）不一定执行卷容量配额。该 PVC（持久卷声明）只保存受控命名的安全 observation segment（观测分段），不保存 data/index、原始 YAML、回答、Secret（密钥）、计量状态或旧 `serving-traces.jsonl`。索引仍随镜像交付，不因此改用 PVC（持久卷声明）。

既有 local sink（本地写入端）只允许受控单进程写入。生产应用先以 RollingUpdate（滚动更新）的 `maxSurge=0`、`maxUnavailable=1` 候选策略接受单副本更新期间的短暂不可用，但该配置本身不证明 terminating Pod（终止中的容器组）已经停止写入。Phase 3（阶段 3）必须证明 writer lifecycle（写入端生命周期）无重叠；证明失败就停止，并在 Recreate（重建更新）与经过审核的多写入端 observability backend（可观测后端）之间重新选择。若以后要求无中断更新、多副本或跨节点，必须使用后者，不能扩展本地文件协议冒充分布式日志系统。

生产正常配置不能把 mode=off 当作常态。部署前置校验发现 recorder（记录器）关闭、配置非法、目录权限错误或生命周期测试失败时，不得开放 portfolio（作品集展示）；运行中的单次脱敏、轮转或写入失败仍按既有契约 fail open（失败时放行）Ask（询问）主流程，只发安全错误码，不回退原始落盘。持续错误达到审核后的告警阈值时，管理员先把 ACCESS_MODE（访问模式）切回 private（私有）并处理磁盘或 recorder（记录器）故障；不能为了“保持有 trace（轨迹）”而保存未脱敏内容。

Pod stdout/stderr（容器标准输出 / 错误输出）同样受上述内容禁令约束，不能把 console（控制台）当作 observation sink（观测写入端），也不能在 recorder（记录器）故障时把请求体写入日志补偿。

### 10.4 feedback（反馈）与 bad case（问题用例）回流边界

现有 serving observation（在线观测）设计只覆盖 Ask retrieval（询问检索）的安全诊断元数据，不保存 answer（回答），也不构成可完整回放的 eval trace（评估轨迹）。Generate/Fix（生成 / 修复）的反馈和采纳信号必须在后续 Stage 7（阶段 7）使用各自严格 schema（模式）设计，不能把通用原始请求记录器接到所有路由。

后续线上 feedback（反馈）按以下边界与持续 observation（观测）关联：

1. 服务端生成 `requestId` 和 `observationId`；浏览器只能回传受控关联标识和封闭反馈枚举，不能指定文件路径或注入任意 trace（轨迹）字段。
2. 点赞、点踩、未解决或采纳信号写入独立的最小 feedback event（反馈事件）；它不修改已落盘 observation（观测），也不自动复制用户 YAML、回答或 Secret（密钥）。
3. 负反馈只生成待审核 candidate（候选项）。如果安全 observation（在线观测）不足以复现问题，后续反馈设计可以提供由用户明确同意、主动提交且先行脱敏的最小复现材料；该能力不是本文授权的原始内容留存旁路。
4. 维护者在 7 天 trace retention（轨迹保留期）内筛选候选，人工脱敏、重建可复现输入并核对依据；审核完成的独立评估 fixture（评估固件）不再依赖线上 trace（轨迹）文件。
5. 只有人工确认的候选才能进入 `data/eval`，并标记 `origin='bad_case'`、`role='regression'`；禁止自动进入 eval set（评估集）、baseline（基线）或 Holdout（留出集）。
6. 原始 observation（观测）到期后按统一删除机制清理；不得因为候选尚未审核而静默延长全目录保留期，也不备份旧原始 trace（轨迹）。

这一路径使线上真实问题可以转化为受治理的 bad case（问题用例），同时承认安全 observation（在线观测）不是用户请求副本。完整反馈 schema（模式）、用户告知、候选队列、审核界面和删除请求处理仍需在 Stage 7（阶段 7）实施前单独设计。

## 11. 运维、容量与恢复

### 11.1 日常查看

建议的只读命令：

~~~sh
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get pods -A -o wide
sudo k3s kubectl -n <namespace> get deploy,rs,pod,svc,ingress
sudo k3s kubectl -n <namespace> logs deployment/<app> --since=30m
sudo k3s kubectl -n <namespace> logs deployment/<app> --previous
sudo k3s kubectl -n <namespace> describe pod <pod>
sudo k3s kubectl get events -A --sort-by=.metadata.creationTimestamp
sudo k3s kubectl top nodes
sudo k3s kubectl top pods -A
sudo journalctl -u k3s --since "30 minutes ago"
df -h
sudo du -x -h -d 2 /var/lib/rancher/k3s
~~~

日志查看必须避免复制整段可能含敏感数据的输出到工单或对话。故障记录只摘录安全错误码、request ID（请求标识）、时间、版本和资源指标。

### 11.2 监控最小集

- Node（节点）：CPU、load average（平均负载）、可用内存、swap（交换空间）、磁盘使用率、inode（索引节点）、磁盘延迟、网络流量。
- K3s（轻量 Kubernetes）：server（服务端）状态、节点 Ready（就绪）、系统 Pod（容器组）、证书、重启和事件。
- 应用：ready/live（就绪 / 存活）、ACCESS_MODE（访问模式）、冷启动、RSS（常驻内存）、event loop lag（事件循环延迟）、请求状态、上游延迟、429/5xx、SSE（服务器发送事件）中断。
- 发布：生产 runner online/offline（运行器在线 / 离线）、收到的 workflow/job（工作流 / 任务）、发布确认账号、Release ID（发布版本标识）、前后 digest（内容摘要）、rollout/rollback（滚动发布 / 回滚）结果和未预期任务；发现非部署任务立即停用运行器。
- 安全：模式切换、认证和 Turnstile（人机验证）失败、image digest（镜像内容摘要）漂移、Secret（密钥）轮换时间，以及 serving observation（在线观测）的启用状态、丢弃原因计数、轮转/清理错误和总磁盘量；不记录被丢弃内容。
- 费用：当前先核对供应商账户余额、硬额度和聚合调用数；按匿名、Interview Pass（面试临时通行证）和允许名单角色贯通 token/usage/cost（令牌 / 用量 / 成本）的指标、对账和告警，等待独立计量设计，不从 serving observation（在线观测）推导账单事实。

在引入 Prometheus（指标监控系统）和 Grafana（可视化系统）前，先使用 K3s metrics-server（资源指标服务）、云监控、结构化安全日志和明确的人工巡检。只有需要趋势、告警和 SLO（服务等级目标）时才引入完整监控栈。

### 11.3 180 GiB 磁盘边界

- 系统盘同时承载 Ubuntu、K3s、containerd（容器运行时）、镜像层、K3s SQLite（嵌入式数据库）、系统日志和临时文件。
- 安全 serving observation（在线观测）使用独立小容量 PVC（持久卷声明），候选应用硬上限为 256 MiB、保留 7 天；同时监控卷所在系统盘。达到保留期或总量边界时只按既有协议删除最旧受管分段；无法安全回收空间时丢弃新 observation（观测）并告警，绝不删除未知文件或回退原始日志。容器 stdout/stderr（标准输出 / 错误输出）另行轮转并限制单文件和总量。
- 未来计量状态的磁盘边界等待计量设计；不得复用 observation PVC（观测持久卷声明）或通过清空状态恢复费用额度。
- 自托管运行器工作目录和诊断日志设置容量、保留和任务后清理，不保留 checkout（检出）、artifact（产物）或环境快照。
- GHCR 保留不可变镜像；节点只保留当前、上一已验收版本和必要构建缓存，不在服务器执行镜像构建。
- 候选告警阈值为 70% 提醒、80% 阻止发布、90% 关闭非必要写入并人工处置；需与华为云监控能力核对。
- K3s 和 containerd（容器运行时）目录增长必须纳入每周检查；不能以删除未知文件解决容量。

### 11.4 8 GiB 内存和 6 Mbps 带宽边界

- 8 GiB 需要同时容纳操作系统、K3s 系统组件、Traefik（入口控制器）、认证、证书组件和最多两个更新期应用 Pod（容器组）。
- 生产运行器只执行 digest（内容摘要）验证和部署控制，禁止在生产节点运行 npm、Docker build（Docker 构建）、索引构建、测试或漏洞扫描；这些重负载任务全部留在 GitHub-hosted runner（GitHub 托管运行器）。
- 应用内存必须以加载 8,410 条向量后的实测 RSS（常驻内存）为准；OOM（内存耗尽）时不自动提高上限，先分析对象布局、并发和泄露。
- 6 Mbps 会放大首次镜像拉取、前端静态资源和更新耗时。保持 runtime image（运行时镜像）精简、利用 containerd（容器运行时）层缓存，并在发布窗口预拉取固定 digest（内容摘要）。
- 1,200 GB 流量包不是吞吐保证；公网峰值带宽仍是主要约束。
- 在 Phase 3（阶段 3）私有负载测试前，不给出每秒请求数或并发容量承诺。

### 11.5 故障行为

| 故障 | 预期行为 | 恢复 |
| --- | --- | --- |
| DeepSeek 不可用或 key（密钥）失效 | /api/check 仍可用；Ask/Generate/Fix（询问 / 生成 / 修复）快速返回安全 502/503，不重试风暴 | 检查供应商状态和安全错误码；轮换 key（密钥）或等待恢复 |
| Voyage 不可用或 key（密钥）失效 | 需要查询 embedding（向量嵌入）或 rerank（重排）的 Ask 返回安全 503；不得全量在线重建 | 恢复凭据/供应商；索引保持只读 |
| 索引身份失效 | readiness（就绪状态）失败，零模型调用 | 回滚上一镜像 digest（内容摘要）或受保护重建 |
| GHCR 不可用 | 已运行 Pod（容器组）继续；新节点/新 Pod（容器组）可能拉取失败 | 暂停发布，保留当前 Pod（容器组）和本地已验收镜像 |
| OAuth（开放授权）故障 | 新登录失败，未验证请求不能旁路到应用 | 关闭公开入口或恢复认证；不临时绕过 |
| Turnstile（人机验证）不可用或校验失败 | portfolio（作品集展示）的匿名模型能力保持或转为关闭；页面和不调用外部模型的 YAML 检查继续可用 | 检查安全错误码和服务状态；不能跳过服务端校验，必要时切回 private（私有） |
| 未来计量事实源不可用或状态不确定 | 匿名和 Interview Pass（面试临时通行证）模型调用立即关闭，不回退为内存额度；具体恢复语义由计量设计定义 | 切回 private（私有），核对供应商实际用量；没有通过对账和恢复审核前不重新开放匿名模型能力 |
| serving observation（在线观测）配置非法、目录不可写、容量满或连续失败 | Ask（询问）主流程仍按安全设计服务，原始内容不落盘；发出受限错误码并阻止或退出 portfolio（作品集展示）公开状态 | 切回 private（私有），检查权限、受管分段、轮转和磁盘；修复后用非敏感反例确认，不迁移旧原始 trace（轨迹） |
| ACCESS_MODE（访问模式）与入口路由不一致 | 应用侧仍以更严格策略拒绝匿名模型请求，发布或切换验证失败 | 按“先收紧入口”顺序恢复 private（私有），核对审计记录后重新切换 |
| TLS（传输层安全）续期失败 | 在证书过期前告警；不降级为明文 | 修复 challenge（挑战）/DNS（域名系统），必要时重新签发 |
| 节点重启 | 整体短暂不可用；K3s 和 Deployment（工作负载）自动恢复 | 验证系统 Pod（容器组）、应用探针、证书和固定 digest（内容摘要） |
| 系统盘故障 | 服务整体不可用 | 重建节点，恢复 K3s 数据/配置或按不可变清单重装，再拉取固定镜像 |

### 11.6 备份与恢复边界

- K3s 默认 SQLite（嵌入式数据库）备份包含 /var/lib/rancher/k3s/server/db/；恢复还需要与备份匹配的 server token（服务端令牌）。两者必须加密、分开存放并定期做隔离恢复演练。参考：[K3s 备份与恢复](https://docs.k3s.io/datastore/backup-restore)。
- /etc/rancher/k3s/config.yaml、审核后的部署清单和版本记录需要备份；完整 kubeconfig（Kubernetes 客户端配置）不作为共享备份 artifact（产物）。
- Secret（密钥）的事实源是外部密码管理器；K3s datastore（数据存储）备份是灾难恢复副本，不作为日常查看方式。
- 索引不单独备份：保留源语料、构建代码、身份报告和当前/上一固定镜像 digest（内容摘要）即可重建。
- serving observation（在线观测）PVC（持久卷声明）不在 K3s datastore（数据存储）备份范围内，默认不做长期备份。节点或系统盘丢失时接受未晋升 observation（观测）丢失，恢复后创建空的受管目录并重新开始短期保留；已经人工脱敏并进入 `data/eval` 的 regression（回归）用例随仓库治理，不能从备份恢复原始 trace（轨迹）。
- 未来计量事实源的备份、恢复和供应商对账由独立计量设计决定。节点恢复时默认以 private（私有）启动；不能通过清空或重建计量状态获得第二份预算。
- 每次发布前确认上一 digest（内容摘要）仍可拉取；每季度至少演练一次镜像回滚和节点重启恢复。系统盘恢复演练频率在 Phase 5（阶段 5）确定。

K3s（轻量 Kubernetes）加固必须启用 secrets-encryption（密钥静态加密）、受限 Pod Security Admission（Pod 安全准入）并核对 NetworkPolicy（网络策略）控制器。参考：[K3s 加固指南](https://docs.k3s.io/security/hardening-guide)、[Kubernetes Pod 安全标准](https://kubernetes.io/docs/concepts/security/pod-security-standards/)。

## 12. 分阶段实施

以下命令全部是未来验证命令，本轮未执行服务器命令。尖括号是待审核的真实值，不得原样运行。

### Phase 0：代码与服务器只读审计

**输入条件**

- 本文通过 review（审核）；
- 用户明确授权只读 SSH；
- 确认服务器别名和操作者来源仍受安全组允许；
- 不携带或输出密码、私钥、API key（应用程序接口密钥）或完整 kubeconfig（Kubernetes 客户端配置）。

**修改内容**

- 无。只读取仓库和服务器状态。
- 仓库侧复核本文第 2 节，补充目标 CPU 架构、当前系统服务、端口、磁盘分区、时间同步、防火墙、自动安全更新和备份能力。

**验证命令**

~~~sh
pwd
git status --short
git branch --show-current
git log -1 --oneline
git remote -v
node --version
npm --version

uname -a
lsb_release -a
lscpu
free -h
df -h
lsblk -f
ip -brief address
ip route
ss -lntup
timedatectl
systemctl --failed
sudo ufw status verbose
~~~

另核对 80、443、6443、8472、10250 未被意外公网暴露，确认 80/443 是否被其他进程占用，并记录华为云安全组截图的规则摘要，不复制 SSH 私钥。

**回滚方式**

- 无状态修改，无需回滚。
- 如果任何命令需要安装软件、修改权限或写文件，立即停止，不以“审计”为由扩大授权。

**停止点**

输出代码事实、服务器事实、差异、端口冲突和容量风险，停止等待 review（审核）。只有审核通过后进入 Phase 1（阶段 1）。

### Phase 1：安装并加固 K3s

**输入条件**

- Phase 0（阶段 0）审计通过；
- 已选择并记录固定 K3s 版本和安装脚本 checksum（校验和）；
- 已备份服务器配置，确认维护窗口；
- 6443 保持不对公网开放，22 保持固定来源；
- 确认 K3s 数据目录有足够空间。

**修改内容**

- 安装固定版本 K3s（轻量 Kubernetes），不跟随 moving channel（移动发布通道）；
- 配置 write-kubeconfig-mode=0600、secrets-encryption=true；
- 保留默认 SQLite（嵌入式数据库）、Traefik（入口控制器）、ServiceLB（服务负载均衡器）和 NetworkPolicy controller（网络策略控制器），除非 Phase 0（阶段 0）证明冲突；
- 配置受限 Pod Security Admission（Pod 安全准入）、系统日志轮转、时间同步和自动安全更新边界；
- 建立 K3s 数据库与 server token（服务端令牌）的加密备份流程；
- 不创建应用 Namespace（命名空间）或工作负载。

**验证命令**

~~~sh
sudo systemctl status k3s
sudo k3s --version
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get pods -A -o wide
sudo k3s kubectl get --raw=/readyz
sudo k3s check-config
sudo k3s secrets-encrypt status
sudo stat -c '%a %U:%G %n' /etc/rancher/k3s/k3s.yaml
sudo ss -lntup
sudo journalctl -u k3s --since "30 minutes ago"
~~~

额外从非允许公网来源验证 22/6443 不可达；该验证不能通过开放端口完成。

**回滚方式**

- 先停止发布，不创建应用资源。
- 恢复安装前配置和备份；卸载 K3s 会删除本地集群数据，只能在确认备份、目标路径和用户单独批准后执行，本文不提供自动卸载指令。
- 若 Traefik（入口控制器）或 firewall（防火墙）冲突，回到 Phase 0（阶段 0）重新设计，不以关闭所有防火墙作为长期修复。

**停止点**

提交 K3s 版本、配置 diff（差异）、端口、系统 Pod（容器组）、备份验证和加固差距，停止等待 review（审核）。

### Phase 2：容器构建和 GHCR

**输入条件**

- 已有经过用户批准的 GitHub remote（GitHub 远程仓库）和 GHCR package（GHCR 软件包）归属；
- 仓库已建为 private repository（私有仓库），并已核对 owner scope/plan（所有者范围 / 套餐）、Releases（发布版本）、immutable releases（不可变发布版本）、runner scope（运行器范围）和 artifact attestation（产物证明）能力；当前单一维护者流程明确不使用 required reviewers/prevent self-review（必需审核人 / 禁止自我审核）；
- 已创建独立 `index-build` Environment（索引构建环境），其中只保存专用 VOYAGE_API_KEY Environment secret（环境密钥）；Release lifecycle、release artifacts 和 Pull Request（发布生命周期、发布证据和合并请求）任务均不能读取；
- 唯一维护者的 GitHub 账号已启用强 MFA（多因素认证）并妥善保存恢复凭据；如果只能使用 personal repository-level runner（个人仓库级运行器），已书面接受第 7.5 节的较低隔离保证；
- 系统字体栈和 Next.js（React 全栈框架）standalone output（独立运行产物）已实现；
- raw serving trace（原始在线轨迹）已从默认请求路径隔离，既有 serving-observation-safety（在线观测安全）计划的严格 schema（模式）、脱敏、采样、轮转、保留、删除和安全失败已实现并逐项审核；
- health endpoint（健康端点）和索引 fail-closed（失败关闭）已实现；
- 所有代码改动先有反例测试并逐项 review（审核）。

**修改内容**

- 创建正式 Dockerfile 和 .dockerignore；
- 创建 Pull Request（合并请求）验证、Release lifecycle（发布生命周期）、独立 `index-build`（索引构建）、release artifacts（发布证据）、`release.published` deploy（已发布版本部署）和 draft rollback release（草稿回滚发布版本）工作流；
- 配置 draft GitHub Release（GitHub 草稿发布版本）单人确认门禁、CODEOWNERS（代码所有者）标识、分支/标签保护、production-deploy concurrency（生产部署并发）和实际仓库范围可用的最窄 runner access（运行器访问）策略；production Environment（生产环境）只记录部署，不承担批准；
- 配置 GHCR（GitHub 容器镜像仓库）最小权限；
- 手工 `index-build`（索引构建）受保护构建当前 8,410 条语料的独立索引产物，生成身份报告、不可变 digest（内容摘要）和签名；相同身份存在有效产物时不重复调用 Voyage；
- Release Please（发布自动化工具）合并 Release Pull Request（发布合并请求）后创建 Draft Release（草稿发布版本）和发布说明，再由无人工参数的 release artifacts workflow（发布证据流水线）验证索引产物，构建、扫描、证明并推送固定 commit SHA（提交哈希）的候选应用镜像和 release manifest（发布清单）；本阶段不注册生产运行器、不部署应用。
- 使用受控临时目录完成 serving observation（在线观测）反例测试，锁定候选生产配置、只处理受管分段和单写入端约束；不在构建机保留测试 trace（轨迹）。

**验证命令**

~~~sh
npm ci
npm test
npx tsc --noEmit -p tsconfig.json
npm run schemas:check
npm run corpus:stats
npm run eval:check
npm run build
npm run container:build:runtime-base
npm run container:smoke:runtime-base
docker buildx imagetools inspect <ghcr-index-image>@sha256:<index-digest>
docker buildx build --target runtime --build-context verified-index=docker-image://<ghcr-index-image>@sha256:<index-digest> --load --tag <local-image>:<full-commit-sha> .
docker image inspect <local-image>:<full-commit-sha>
docker run --rm --read-only --user 10001:10001 <local-image>:<full-commit-sha>
docker buildx imagetools inspect <ghcr-image>@sha256:<digest>
~~~

容器运行验证需由测试 harness（测试框架）启动并请求 live/ready（存活 / 就绪）端点，不能让最后一条示意命令无限运行。验证镜像中没有 .env、Git、测试工具、原始 trace（轨迹）或构建凭据，并核对索引身份；安全 observation（观测）只能在显式挂载的受控目录写入。

**回滚方式**

- 不删除已发布的不可变 digest（内容摘要）；撤销错误标签或将其标记为不准发布。
- 吊销受影响索引构建凭据，修复后生成新 index identity/digest（索引身份 / 内容摘要），不得覆盖原 digest（内容摘要）。
- workflow（流水线）权限异常时先禁用发布触发，不影响服务器现有版本。
- release artifacts workflow（发布证据流水线）出现 `workflow_dispatch`（手工触发）、创建/编辑 Draft Release（草稿发布版本）、创建标签、自动 Publish（发布）或触发生产运行器的能力时停止；无参数 Release lifecycle（发布生命周期）恢复入口与独立索引构建入口都不能替代草稿发布页面上的再次确认。
- 实际 runner scope（运行器范围）比第 7.5 节更宽、默认分支工作流无法保护或固定部署适配器边界不能成立时停止，不用 runner label（运行器标签）冒充访问控制。

**停止点**

输出 GitHub owner scope/plan（所有者范围 / 套餐）、Release（发布版本）与运行器能力、工作流触发器/权限、草稿发布门禁、镜像大小、漏洞、软件物料清单、commit/digest（提交哈希 / 内容摘要）、索引身份、serving observation（在线观测）反例和凭据审计，停止等待 review（审核）。

### Phase 3：私有方式部署和验证

**输入条件**

- Phase 1（阶段 1）K3s 与 Phase 2（阶段 2）镜像均审核通过；
- 运行时 Secret（密钥）已从密码管理器准备，GHCR 只读拉取凭据已就绪；
- candidate/deploy/rollback workflow（候选 / 部署 / 回滚流水线）、draft Release manual confirmation（草稿发布版本人工确认）和实际 runner scope（运行器范围）已经审核；
- 生产部署 runner（运行器）账号、root-owned deployment adapter（root 所有部署适配器）、sudoers（提权规则）、出站网络和撤销流程已有逐项实现计划；
- 80/443 仍不公开；
- 已有上一版本回滚记录；首次部署则有删除应用 Namespace（命名空间）但保留 K3s 的回退方案；
- 本阶段真实模型 smoke test（冒烟测试）的调用次数和费用获得单独批准。

**修改内容**

- 通过固定来源 SSH 完成一次 bootstrap（引导配置）：创建 Namespace（命名空间）、Pod 安全标签、运行时 Secret（密钥）、imagePullSecret（镜像拉取密钥）、固定非敏感资源、生产部署 runner（运行器）账号/服务和 root-owned deployment adapter（root 所有部署适配器）；不手工发布应用版本；
- 如果 GitHub organization（GitHub 组织）能力允许，把生产运行器放入只允许当前仓库和 production deploy workflow（生产部署流水线）的 runner group（运行器组）；否则按已接受的个人仓库级边界注册。两种情况都必须核对没有新增公网监听端口；
- 合并已通过全部门禁的 Release Pull Request（发布合并请求），由 Release Please（发布自动化工具）创建 Draft Release（草稿发布版本）并自动调用 release artifacts workflow（发布证据流水线）；确认发布证据生成结束后只留下草稿、生产运行器没有收到任务且 K3s 无变化。回滚时则由 rollback candidate workflow（回滚候选流水线）创建规范回滚草稿。人工核对对应证据后，先在单独授权下运行 `scripts/k3s-image-preheat.sh`，把应用清单或规范回滚标签中的精确镜像根摘要导入 K3s（轻量 Kubernetes）；预热不修改 Deployment（工作负载）。预热成功并再次确认 Publish release（发布版本）后，才由 `release.published`（发布版本已发布）流水线直接创建或更新固定 Deployment（工作负载）；
- 镜像使用 digest（内容摘要），replicas=1，配置安全上下文、资源、startup/readiness/liveness probes（启动 / 就绪 / 存活探针）；
- 创建安全 serving observation（在线观测）专用 local-path PVC（本地路径持久卷），只挂载固定 `data/observability/` 目录，应用只在其 `0700` `segments/` 子目录写入；显式注入已审核的 local candidate profile（本地候选配置），保持 `maxSurge=0`、`maxUnavailable=1` 的单写入端更新边界；
- 显式设置 ACCESS_MODE=private（访问模式为私有），验证缺失或非法值也不会开放匿名路由；本阶段不创建公开模式切换能力；
- 仅通过 SSH tunnel（SSH 隧道）和 port-forward（端口转发）验证；
- 安全 serving observation（在线观测）从本阶段开始持续启用；旧 `serving-traces.jsonl` 不读取、不迁移，清理由操作者在列出确切目标并单独确认后执行。

**验证命令**

~~~sh
sudo k3s kubectl apply --server-side --dry-run=server -f <reviewed-bootstrap-manifest-dir>
sudo k3s kubectl apply -f <reviewed-bootstrap-manifest-dir>
sudo k3s kubectl -n <namespace> rollout status deployment/<app> --timeout=10m
sudo k3s kubectl -n <namespace> get deploy,rs,pod,svc
sudo k3s kubectl -n <namespace> describe pod <pod>
sudo k3s kubectl -n <namespace> logs deployment/<app> --since=10m
sudo k3s kubectl -n <namespace> get pod <pod> -o jsonpath='{.spec.containers[0].image}'
sudo systemctl status <runner-service>
sudo ss -lntup
gh run view <run-id>
~~~

<reviewed-bootstrap-manifest-dir> 只包含 Actions（自动化流水线）运行所需的集群边界和固定非版本资源，不包含已运行的应用版本。root-owned deployment adapter（root 所有部署适配器）持有审核后的固定 Deployment（工作负载）模板，第一条获批 release（发布版本）才创建 replicas=1 的应用工作负载；后续只替换镜像 digest（内容摘要）。

必须验证：

- 草稿保持未发布或被删除时，运行器不收到 deploy job（部署任务），K3s 版本保持不变；
- 手工发布后只部署 release manifest（发布清单）中的精确 digest（内容摘要），GitHub deployment（GitHub 部署记录）包含发布确认账号、Release ID（发布版本标识）与结果；
- Pull Request（合并请求）、任意分支和其他 workflow（工作流）不能调度生产运行器；
- 浏览器、公共 API（应用程序接口）、应用 ServiceAccount（服务账户）和非管理员 GitHub 身份不能修改 ACCESS_MODE（访问模式）；
- deploy job（部署任务）没有 checkout（检出）源码、第三方 Action（流水线动作）、模型 Secret（模型密钥）、SSH 私钥、Docker socket（Docker 套接字）或完整 kubeconfig（Kubernetes 客户端配置）；
- 运行器只有出站 443，22 仍只允许固定来源，6443 仍不对公网开放；
- 无有效索引的故障镜像不能 ready（就绪），且没有 Voyage 全量构建调用；
- read-only root filesystem（只读根文件系统）下没有写入错误；
- 缺少/失效 key（密钥）时返回安全 5xx，/api/check 仍工作；
- 日志不含 YAML、prompt（提示词）、answer（回答）、Secret（密钥）或供应商错误体；
- `sampleRate=1` 时受控非敏感 Ask（询问）产生严格 observation（观测），Secret（密钥）、不可安全解析输入和超限文本不保存原文；文件按 UTC（协调世界时）/大小轮转，7 天和 256 MiB 候选边界、人工删除、symlink（符号链接）拒绝和旧文件不迁移均通过；
- recorder（记录器）配置、脱敏、写入或清理失败不影响 Ask（询问）结果、不产生原始回退，并发 rollout（滚动发布）期间始终最多一个应用 Pod（容器组）写入；
- 候选资源上限和单 Pod（容器组）更新期间的短暂不可用；
- 长连接终止、超时和进程重启行为。

**回滚方式**

- rollout（滚动发布）未就绪时由同一个已确认任务自动恢复上一 digest（内容摘要）；功能审核失败时生成 draft rollback release（草稿回滚发布版本），由唯一维护者核对并手工发布后回滚。
- runner/workflow（运行器 / 流水线）边界异常时先在 GitHub 禁用运行器并停止本地服务；必要时通过固定来源 SSH 执行 break-glass rollback（紧急回滚），不得开放公网管理端口。
- 首次部署失败时删除应用 Namespace（命名空间）属于有状态破坏操作，必须先列出其中所有资源并经用户确认；优先缩容应用并保留诊断状态。
- 不回滚或卸载 K3s，除非 Phase 1（阶段 1）本身失败并有单独批准。

**停止点**

输出草稿保留/发布/删除证据、实际 workflow/runner scope（工作流 / 运行器范围）边界、部署记录、私有功能、安全反例、资源峰值、日志审计、serving observation（在线观测）的落盘/轮转/删除/失败结果、模型调用次数/费用和 Action rollback（流水线回滚）演练，停止等待 review（审核）。

### Phase 4：公网 IP TLS、固定语义路径、认证与限流

> 状态：本节及 Phase 5（阶段 5）中 oauth2-proxy（认证代理）、private/portfolio（私有 / 作品集展示）和允许名单方案从未部署，已由 `2026-07-29-public-experience-control-design.md` 替代。以下内容只保留历史审核背景，不再指导实现或生产安装；公网 IP、固定路径、证书和 Phase 0-3（阶段 0-3）信任链中未被替代的部分继续有效。

**输入条件**

- 公网 IPv4 `120.46.57.214`、基础路径 `/k8s-yaml-assistant` 和公网 IP 短期证书方案通过审核；域名和 DNS（域名系统）不是当前前置条件；
- GitHub OAuth App（GitHub OAuth 应用）允许名单和回调地址已审核；如准备进入匿名模型扩展，Cloudflare Turnstile（Cloudflare 人机验证服务）生产域名和凭据职责随独立计量设计一起确认；
- ACCESS_MODE（访问模式）、请求体限制、认证、allowlist（允许名单）、入口与应用限流、并发和 private（私有）模式费用边界已先写反例测试并实现；
- 如果本阶段准备开放匿名模型体验或 Interview Pass（面试临时通行证），先编写独立 token/usage/cost metering（令牌 / 用量 / 成本计量）设计并停止等待 review（审核）；该设计未批准前不得实现额度存储或开放匿名付费路由；
- 匿名页面已明确当前只开放本地 YAML 检查；供应商数据处理、模型调用隐私告知和 Turnstile Privacy Addendum（Turnstile 隐私附录）引用必须在未来匿名模型体验启用前审核；
- 安全 serving observation（在线观测）已在 private（私有）模式持续启用并通过轮转、保留、删除、磁盘和故障验证；
- 已准备管理员切回 private（私有）、把模型额度降为 0、关闭 443 和回滚 Ingress（入口）的操作。

**修改内容**

- 不创建 DNS（域名系统）记录；Next.js（前端框架）、前端请求、探针、oauth2-proxy（认证代理）和 IngressRoute（入口路由）统一固定 `/k8s-yaml-assistant`；
- 安装固定版本 cert-manager（证书管理器），先使用 ACME staging issuer（ACME 预发布签发器）的 `shortlived`（短期证书）profile（配置档）为 `120.46.57.214` 签发 IP 证书，并由唯一 `default` TLSStore（默认传输层安全证书仓库）提供给无 SNI（服务器名称指示）客户端；
- 部署 Task 15（任务 15）已审核并固定 digest（内容摘要）的 oauth2-proxy reverse proxy（认证代理反向代理）和 private（私有）NetworkPolicy（网络策略），再创建 body/rate/concurrency middleware（请求体 / 速率 / 并发中间件）和两个固定访问模式的 IngressRoute（Traefik 入口路由）配置；
- portfolio（作品集展示）的基础路由只开放页面、静态资源和不调用外部模型的 YAML 检查；Ask/Generate/Fix（询问 / 生成 / 修复）继续要求 allowlist（允许名单）身份。Turnstile（人机验证）、匿名会话、Interview Pass（面试临时通行证）和任何计量状态只在独立计量设计批准后实施；
- 扩展固定部署适配器，只接受 set-access-mode private|portfolio（设置访问模式）枚举动作；实现“开启最后开放入口、关闭首先收紧入口”的有序切换和部分失败回退；
- 对公网开放只承载 ACME HTTP-01（ACME HTTP 验证）的 80；443 仍只允许当前固定来源或另行审核的测试来源；
- staging（预发布）验证通过后切换 production issuer（生产签发器）。

cert-manager（证书管理器）必须使用实施当日仍受支持的固定版本；安装和升级参考：[cert-manager 安装文档](https://cert-manager.io/docs/installation/)、[cert-manager 支持版本](https://cert-manager.io/docs/releases/)。

**验证命令**

~~~sh
sudo k3s kubectl -n <namespace> get ingress,certificate,certificaterequest,order,challenge
sudo k3s kubectl -n <namespace> describe certificate <certificate>
curl --fail --head https://120.46.57.214/k8s-yaml-assistant
openssl s_client -connect 120.46.57.214:443 -verify_ip 120.46.57.214
~~~

必须在受限来源中分别执行 private/portfolio（私有 / 作品集展示）基础安全反例，完成后切回 private（私有）：

- 缺失、空白、大小写错误和未知 ACCESS_MODE（访问模式）均按 private（私有）处理；
- private（私有）中未登录访问被重定向或拒绝，非 allowlist（允许名单）用户、直接命中 Service（服务）和伪造身份头都不能旁路认证；
- portfolio（作品集展示）中只有页面、静态资源和不调用外部模型的 YAML 检查公开，管理操作、健康端点和模式修改没有公网路径；未完成计量设计时，匿名 Ask/Generate/Fix（询问 / 生成 / 修复）均被拒绝；
- 不能通过伪造 cookie（浏览器会话）、身份头、URL（网址）参数、特殊请求头或 Interview Pass（面试临时通行证）占位值绕过 allowlist（允许名单）；
- 公共请求、应用 ServiceAccount（服务账户）和非管理员工作流不能切换模式；开启 portfolio（作品集展示）缺少任何门禁时失败，关闭 private（私有）不依赖模型供应商；
- private → portfolio（私有 → 作品集展示）在最后一步前保持匿名拒绝；portfolio → private（作品集展示 → 私有）在第一步后立即恢复认证；中途故障收敛到 private（私有）；
- 超大、无 Content-Length（内容长度）和 chunked（分块）请求被 413；
- 超速返回 429，超并发被快速拒绝；
- 供应商超时、余额不足和 key（密钥）失效不泄露原始错误；
- HTTP（超文本传输协议）只处理 ACME challenge（证书挑战）和 HTTPS 跳转。

**回滚方式**

1. 先由管理员把 ACCESS_MODE（访问模式）切回 private（私有）并验证匿名请求被拒绝；切换链路异常时直接关闭公网 443，必要时同时关闭 80。
2. 关闭全部匿名模型路由；如未来计量设计已经实施，再按其审核流程撤销 Interview Pass（面试临时通行证）并冻结计量状态。
3. 回滚 Ingress/middleware（入口 / 中间件）、oauth2-proxy（认证代理）和证书配置到上一审核版本。
4. 轮换异常 OAuth/cookie/Turnstile/TLS secret（OAuth / 浏览器会话 / 人机验证 / TLS 密钥）。
5. 通过 SSH tunnel（SSH 隧道）重新验证，不为恢复便利开放 6443。

**停止点**

输出公网 IP 证书链与自动续期、固定语义路径、private/portfolio（私有 / 作品集展示）基础模式矩阵、管理员权限、限流、请求体、费用熔断、serving observation（在线观测）和异常流量测试，确认匿名模型路由关闭且最终状态为 private（私有），停止等待 review（审核）。如果下一步需要匿名模型体验，在此停止点提交独立计量设计；不能在同一次 review（审核）中边设计边上线。此时只有证书挑战端口对公网可达，应用 443 仍限制审核来源，不宣布正式发布。

### Phase 5：公开发布和运维验收

**输入条件**

- Phase 4（阶段 4）全部门禁通过；
- 当前 ACCESS_MODE=private（访问模式为私有），默认和紧急回退均已验证；
- portfolio（作品集展示）的页面和不调用外部模型的 YAML 检查已通过匿名访问反例；如果要同时开放匿名模型或 Interview Pass（面试临时通行证），独立计量设计、实现、对账和费用硬边界必须另行全部通过，否则相关路由保持关闭；
- 生产证书有效且续期路径验证；
- 日志、磁盘、资源、供应商费用和证书告警已配置；
- 安全 serving observation（在线观测）在 private（私有）试运行中持续健康，轮转、保留、删除和故障告警已验证；
- 当前和上一 image digest（镜像内容摘要）可拉取，回滚演练通过；
- candidate/deploy/rollback workflow（候选 / 部署 / 回滚流水线）、草稿发布版本人工确认和生产运行器状态正常，最近一次演练没有出现越权任务；
- K3s 数据和 server token（服务端令牌）备份恢复演练通过；
- 新 8,410 条语料的正式 retrieval/faith/judge/generation/fix（检索 / 忠实度 / 裁判 / 生成 / 修复）评估和人工正确性审核已通过，或用户对未完成质量基线做出书面风险接受。

**修改内容**

- 保持 ACCESS_MODE=private（访问模式为私有），先将 443 安全组从审核来源扩大为公网入口，验证只有允许名单身份可以访问；80 增加固定 HTTPS（安全超文本传输协议）跳转并继续服务证书挑战；
- 管理员核对独立 draft operational release（草稿运维发布版本）后手工启用 portfolio（作品集展示）：页面、静态资源和不调用外部模型的 YAML 检查匿名公开；付费模型路由默认只接受 allowlist（允许名单）身份，只有独立计量门禁已经完成时才增加有效匿名会话和 Interview Pass（面试临时通行证）；
- 发布运维手册、值班联系人、事故关闭入口步骤和版本台账；
- 记录 release（发布）时间、commit/digest（提交哈希 / 内容摘要）、索引身份、前后访问模式、管理员确认、资源基线和已知限制；
- 保持安全 serving observation（在线观测）持续启用，不切换回旧 raw trace（原始轨迹）或 mode=off。

**验证命令**

~~~sh
curl --fail --head https://120.46.57.214/k8s-yaml-assistant
sudo k3s kubectl -n <namespace> rollout status deployment/<app>
sudo k3s kubectl -n <namespace> get pods
sudo k3s kubectl top nodes
sudo k3s kubectl top pods -A
df -h
sudo journalctl -u k3s --since "1 hour ago"
~~~

从外部网络验证 TLS（传输层安全）和以下两种状态：private（私有）中匿名访问被拒绝；portfolio（作品集展示）中页面和不调用外部模型的 YAML 检查无需登录，匿名模型调用在计量门禁未完成时仍被拒绝。使用 allowlist（允许名单）身份和受控非敏感 YAML 测试编辑器 Ask/Check/Generate/Fix（询问 / 检查 / 生成 / 修复）闭环，并验证对应安全 observation（观测）不含原始 YAML 或回答。只有独立计量设计已经实施时，才追加 Turnstile（人机验证）、有限匿名额度和 Interview Pass（面试临时通行证）的条件验收。执行一次 portfolio → private → portfolio（作品集展示 → 私有 → 作品集展示）演练，记录模式审计和安全聚合指标，不记录请求内容或凭据。

**回滚方式**

- 安全或费用异常：管理员首先切回 private（私有）并把模型额度降为 0；该动作失败或入口已失控时立即关闭 443 或停用 Ingress（入口），保留 SSH 固定来源。
- 应用回归：生成 draft rollback release（草稿回滚发布版本），核对后手工发布，回到上一 image digest（镜像内容摘要）并验证索引身份；Actions（自动化流水线）不可用时才使用 break-glass（紧急处置）。
- 认证、Turnstile（人机验证）、未来计量模块、serving observation（在线观测）或证书故障：切回 private（私有）或关闭公开入口，在隧道内修复，不旁路校验、不回退内存额度、不恢复原始 trace（轨迹）或降级明文。
- 节点故障：按备份和不可变清单恢复；没有完成恢复演练前不承诺恢复时间。

**停止点**

提交公开验收、模式切换审计、24 小时和 7 天观察结果、serving observation（在线观测）的健康/丢弃/轮转/容量汇总、可获得的供应商费用、资源、磁盘、证书、异常流量与回滚记录，停止等待 review（审核）。匿名/面试角色费用只在计量模块已实施时报告。只有用户明确确认后才把发布状态从“受控试运行”改为“生产可用”；管理员可随时切回 private（私有），该安全收紧不需要等待新的公开发布审核。

## 13. 当前部署阻断项

按优先级排序：

1. serving observation（在线观测）的严格 schema（模式）、脱敏、稳定采样、轮转、保留、删除和磁盘上限已实现；生产 PVC（持久卷声明）和 Pod（容器组）已经接线，单副本当前只有一个写入端。目录写入、轮转、删除、磁盘上限、符号链接拒绝和告警仍须在私有验收中用非敏感输入证明。
2. 工作区 data/index 仍只有 8,127 条且属于旧索引格式，当前加载会明确失效；它不再是生产交付来源。8,410 条正式索引已经作为独立、校验并签名的 GHCR artifact（GHCR 产物）交付，当前只剩候选应用镜像按 digest（内容摘要）引入并回读验证该产物。
3. /api/health/live 和 /api/health/ready 健康端点已经实现并接入 Kubernetes startup/readiness/liveness probe（启动 / 就绪 / 存活探针）；首次私有部署中 Pod（容器组）就绪且节点通过 ClusterIP（集群内服务地址）实际得到 `live/ready`（存活 / 就绪）响应。供应商故障和索引失效的生产反例仍待私有验收。
4. 没有 ACCESS_MODE（访问模式）服务端授权、管理员专用切换路径、认证、请求体大小、限流、并发和费用熔断；不能公开。
5. 没有独立 token/usage/cost metering（令牌 / 用量 / 成本计量）设计，也没有 Turnstile（人机验证）服务端校验、匿名安全会话或 Interview Pass（面试临时通行证）实现；portfolio（作品集展示）可以公开页面和本地 YAML 检查，但匿名付费模型能力不能启用。存储介质尚未选择，不能把 SQLite/PVC（嵌入式数据库 / 持久卷声明）当作既定答案。
6. DeepSeek/Voyage（深度求索 / 向量服务）端点和模型身份已按官方契约显式固定，安全错误映射与流式失败协议已实现；ConfigMap/Secret（普通配置 / 密钥）已经接线，供应商故障的生产冒烟测试仍待完成。
7. Dockerfile、`.dockerignore`、私有 GitHub remote（GitHub 远程仓库）、Pull Request Actions（合并请求流水线）、默认分支规则、Action SHA pinning（流水线动作提交哈希固定）、immutable releases（不可变发布版本）、`index-build` Environment（索引构建环境）、8,410 条正式索引、`v0.1.0` 不可变发布和六项证据已经建立。无生产消费者的 `CURRENT_PRODUCTION_DIGEST` 仓库变量已经删除；当前生产内容摘要由固定适配器成功台账提供。GitHub Pro private repository（GitHub 专业版私有仓库）不能使用 GitHub artifact attestation（GitHub 产物证明），已审核改用 Cosign（签名与证明工具）无密钥证明并接受公开透明日志元数据。
8. K3s（轻量 Kubernetes）、固定适配器和仓库级生产 runner（运行器）已经安装并审核；首次私有部署成功。个人仓库级运行器不能像 organization runner group（组织运行器组）一样限制到单一工作流，因此固定适配器仍是生产权限边界。
9. 当前入口候选已固定为公网 IPv4 `120.46.57.214`、`/k8s-yaml-assistant` 和 Let’s Encrypt（免费证书颁发机构）公网 IP 短期证书；域名不再阻断。OAuth（开放授权）允许名单、实际 IP 证书自动续期和唯一 `default` TLSStore（默认传输层安全证书仓库）仍待实现与验证；Turnstile（人机验证）生产配置、可承受日预算及计量契约只在准备开放匿名模型能力时进入设计。
10. 当前尚未基于 8,410 条语料完成正式全量质量评估和错误解释人工正确性审核；在公开发布前必须完成或显式接受风险。

上述 1-7 包含后续代码或交付资源变更，其中远程仓库和云端资源仍需当次明确授权；第 8-9 项涉及服务器或外部系统，第 10 项属于暂停中的质量主线，不能被部署冒烟测试替代。

## 14. 验收总门禁

### 私有部署门禁

- [x] K3s 版本、checksum（校验和）、配置和备份通过审核。
- [ ] 镜像固定 commit SHA（提交哈希）和 digest（内容摘要），非 root、只读根文件系统。
- [x] 字体构建不依赖外网。
- [ ] 8,410 条索引身份完整且运行时禁止重建。
- [ ] live/ready（存活 / 就绪）探针不调用供应商。
- [ ] raw serving trace（原始在线轨迹）已隔离；严格安全 observation（观测）以显式配置持续启用，原始/敏感输入被丢弃，轮转、保留、删除、容量、单写入端和失败无原文回退均通过。
- [ ] Secret（密钥）没有进入仓库、日志、镜像层或命令历史。
- [ ] Release Please（发布自动化工具）单独拥有 Draft Release（草稿发布版本）、版本、标签名和发布说明；活动应用草稿会暂停下一版本准备，Release Pull Request merge（发布合并请求合并）只创建当前草稿；release artifacts workflow（发布证据流水线）只验证发布身份和索引、构建应用并附加六项证据。草稿未发布或删除时不会创建 Git tag（Git 标签）或调度生产运行器，只有手工 Publish release（发布版本）才触发部署。
- [ ] 生产运行器只接受固定部署工作流，不能接收 Pull Request（合并请求）或其他工作流；没有公网管理端口、完整 kubeconfig（Kubernetes 客户端配置）或模型密钥。
- [ ] Action direct deploy/rollback（流水线直接部署 / 回滚）只使用已审核 digest（内容摘要），失败时恢复上一版本并留下部署记录。
- [ ] 私有隧道内功能、安全失败、资源和回滚通过。

### 公开发布门禁

- [ ] 公网 IP 生产 TLS（传输层安全）、约 6 天短期证书自动续期、无 SNI（服务器名称指示）证书选择和固定语义路径通过；域名为未来可选变更。
- [ ] GitHub OAuth 2.0（GitHub 开放授权 2.0）与 allowlist（允许名单）通过反例测试。
- [ ] ACCESS_MODE（访问模式）缺失或非法时默认 private（私有）；只有管理员固定动作和固定来源紧急路径可以修改，公共 API（应用程序接口）和应用 ServiceAccount（服务账户）不能修改。
- [ ] private（私有）模式保护全部业务路由；portfolio（作品集展示）至少只公开页面和不调用外部模型的 YAML 检查，匿名模型门禁未完成时明确拒绝付费路由；两个方向的有序切换和中途失败回退通过。
- [ ] 如启用匿名模型体验，独立计量设计及反例已经审核；Turnstile（人机验证）必须服务端校验，伪造、过期、重放或校验服务故障不能创建匿名模型会话。
- [ ] 如启用匿名模型体验，累计额度和全局费用事实源跨 Pod（容器组）重启有效、并发安全且不可用时关闭；具体存储由计量设计选择，不保存用户 YAML、回答、明文 IP（互联网协议地址）或会话凭据。
- [ ] 如启用 Interview Pass（面试临时通行证），它只由管理员签发，明文只显示一次、一次兑换、有限高额度、自动过期、可撤销且受全局费用熔断；具体上限由计量设计审核，不在本文预设。
- [ ] 页面明确区分不调用外部模型的 YAML 检查和外部模型调用，匿名隐私告知、供应商数据处理边界和 Turnstile Privacy Addendum（Turnstile 隐私附录）引用通过审核。
- [ ] 请求体、速率、并发、最大 token（令牌）、超时、有限重试和费用硬边界通过。
- [ ] 22 仍仅固定来源，6443 不公开，80 仅挑战/跳转，443 是唯一应用入口。
- [ ] 日志无请求内容；生产安全 serving observation（在线观测）持续启用，候选 `sampleRate=1`、7 天和 256 MiB 边界经实测确认，且不含原始 YAML、回答或 Secret（密钥）。
- [ ] 磁盘、内存、证书、上游失败和费用告警可用。
- [ ] 镜像回滚、节点重启、K3s 数据恢复和 Secret（密钥）恢复边界演练通过。
- [ ] 新质量 baseline（基线）完成人工审核，或存在明确风险接受记录。
- [ ] 每个 Phase（阶段）的 review（审核）记录完整。

## 15. 关键取舍与遗留风险

### 15.1 关键取舍

- 选“独立、已签名、可复用的 GHCR 索引产物作为构建中间件 + 最终应用镜像内置索引”，不选 PVC + Job（持久卷 + 独立任务）：避免每次功能发布重复调用 Voyage，同时保留约 37 MiB 镜像增量带来的原子发布、运行时无远程依赖和简单回滚。
- 选“GitHub Actions（GitHub 自动化流水线）直接发布 + draft Release（草稿发布版本）单人确认 + 生产专用部署运行器”，不选每次 SSH 人工部署：保留 22 固定来源和 6443 非公网边界，同时接受没有独立复核以及生产运行器代码执行风险。SWR（华为云容器镜像服务）企业版可用前的本机 SSH（安全远程登录）步骤只导入应用清单或规范回滚标签中的精确镜像摘要，不修改 Deployment（工作负载）或替代发布流水线。
- 选管理员控制的 private/portfolio（私有 / 作品集展示）双模式，不选“永久仅允许名单”或“匿名无限调用”：默认 private（私有）；作品集展示先开放页面和本地 YAML 检查，匿名模型体验只有在独立计量门禁完成后才追加。
- 选 GitHub OAuth 2.0（GitHub 开放授权 2.0）允许名单保护 private（私有）和管理员访问；匿名体验使用 Turnstile（人机验证）与受控会话，不为简历访客自建注册、密码和用户资料系统。
- 选 oauth2-proxy reverse proxy（认证代理反向代理）承载受保护业务流量，不选 ForwardAuth（前置认证）：当前生产 Traefik `3.7.4` 的 `trustForwardHeader` 已弃用且入口未配置可信代理地址，而认证代理固定版本能在同一进程中清理并重新注入应用认可的身份头；代价是认证代理进入业务数据路径，必须单独限制资源、探针和网络。
- 选单节点 K3s 默认 SQLite（嵌入式数据库）承担集群状态，但不为应用计量预选数据库：token/usage/cost（令牌 / 用量 / 成本）事实源和存储等实施到该阶段再设计，索引仍不使用 PVC（持久卷声明）或向量数据库。
- 保留显式 Interview Pass（面试临时通行证）需求，不选隐藏后门或无限 token（令牌）角色；签发、持久化、具体时长和额度与计量模块一起设计，当前不落占位实现。
- 选“先隔离原始 trace（轨迹），再持续启用严格安全 observation（观测）”：低流量单节点阶段使用有界 local sink + PVC（本地写入端 + 持久卷声明），以单写入端和短暂更新不可用换取简单、可审核的本地闭环。
- 选固定版本和 digest（内容摘要），不选 latest 或移动通道：发布、审计和回滚身份可证明。

### 15.2 遗留风险

- 单节点仍存在节点、磁盘、区域和公网单点故障，任何探针或滚动策略都不能消除。
- 生产 self-hosted runner（自托管运行器）本质上允许获准工作流在生产节点执行代码；Environment approval（环境审核）不是沙箱，工作流保护、运行器组、低权限账号和固定部署适配器任一失守都可能扩大影响。
- 当前已使用个人 GitHub Pro private repository（GitHub 专业版私有仓库）。个人仓库级运行器仍不能像 organization runner group（组织运行器组）那样限制到单一工作流，GitHub artifact attestation（GitHub 产物证明）也不适用于该私有仓库；已选择 Cosign（签名工具）并接受公开透明日志元数据，但生产运行器的较宽仓库信任边界仍须按第 7.5 节单独审核。
- 当前人工门禁由同一个 GitHub 账号触发候选构建并发布草稿版本，不是独立审核；账号、默认分支写权限或运行器凭据失陷时，攻击者可能完成发布和部署。强 MFA（多因素认证）、工作流变更单独检查和固定部署适配器只能降低风险，不能形成职责分离。
- K3s 默认 ServiceLB（服务负载均衡器）与公网 IP 的真实行为需在服务器核对，云平台网络可能有额外约束。
- 公网 IP 证书只有约 6 天有效，自动续期或 80/TCP HTTP-01（HTTP 验证）持续可达性失效会在短时间内使入口证书过期；Phase 4（阶段 4）必须证明续期并配置到期告警。
- IP 客户端可能不发送 SNI（服务器名称指示），当前入口需要占用 Traefik（入口控制器）集群唯一 `default` TLSStore（默认传输层安全证书仓库）；未来同集群增加其他入口前必须重新设计，不能创建第二个同名仓库。
- oauth2-proxy（OAuth 2.0 认证代理）反向代理、Traefik（入口控制器）匿名路由中间件的具体版本、身份头清理和顺序必须分别用反例测试锁定；Task 15（任务 15）只证明 private（私有）链路，portfolio（作品集展示）直达应用前仍须证明 Traefik（入口控制器）删除身份头。
- Turnstile（人机验证）、来源 IP（互联网协议地址）和匿名 cookie（浏览器会话）都不能证明真实身份；匿名模型能力仍缺少经过审核的计量事实源和全局费用硬上限，因此当前必须保持关闭。
- Turnstile（人机验证）脚本和 Siteverify API（令牌校验接口）在预期面试官网络、尤其中国大陆网络中的可达性和延迟尚未实测；不可达时匿名模型能力会安全关闭。Phase 4（阶段 4）必须从目标网络验证，失败后单独评审等价托管方案，不能直接绕过人机验证。
- serving observation PVC（在线观测持久卷声明）与节点处于同一故障域，磁盘损坏会丢失尚未晋升的 observation（观测）；不做长期原始备份，恢复后只重新开始安全短期观测。未来计量状态的故障域和恢复风险要在独立设计中重新评估。
- ACCESS_MODE（访问模式）同时影响应用授权和 Ingress（入口）路由，部分切换可能短暂不一致；应用端拒绝是最终边界，固定切换顺序和故障注入必须证明收敛到 private（私有）。
- Interview Pass（面试临时通行证）在到期前仍是可转交凭据；一次兑换、单会话、短有效期、撤销和全局费用熔断只能降低影响，不能证明面试官身份。
- 模型供应商 API（应用程序接口）的可用性、限额、计费硬上限和错误契约尚未实测。
- JavaScript（JavaScript 语言）加载向量后的真实内存、冷启动和 6 Mbps 镜像拉取时间未知。
- 系统字体的具体字形会随客户端操作系统和浏览器变化；当前明确接受该视觉一致性取舍。
- 现有 answer model（回答模型）和 DeepSeek compatible endpoint（DeepSeek 兼容端点）的运行行为需要私有环境验证。
- 即使完成结构化脱敏，也不能证明识别所有业务秘密；生产持久化仍需独立隐私与存储审核。
- 当前正式 baseline（基线）尚未重建，错误解释 correctness（正确性）仍需人工 trace review（轨迹审核）。

## 16. 参考依据

- [Next.js standalone output（独立运行产物）](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Next.js basePath（基础路径）](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)
- [Next.js 部署](https://nextjs.org/docs/app/getting-started/deploying)
- [Next.js 字体](https://nextjs.org/docs/app/api-reference/components/font)
- [Node.js 发布计划](https://nodejs.org/en/about/previous-releases)
- [K3s 安装要求](https://docs.k3s.io/installation/requirements)
- [K3s 网络服务](https://docs.k3s.io/networking/networking-services)
- [K3s 加固指南](https://docs.k3s.io/security/hardening-guide)
- [K3s 备份与恢复](https://docs.k3s.io/datastore/backup-restore)
- [Kubernetes Deployment（Kubernetes 工作负载）](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes probes（Kubernetes 探针）](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Kubernetes resources（Kubernetes 资源）](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes Secret（Kubernetes 密钥）良好实践](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- [Kubernetes 私有镜像拉取](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
- [GitHub Actions 容器发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub Actions 安全加固](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Deployments and environments（GitHub 部署与环境）](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub Reviewing deployments（GitHub 部署审核）](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
- [GitHub release event（GitHub 发布版本事件）](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [GitHub managing releases（GitHub 管理发布版本）](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [GitHub self-hosted runner group（GitHub 自托管运行器组）访问控制](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
- [GitHub deployment concurrency（GitHub 部署并发）](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [GitHub artifact attestation（GitHub 产物证明）可用性](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub artifact attestation（GitHub 产物证明）离线验证](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- [Sigstore GitHub Actions 无密钥签名](https://docs.sigstore.dev/quickstart/quickstart-ci/)
- [Sigstore Cosign（Sigstore 镜像签名工具）验证](https://docs.sigstore.dev/cosign/verifying/verify/)
- [cert-manager HTTP-01（证书管理器 HTTP 验证）](https://cert-manager.io/docs/configuration/acme/http01/)
- [cert-manager ACME certificate profiles（证书管理器 ACME 证书配置档）](https://cert-manager.io/docs/configuration/acme/#acme-certificate-profiles)
- [Let’s Encrypt 公网 IP 短期证书正式可用](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)
- [Let’s Encrypt certificate profiles（证书配置档）](https://letsencrypt.org/ca/docs/profiles/)
- [Traefik TLSStore（传输层安全证书仓库）](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/crd/tls/tlsstore/)
- [Traefik ForwardAuth（Traefik 前置认证）](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/)
- [Traefik RateLimit（Traefik 速率限制）](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/)
- [Traefik Buffering（Traefik 请求缓冲与大小限制）](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/)
- [oauth2-proxy 配置](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/)
- [Cloudflare Turnstile（Cloudflare 人机验证服务）概览](https://developers.cloudflare.com/turnstile/)
- [Cloudflare Turnstile（Cloudflare 人机验证服务）接入与服务端校验](https://developers.cloudflare.com/turnstile/get-started/)
- [Cloudflare Turnstile（Cloudflare 人机验证服务）套餐](https://developers.cloudflare.com/turnstile/plans/)
- [Cloudflare Turnstile（Cloudflare 人机验证服务）隐私要求](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/turnstile/)
- [OWASP Session Management（OWASP 会话管理）](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP 敏感数据 URL（网址）边界](https://cornucopia.owasp.org/taxonomy/asvs-5.0/14-data-protection/02-general-data-protection)

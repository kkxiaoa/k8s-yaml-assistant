# K3s 特权部署适配器实施计划

> 状态：执行中；Task 1-6（任务 1-6）已完成实现和审核。Task 7 Step 1（任务 7 步骤 1）已完成草稿重定向、候选镜像重建和六项证据回读，等待 review（审核）；`v0.1.0` 仍未 Publish（正式发布），生产运行器、GitHub deployment（GitHub 部署记录）和应用 Deployment/Pod（工作负载 / 容器组）均未变化。
> 用途：把已审核的 K3s（轻量 Kubernetes）特权 deployment adapter（部署适配器）设计拆成反例优先的仓库实现、Kubernetes bootstrap（Kubernetes 引导配置）、生产 runner（运行器）、发布工作流和私有验收步骤。
> 对应设计：`docs/superpowers/specs/2026-07-20-k3s-deployment-adapter-design.md`。
> 执行位置：本计划的 Task 1-5（任务 1-5）服务于生产部署总计划的 Task 13（任务 13）；Task 6-7（任务 6-7）服务于总计划的 Task 14（任务 14）。每个 Task（任务）完成后独立停止审核。

## 目标

在不向生产 runner（运行器）授予 kubeconfig（客户端配置）、模型 Secret（密钥）、SSH 私钥、Docker socket（Docker 套接字）或仓库写权限的前提下，实现一个 root-owned（root 所有）的固定适配器。它只接受经过 Published Release（已发布版本）工作流签名授权的 deploy/rollback（部署 / 回滚）请求，只能更新 `k8s-yaml-assistant-prod` 中固定 Deployment（工作负载）的镜像内容摘要，并在失败时恢复最近一次成功状态。

本计划完成不代表应用已经公开。Phase 3（阶段 3）始终保持 80/443 不公开，只通过固定来源 SSH tunnel/port-forward（SSH 隧道 / 端口转发）进行私有验收。

## 已固定实施输入

### 服务器与集群

2026-07-27 已实时只读确认：

| 输入 | 固定事实 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.4 LTS，内核 `6.8.0-136-generic` |
| CPU 架构 | `x86_64`，对应 `linux/amd64` |
| K3s | `v1.36.2+k3s1`，服务为 `active/enabled` |
| Python（Python 运行时） | `/usr/bin/python3`，版本 `3.12.3` |
| sudo（提权工具） | `1.9.15p5`，`/usr/sbin/visudo` 可用 |
| systemd（系统服务管理器） | `255`，`/usr/bin/systemd-analyze` 可用 |
| 应用资源 | `k8s-yaml-assistant-prod` Namespace（命名空间）、固定 bootstrap（引导配置）和三类运行时 Secret（密钥）已创建；Deployment（工作负载）尚未创建 |
| 生产 runner（运行器） | 系统账号和组已创建；`huawei-k3s-prod-1` 已注册到当前私有仓库，服务为 `active/enabled`（运行中 / 开机自启），GitHub 状态为在线空闲 |
| 固定适配器路径 | 入口、配置、状态目录、root-only（仅 root）运行时目录和 Cosign（签名工具）均已按固定权限安装 |

每个服务器变更 Task（任务）开始前重新执行轻量 preflight（前置核对）；结果不一致时停止，不用新事实静默覆盖本计划。

### 固定外部产物

| 产物 | 固定版本与来源 | SHA-256（安全哈希算法） | 大小 |
| --- | --- | --- | ---: |
| Cosign（签名工具） | `v3.1.2`，`https://github.com/sigstore/cosign/releases/download/v3.1.2/cosign-linux-amd64` | `f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf` | 141,150,460 |
| Cosign checksum（Cosign 校验和） | `https://github.com/sigstore/cosign/releases/download/v3.1.2/cosign_checksums.txt` | `3ef5d389c3f508b96025fd1b92744a305c46e95951c91242b57467567d5622db` | 3,906 |
| Sigstore trusted root（Sigstore 信任根） | production TUF target v14（生产更新框架目标版本 14），一致性快照 URL 见下文 | `6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66` | 6,787 |
| GitHub Actions runner（GitHub 自动化流水线运行器） | `v2.336.0`，`https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz` | `04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d` | 226,035,903 |

固定 Sigstore trusted root（Sigstore 信任根）一致性快照地址为：

```text
https://tuf-repo-cdn.sigstore.dev/targets/6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66.trusted_root.json
```

该文件已用 Cosign `v3.1.2`、现有 `v0.1.0` provenance bundle（来源证明包）和候选镜像内容摘要完成无网络验证。Task 2（任务 2）把同一字节提交到仓库；运行时只读取该固定文件，不在线刷新 TUF（更新框架）。信任根更新必须形成新的固定摘要、证明回归和独立审核，不能在服务器自动跟随。

### 固定生产身份

| 类别 | 固定值 |
| --- | --- |
| GHCR 应用镜像 | `ghcr.io/kkxiaoa/k8s-yaml-assistant` |
| Namespace（命名空间） | `k8s-yaml-assistant-prod` |
| Deployment（工作负载） | `k8s-yaml-assistant` |
| container（容器） | `app` |
| Linux runner account（Linux 运行器账号） | `gha-k8s-yaml-prod` |
| Linux runner UID/GID（Linux 运行器用户 / 组数字标识） | `996/988` |
| GitHub runner name（GitHub 运行器名称） | `huawei-k3s-prod-1` |
| custom runner label（自定义运行器标签） | `k8s-yaml-assistant-prod` |
| 适配器入口 | `/usr/local/sbin/k8s-yaml-assistant-deploy` |
| 固定模板 | `/etc/k8s-yaml-assistant-deployer/deployment-template.yaml` |
| 信任根 | `/etc/k8s-yaml-assistant-deployer/sigstore-trusted-root.json` |
| 状态目录 | `/var/lib/k8s-yaml-assistant-deployer` |
| 运行时目录 | `/run/k8s-yaml-assistant-deployer` |
| Cosign（签名工具） | `/usr/local/bin/cosign` |
| K3s（轻量 Kubernetes） | `/usr/local/bin/k3s` |
| kubeconfig（客户端配置） | `/etc/rancher/k3s/k3s.yaml` |
| runner（运行器）安装目录 | `/opt/actions-runner-k8s-yaml-prod` |
| runner work directory（运行器工作目录） | `/opt/actions-runner-k8s-yaml-prod/_work` |
| runner diagnostic directory（运行器诊断目录） | `/opt/actions-runner-k8s-yaml-prod/_diag` |

这些值不通过环境变量、命令行或请求覆盖。变更名称必须同时修改适配器、Kubernetes（容器编排系统）资源、静态契约和文档并重新审核。

## 端到端边界

```text
管理员 Publish Release（发布版本）
  -> tag commit 中的 release trigger workflow（标签提交中的发布触发工作流）
  -> main 中的 reusable deployment workflow（默认分支中的可复用部署工作流）
       -> GitHub-hosted validation job（GitHub 托管验证任务）
       -> 验证 release/tag/source/manifest/provenance
       -> 生成并无密钥签名 deployment authorization（部署授权）
       -> 创建 pending GitHub deployment（待处理部署记录）
  -> production self-hosted job（生产自托管任务）
       -> 不 checkout（检出），permissions={}
       -> Base64（Base64 编码）解码固定请求
       -> sudo -n /usr/local/sbin/k8s-yaml-assistant-deploy
  -> root-owned adapter（root 所有适配器）
       -> 验证部署授权和构建来源证明
       -> 串行化、检查台账和集群状态
       -> apply/rollout/verify 或恢复上一内容摘要
  -> GitHub-hosted finalizer（GitHub 托管收尾任务）
       -> 只记录非敏感结果和 deployment status（部署状态）
```

GitHub deployment（GitHub 部署记录）是 GitHub 侧的非敏感镜像；本机成功台账才是适配器回滚资格和集群一致性的权威事实源。后续候选发布从最新成功 deployment record（部署记录）解析 `currentProductionDigest`，不继续依赖需要人工同步的 `CURRENT_PRODUCTION_DIGEST` repository variable（当前生产内容摘要仓库变量）。

rollback candidate workflow（回滚候选流水线）只接受一个已发布应用版本标签，例如 `v0.1.0`。它从该版本的已签名发布清单派生目标内容摘要，验证来源证明后创建：

```text
rollback-v<version>-sha256-<64-hex>-r<workflow-run-id>
```

格式的 Draft Release（草稿发布版本），并只附带对应 provenance bundle（来源证明包）。它不接受任意内容摘要，不发布、不调度生产 runner（运行器）。管理员 Publish（正式发布）后才进入同一部署授权链；适配器仍会拒绝未出现在本机成功台账中的目标。

## 执行规则

- 严格按 Task 1-7（任务 1-7）顺序执行；每个 Task（任务）完成后停止、汇报并等待 review（审核）。
- 每个协议、权限、状态机和工作流先写失败反例，再实现。
- Task 1-3（任务 1-3）只修改仓库并运行本地门禁；不连接或修改服务器。
- Task 4（任务 4）需要 Kubernetes bootstrap/Secret（Kubernetes 引导配置 / 密钥）当次授权；Task 5（任务 5）需要服务器安装和 runner registration（运行器注册）当次授权；二者不能用本计划审核代替。
- Task 6（任务 6）只实现并通过 Pull Request（合并请求）合入工作流；不 Publish（正式发布）。
- Task 7（任务 7）的草稿删除、Publish（正式发布）、模型 smoke test（冒烟测试）、故障候选和回滚分别需要当次明确授权。
- 不调用 embedding/rerank（向量嵌入 / 重排），不重建索引；有限模型冒烟只允许在 Task 7（任务 7）单独批准后执行。
- 不把密码、私钥、API key（应用程序接口密钥）、runner token/credential（运行器令牌 / 凭据）、GHCR pull token（GHCR 拉取令牌）、Secret（密钥）值或完整 kubeconfig（客户端配置）写入仓库、命令参数、日志、产物或对话。
- 生产 runner（运行器）不执行仓库脚本、不使用 checkout（检出）或第三方 Action（流水线动作），不接触模型或镜像仓库长期凭据。
- 当前源码仓库保持 private repository（私有仓库）期间才允许注册生产 runner（运行器）；源码公开前必须先迁移到独立私有部署仓库、从源码仓库注销运行器并重验工作流身份。
- 生产节点不安装 GitHub CLI（GitHub 命令行工具）或 Node.js（Node.js 运行时）；只有固定 Python（Python 运行时）、Cosign（签名工具）、K3s（轻量 Kubernetes）和系统工具属于适配器依赖。
- 未经明确授权不执行 `git add` 或 `git commit`。

## 计划文件

### Create（创建）

- `deploy/adapter/k8s_yaml_assistant_deploy.py`
- `deploy/adapter/test_k8s_yaml_assistant_deploy.py`
- `deploy/adapter/sigstore-trusted-root.json`
- `deploy/adapter/k8s-yaml-assistant-deploy.sudoers`
- `deploy/adapter/actions-runner-hardening.conf`
- `deploy/adapter/k8s-yaml-assistant-deployer.tmpfiles.conf`
- `deploy/k8s/bootstrap/namespace.yaml`
- `deploy/k8s/bootstrap/service-account.yaml`
- `deploy/k8s/bootstrap/config-map.yaml`
- `deploy/k8s/bootstrap/service.yaml`
- `deploy/k8s/bootstrap/observation-pvc.yaml`
- `deploy/k8s/bootstrap/network-policy.yaml`
- `deploy/k8s/app/deployment-template.yaml`
- `deploy/k8s/README.md`
- `src/release/deployment-authorization.ts`
- `src/release/deployment-authorization.test.ts`
- `scripts/deployment-authorization.ts`
- `scripts/deployment-authorization.test.ts`
- `.github/workflows/published-release-deploy.yml`
- `.github/workflows/published-release.yml`
- `.github/workflows/rollback-candidate.yml`

### Modify（修改）

- `package.json`
- `scripts/README.md`
- `scripts/deployment-contract.test.ts`
- `scripts/workflow-contract.test.ts`
- `.github/workflows/pr-verify.yml`
- `.github/workflows/release-artifacts.yml`
- `src/release/manifest.ts`
- `src/release/manifest.test.ts`
- `scripts/release-manifest.ts`
- `scripts/release-manifest-cli.test.ts`
- `docs/AI应用开发能力训练实现方案.md`：仅在 Task 7（任务 7）完成审核后更新事实状态。
- 本设计和计划：只更新审核状态与实际非敏感证据。

不创建通用 installer（安装器）、配置覆盖层、插件接口、任意命令执行器或独立数据库。服务器安装使用审核后的固定文件和精确命令，避免增加第二套 root 自动化程序。

## Task 1：完整实现并本地验证固定适配器

**Authority（授权）：** 只修改仓库文件并运行不联网、不调用模型的本地测试；不连接服务器。

**Files（文件）：**

- Create（创建）：`deploy/adapter/k8s_yaml_assistant_deploy.py`
- Create（创建）：`deploy/adapter/test_k8s_yaml_assistant_deploy.py`
- Modify（修改）：`package.json`
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写输入和命令面反例**

覆盖：

- 标准输入为空、非法 UTF-8、超过 64 KiB、顶层非对象、重复键、未知字段或错误 `schemaVersion` 时失败；
- `authorizationBundle` 或 `provenanceBundle` 不是原文字符串时失败；
- 外层解析后恢复的 bundle（证明包）字节与来源文件不完全一致时失败，禁止对象重序列化后计算摘要；
- `authorization` 非严格对象、重复键、未知字段、错误类型、十进制 ID（标识）前导零、非法时间、非法提交、错误仓库或错误镜像时失败；
- 动作只接受 `deploy` 或 `rollback`，内容摘要只接受 `sha256:<64-lower-hex>`；
- 普通发布标签只接受 `v<semver>`，回滚标签只接受本计划固定格式且必须与动作匹配；
- 任意命令行参数、环境配置覆盖、路径、URL（统一资源定位符）、清单或额外 `kubectl` 参数都失败；
- 子进程只能使用固定绝对路径、参数数组、`shell=False`、固定环境和超时；
- stdout（标准输出）与错误日志不出现请求正文、证明、YAML（配置文件）、Secret（密钥）样例或第三方错误原文。

- [x] **Step 2（步骤 2）：先写证明、状态和并发反例**

使用测试创建的 fake cosign/fake k3s（伪签名工具 / 伪 K3s）可执行边界覆盖：

- deployment authorization（部署授权）签名、工作流身份、OIDC issuer（开放身份连接签发者）或 `release` 触发器不符；
- provenance（来源证明）签名、主体、构建工作流身份、镜像、内容摘要、源码提交、BuildKit build type（BuildKit 构建类型）或 `runtime` 目标不符；
- `provenanceBundleSha256` 与恢复后的原始字节不符；
- `ledger.json` / `operation.json` 损坏、超限、符号链接、非普通文件、owner/mode（所有者 / 权限）不符；
- 已持有锁返回 `busy`，仅遗留未持有的锁文件不阻塞；
- 遗留 `operation.json` 返回 `recovery_required`；
- 集群实际内容摘要与台账不一致返回 `state_drift`；
- 同一发布、动作、内容摘要和源码提交在新的 run/attempt（运行 / 尝试次数）重跑时不再次 apply（应用）或追加台账；
- 同一 `releaseId` 对应不同动作、内容摘要或源码提交时失败；
- 旧 deploy（部署）授权不能降级，未进入成功台账或等于当前版本的 rollback（回滚）失败；
- Cosign（签名工具）、读取、apply（应用）、rollout（滚动发布）、恢复和删除分别超时且没有遗留后台进程。

- [x] **Step 3（步骤 3）：先写 Kubernetes（容器编排系统）状态机反例**

覆盖：

- 固定模板镜像标记缺失或出现多次；
- 请求不能改变 Namespace/Deployment/container（命名空间 / 工作负载 / 容器）或模板其他字段；
- server-side apply（服务端应用）出现字段冲突时失败，不使用 `--force-conflicts`；
- generation（代次）、副本数、可用副本、Ready Pod（就绪容器组）、镜像引用或 runtime imageID（运行时镜像标识）任一不符都不写成功台账；
- 首次部署失败只删除本轮首次创建的固定 Deployment（工作负载）；
- 已有版本更新失败时恢复上一成功内容摘要；
- 自动恢复失败保留 `operation.json` 并停止；
- 日志和返回值只包含设计中固定的非敏感字段和稳定故障码。

- [x] **Step 4（步骤 4）：实现一个无配置覆盖的生产入口**

使用一个 Python（Python 运行时）文件实现完整调用链；内部函数按协议解码、证明验证、状态、子进程和集群检查职责组织，但不拆出没有复用或独立边界证据的平行抽象。

生产入口必须：

- 使用 `/usr/bin/python3 -I`；
- 拒绝全部命令行参数；
- 从标准输入最多读取 65,537 字节以判断超限；
- 对 JSON（JSON 文本）使用拒绝重复键的单一严格边界；
- 把恢复后的三段原文写入 `/run/k8s-yaml-assistant-deployer` 的 root-only（仅 root）随机临时目录；
- 使用 `/usr/local/bin/cosign` 和本地 trusted root（信任根）完成两次验证；
- 只在验证完成后解析受签名 authorization（部署授权）和 DSSE payload（DSSE 负载）；
- 使用 `fcntl.flock`、原子 rename（重命名）、文件和目录 `fsync` 维护状态；
- 只调用设计列出的固定 `k3s kubectl` 子命令；
- 最终只输出一行有大小上限的结果 JSON（JSON 文本）。

测试注入只通过生产调用链本身使用的函数参数传递 fixed runtime paths/process runner（固定运行时路径 / 进程执行器）；不增加 CLI flag（命令行标志）、环境变量、debug mode（调试模式）或 test-only production branch（仅测试生产分支）。

- [x] **Step 5（步骤 5）：接入本地命令**

`package.json` 增加唯一命令：

```text
adapter:check
```

它只运行 Python 标准库 `unittest`（单元测试），不安装 Python package（Python 软件包）或访问网络。`scripts/README.md` 记录该命令的输入、写盘和网络边界。

- [x] **Step 6（步骤 6）：验证**

```bash
npm run adapter:check
npm run deploy:check
npm test
npm run typecheck
git diff --check
```

**Stop and report（停止并汇报）：** 严格输入、原始 bundle（证明包）字节、固定子进程面、锁/台账、幂等、首次失败、自动恢复、日志脱敏和测试数量。等待 Task 1 review（任务 1 审核）。

## Task 2：固定信任根、sudoers（提权规则）、runner（运行器）加固和仓库门禁

**Precondition（前置条件）：** Task 1（任务 1）审核通过。

**Authority（授权）：** 只修改仓库和运行本地测试；不安装 Cosign（签名工具）或 runner（运行器），不连接服务器。

**Files（文件）：**

- Create（创建）：`deploy/adapter/sigstore-trusted-root.json`
- Create（创建）：`deploy/adapter/k8s-yaml-assistant-deploy.sudoers`
- Create（创建）：`deploy/adapter/actions-runner-hardening.conf`
- Modify（修改）：`scripts/deployment-contract.test.ts`
- Modify（修改）：`scripts/workflow-contract.test.ts`
- Modify（修改）：`.github/workflows/pr-verify.yml`
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写静态安全反例**

覆盖：

- trusted root（信任根）不是 6,787 字节或 SHA-256（安全哈希算法）不等于固定值；
- sudoers（提权规则）包含通配符、动态参数、环境保留、shell（命令行解释器）或固定入口以外的命令；
- 规则允许 runner（运行器）带参数、设置环境变量、调用替代路径或其他 root 命令；
- systemd（系统服务管理器）加固缺少独立账号、`UMask=0077`、文件系统保护、设备/内核保护、metadata service（元数据服务）拒绝、资源上限或有界工作目录；
- 错误启用 `NoNewPrivileges=true` 导致唯一 sudo（提权）入口不可用；
- 生产 runner（运行器）加入 `docker`、`k3s` 或管理组；
- PR workflow（合并请求流水线）缺少 `npm run adapter:check`；
- 除未来固定 `published-release-deploy.yml` 外，任何 workflow（流水线）出现 production label（生产标签）或 `self-hosted`；
- 工作流或仓库文件出现完整 kubeconfig（客户端配置）、Secret（密钥）值、runner token（运行器令牌）或真实凭据格式。

- [x] **Step 2（步骤 2）：提交固定信任根**

只提交本计划固定 TUF target（更新框架目标）的原始 6,787 字节。测试同时验证：

- 文件是合法 Sigstore TrustedRoot JSON（Sigstore 信任根 JSON）；
- 文件摘要和大小固定；
- 仓库中没有第二份信任根；
- adapter（适配器）生产路径只指向安装后的同一文件。

- [x] **Step 3（步骤 3）：实现无参数 sudoers（提权规则）**

规则只允许 `gha-k8s-yaml-prod` 无交互调用：

```text
/usr/local/sbin/k8s-yaml-assistant-deploy
```

不使用 `*`，不允许参数，不设置 `SETENV`（设置环境），不允许 `/usr/bin/python3`、`k3s`、`kubectl`、shell（命令行解释器）或文件工具。仓库测试先做文本契约；服务器安装前再用实际 `visudo -cf` 和允许/拒绝命令验证。

- [x] **Step 4（步骤 4）：实现 runner service drop-in（运行器服务附加配置）**

固定 service drop-in（服务附加配置）只描述审核后的 systemd（系统服务管理器）边界，不硬编码尚未由官方 `svc.sh` 生成的 unit name（服务单元名）。安装时必须先把唯一生成的服务名解析为固定仓库和 runner name（运行器名称），再安装到该服务的 `.d` 目录。

工作和诊断目录使用 service-private tmpfs（服务私有内存文件系统）候选上限 128 MiB / 32 MiB；资源候选固定为 `MemoryMax=1G`、`CPUQuota=200%`、`TasksMax=256`。Task 5（任务 5）必须验证 systemd 255（系统服务管理器版本 255）能把两个固定目录以 runner account（运行器账号）可写、其他账号不可读的方式挂载，并在空任务和正常固定调用中实测资源边界；不能为了启动成功整体放宽 `/opt`、`/var/lib` 或 `/run`。

固定运行时目录由 root-owned（root 所有）的 `tmpfiles.d`（临时目录创建规则）以 `root:root 0700` 创建，覆盖节点重启后 `/run` 被清空的语义。不能使用 `RuntimeDirectory`（运行时目录），因为服务管理器会在启动完成时把目录所有权交给服务账号；也不能用特权 `ExecStartPre`（启动前命令）假设该所有权随后不会被覆盖。

工作和诊断目录只能由 `TemporaryFileSystem`（临时文件系统）提供，不得同时列入 `ReadWritePaths`；后者会创建同路径的主机文件系统绑定挂载并遮蔽有界 tmpfs（内存文件系统）。

systemd（系统服务管理器）会为每次服务执行重新建立私有挂载命名空间，不能依赖 `ExecStartPre`（启动前命令）在一个执行阶段修改下一阶段 tmpfs（内存文件系统）的所有者。两个挂载直接使用已核对的专用账号 `uid=996,gid=988`；账号创建或灾难恢复时必须先确认该 UID/GID（用户 / 组数字标识）未被占用，再以固定值创建或停止审核，不能静默改成另一组数字。

- [x] **Step 5（步骤 5）：把 adapter（适配器）门禁接入 Pull Request（合并请求）**

`pr-verify.yml` 在 GitHub-hosted runner（GitHub 托管运行器）执行 `npm run adapter:check`。该任务不安装 Cosign（签名工具）、不读取 Secret（密钥）、不连接生产服务器，也不运行 self-hosted runner（自托管运行器）。

- [x] **Step 6（步骤 6）：验证**

```bash
npm run adapter:check
npm run deploy:check
npm run workflow:check
npm test
npm run typecheck
git diff --check
```

**Stop and report（停止并汇报）：** 固定信任根身份、sudoers（提权规则）唯一允许面、systemd（系统服务管理器）加固、资源候选和 Pull Request（合并请求）门禁。等待 Task 2 review（任务 2 审核）。

## Task 3：实现 Kubernetes bootstrap（Kubernetes 引导配置）和固定 Deployment（工作负载）模板

**Precondition（前置条件）：** Task 2（任务 2）审核通过。

**Authority（授权）：** 只创建仓库中的非敏感资源和测试；不连接服务器，不创建 Kubernetes（容器编排系统）资源或 Secret（密钥）。

**Files（文件）：**

- Create（创建）：`deploy/k8s/bootstrap/namespace.yaml`
- Create（创建）：`deploy/k8s/bootstrap/service-account.yaml`
- Create（创建）：`deploy/k8s/bootstrap/config-map.yaml`
- Create（创建）：`deploy/k8s/bootstrap/service.yaml`
- Create（创建）：`deploy/k8s/bootstrap/observation-pvc.yaml`
- Create（创建）：`deploy/k8s/bootstrap/network-policy.yaml`
- Create（创建）：`deploy/k8s/app/deployment-template.yaml`
- Create（创建）：`deploy/k8s/README.md`
- Modify（修改）：`scripts/deployment-contract.test.ts`

- [x] **Step 1（步骤 1）：先写资源反例**

覆盖生产总计划 Task 13（任务 13）的全部资源反例，并额外固定：

- 所有资源必须属于 `k8s-yaml-assistant-prod`，禁止 `default`；
- bootstrap（引导配置）不得包含 Deployment（工作负载）或运行中的应用版本；
- template（模板）只能有一个镜像标记，不能出现可变 tag（标签）或第二个容器写入 observation PVC（观测持久卷声明）；
- ServiceAccount（服务账户）不自动挂载 token（令牌），仓库没有 Role/RoleBinding（角色 / 角色绑定）；
- NetworkPolicy（网络策略）允许应用所需 DNS（域名系统）和出站 443，但文档不得声称标准策略实现域名 allowlist（允许名单）；
- PVC（持久卷声明）只用于受控 `data/observability/`，索引仍在镜像内只读；
- ConfigMap（普通配置）完整显式配置当前 runtime config（运行时配置），`ACCESS_MODE=private`；
- 模型和 GHCR 凭据只通过 Secret/imagePullSecret（密钥 / 镜像拉取密钥）引用，不出现值或占位对象。

- [x] **Step 2（步骤 2）：实现固定 bootstrap（引导配置）**

按已审核生产设计创建：

- restricted Pod Security（受限容器组安全）标签的 Namespace（命名空间）；
- 无 Kubernetes API（Kubernetes 应用程序接口）权限的 ServiceAccount（服务账户）；
- 显式非敏感 ConfigMap（普通配置）；
- ClusterIP Service（集群内服务）；
- 1 GiB local-path PVC（本地路径持久卷声明），应用仍执行 7 天 / 256 MiB 生命周期上限；
- 不夸大域名隔离能力的 NetworkPolicy（网络策略）。

不创建 Ingress、TLS、OAuth、Turnstile、匿名额度、计量、数据库或向量数据库资源。

- [x] **Step 3（步骤 3）：实现固定 Deployment（工作负载）模板**

模板固定单副本、`maxSurge=0`、`maxUnavailable=1`、`revisionHistoryLimit=3`、探针、资源候选、安全上下文、只读根文件系统、`/tmp` 有界卷、observation PVC（观测持久卷声明）和 Secret（密钥）引用，只留下一个精确镜像标记。

适配器替换标记后的结果必须是：

```text
ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:<64-hex>
```

- [x] **Step 4（步骤 4）：补齐运维说明**

`deploy/k8s/README.md` 记录：

- 每个资源的职责和所有者；
- Secret（密钥）只记录名称、key（键）职责、创建和轮换流程，不记录值；
- observation PVC（观测持久卷声明）与节点同故障域；
- bootstrap（引导配置）、应用版本和入口资源的分离边界；
- server-side dry-run（服务端试运行）、验证和非破坏性回退命令。

- [x] **Step 5（步骤 5）：验证**

```bash
npm run deploy:check
npm run adapter:check
npm test
npm run typecheck
git diff --check
```

**Stop and report（停止并汇报）：** 资源清单、固定模板唯一可变字段、Secret（密钥）职责、NetworkPolicy（网络策略）实际边界、资源候选和“尚未创建集群资源”证据。等待 Task 3 review（任务 3 审核）。

## Task 4：安全创建 bootstrap resource（引导资源）和运行时凭据

**Precondition（前置条件）：** Task 3（任务 3）审核通过；用户分别授权 Kubernetes bootstrap（Kubernetes 引导配置）和 Secret（密钥）创建；运行时模型密钥与 GHCR（GitHub 容器镜像仓库）只读拉取凭据已在外部密码管理器准备。

**Authority（授权）：** 只创建审核过的固定非版本资源和三类运行时凭据；不安装适配器或 runner（运行器），不创建 Deployment（工作负载），不 Publish（正式发布），不开放端口。

- [x] **Step 1（步骤 1）：实时 preflight（前置核对）**

只读确认：

- K3s/Python/sudo/systemd（K3s / Python 运行时 / 提权工具 / 系统服务管理器）仍与固定输入一致；
- Namespace（命名空间）、应用 Deployment（工作负载）、runner（运行器）和适配器仍不存在；
- 80/443/6443 仍未公开；
- Kubernetes（容器编排系统）没有同名资源或意外 field manager（字段管理者）。

- [x] **Step 2（步骤 2）：服务端试运行**

先对固定 bootstrap（引导配置）执行 client-side/server-side dry-run（客户端 / 服务端试运行）和 diff（差异）。任何准入、字段所有权、StorageClass（存储类）或 NetworkPolicy（网络策略）异常都停止，不使用 `--force-conflicts`。

- [x] **Step 3（步骤 3）：创建固定非敏感资源**

只应用 Task 3（任务 3）审核的 bootstrap（引导配置）；不应用 Deployment（工作负载）模板。回读 Namespace、ServiceAccount、ConfigMap、Service、PVC 和 NetworkPolicy（命名空间 / 服务账户 / 普通配置 / 服务 / 持久卷声明 / 网络策略）的精确身份。

- [x] **Step 4（步骤 4）：通过受限标准输入创建 Secret（密钥）**

分别创建：

- 运行时 DeepSeek Secret（DeepSeek 密钥）；
- 运行时 Voyage Secret（Voyage 密钥）；
- `ghcr-pull` imagePullSecret（镜像拉取密钥），只具备 `read:packages`。

值从仓库外 0600 临时输入或隐藏交互输入进入本机 `kubectl` 标准输入；不得进入 shell history/process list（命令历史 / 进程列表）、生成 YAML（配置文件）、日志或对话。删除临时输入前列出精确路径并再次确认范围；回读只检查 Secret（密钥）名称、类型、key（键）集合和权限，不输出 `.data`。

- [x] **Step 5（步骤 5）：验证无运行版本和无公开入口**

确认：

- Namespace（命名空间）内没有 Deployment/Pod（工作负载 / 容器组）；
- PVC（持久卷声明）已绑定或处于符合 local-path（本地路径）延迟绑定语义的预期状态；
- 应用 Service（服务）只为 ClusterIP（集群内地址）；
- 没有 Ingress/NodePort/LoadBalancer（入口 / 节点端口 / 负载均衡器）；
- 服务器新增监听端口为零。

2026-07-27 实施结果：全部固定资源通过严格 server-side dry-run/diff（服务端试运行 / 差异）后由 `k8s-yaml-assistant-bootstrap` 创建；三类 Secret（密钥）通过受限标准输入由 `k8s-yaml-assistant-secrets` 创建，回读仅包含名称、类型和 key（键）集合。应用 ServiceAccount（服务账户）不能读取或列举 Secret（密钥），PVC（持久卷声明）按 `WaitForFirstConsumer`（等待首个消费者）保持 `Pending`（等待中），集群没有 Deployment/Pod/Ingress（工作负载 / 容器组 / 入口），80/443/6443 从当次外部来源均不可达。本地临时输入和对应 GHCR（GitHub 容器镜像仓库）钥匙串登录项已在单独确认范围后删除。

**Rollback（回滚）：** 优先保留已创建的 Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）并停止后续步骤。删除任何有状态资源前先列出精确对象并获得单独授权。

**Stop and report（停止并汇报）：** server-side diff（服务端差异）、资源身份、Secret（密钥）职责但不含值、PVC（持久卷声明）状态、监听端口和“应用尚未部署”证据。等待 Task 4 review（任务 4 审核）。

## Task 5：安装适配器、Cosign（签名工具）和 production runner（生产运行器）

**Precondition（前置条件）：** Task 4（任务 4）审核通过；用户分别授权服务器文件安装和 GitHub runner registration（GitHub 运行器注册）。

**Authority（授权）：** 只安装固定产物、适配器、运行器账号/服务并注册当前私有仓库；不执行部署工作流、不创建 Deployment（工作负载）、不 Publish（正式发布）。

- [x] **Step 1（步骤 1）：固定产物双重校验**

在本机受控临时目录从本计划固定 URL（统一资源定位符）下载 Cosign（签名工具）、checksum（校验和）和 runner（运行器）归档：

- Cosign（签名工具）二进制同时匹配 GitHub API asset digest（GitHub 应用程序接口产物摘要）、本计划和固定 `cosign_checksums.txt`；
- runner（运行器）归档同时匹配 GitHub API asset digest（GitHub 应用程序接口产物摘要）和本计划固定值；
- trusted root（信任根）同时匹配 TUF targets v14 metadata（更新框架目标版本 14 元数据）中的长度、摘要和本计划固定值；
- 只把已经核验的二进制、归档和仓库文件通过 SSH（安全远程登录）传到服务器受控临时目录；
- 服务器再次计算同一摘要；
- 任一大小、摘要、版本或架构不一致立即停止。

不在服务器执行 `curl | sh`、源码构建或浮动版本下载。

- [x] **Step 2（步骤 2）：安装 root-owned adapter（root 所有适配器）**

使用精确 `install` 命令创建固定目录和权限：

- adapter（适配器）、Cosign（签名工具）、模板和信任根为 `root:root`，生产 runner（运行器）不可写；
- 状态目录为 root-only（仅 root）；
- 运行时目录由适配器按调用创建并验证；
- 适配器版本回读、Python isolated mode（Python 隔离模式）和无参数拒绝用例通过。

用已审核 `v0.1.0` provenance bundle（来源证明包）在服务器执行一次无网络 Cosign（签名工具）验证后删除临时证明文件。该步骤不调用适配器、不创建 Deployment（工作负载）。

- [x] **Step 3（步骤 3）：安装并验证 sudoers（提权规则）**

把单一规则安装到 `/etc/sudoers.d/`，先执行：

```text
/usr/sbin/visudo -cf <exact-file>
```

再从 runner account（运行器账号）验证：

- 无参数固定入口可以到达适配器并因空输入安全失败；
- 带参数、环境赋值、替代路径、`python3`、`k3s`、shell（命令行解释器）和其他命令全部被 sudo（提权工具）拒绝。

- [x] **Step 4（步骤 4）：创建独立 runner account（运行器账号）**

创建固定 UID `996`、固定 GID `988` 的 `gha-k8s-yaml-prod` 无密码、无登录 shell（命令行环境）系统账号和同名组；创建前必须确认两个数字标识没有其他所有者。不加入 `sudo`、`docker`、`k3s` 或其他管理组。安装目录中二进制保持 root-owned（root 所有），只给运行凭据和必要状态最小读取权限。

- [x] **Step 5（步骤 5）：安全注册固定版本 runner（运行器）**

注册令牌由本机已登录 GitHub CLI（GitHub 命令行工具）短期获取，通过 SSH（安全远程登录）标准输入交给受控注册进程。固定 runner `v2.336.0` 支持 `ACTIONS_RUNNER_INPUT_TOKEN`；令牌只进入该进程环境，runner（运行器）启动后立即从环境移除，不进入命令参数、文件、shell history（命令历史）或对话。

注册固定：

- repository（仓库）为 `kkxiaoa/k8s-yaml-assistant`；
- name（名称）为 `huawei-k3s-prod-1`；
- labels（标签）为默认 Linux/X64（Linux / X64）加 `k8s-yaml-assistant-prod`；
- `--disableupdate`；
- 工作目录为审核后的有界路径；
- 不使用 `--replace` 覆盖未知 runner（运行器）。

官方 `svc.sh` 生成服务后，必须回读唯一 unit name（服务单元名）并证明它同时绑定固定仓库和 runner name（运行器名称）；匹配数不是 1 时停止。

- [x] **Step 6（步骤 6）：安装并实测 systemd hardening（systemd 加固）**

安装 Task 2（任务 2）审核的 drop-in（附加配置），逐项执行 daemon-reload、启动、状态、日志和 `systemd-analyze security`。验证：

- 服务以 `gha-k8s-yaml-prod` 运行；
- runner（运行器）二进制和配置不可被任务改写；
- 工作/诊断 tmpfs（内存文件系统）上限与 `MemoryMax` 不冲突；
- metadata service（元数据服务）地址被拒绝；
- GitHub Actions（GitHub 自动化流水线）出站 443 正常；
- 唯一 sudo（提权）入口仍可用；
- 没有新增监听端口。

需要放宽时只处理被实测命令直接证明的最小项并重新 review（审核），不能一次移除整组保护。

安装 drop-in（附加配置）前，先把固定 `tmpfiles.d`（临时目录创建规则）安装到 `/etc/tmpfiles.d/k8s-yaml-assistant-deployer.conf`，执行 `systemd-tmpfiles --create`，并回读 `/run/k8s-yaml-assistant-deployer` 为 `root:root 0700`。工作和诊断目录不得列入 `ReadWritePaths`，必须从服务进程的 mount namespace（挂载命名空间）证明它们分别是 128 MiB 和 32 MiB 的 tmpfs（内存文件系统），而不是主机系统盘的 bind mount（绑定挂载）。

2026-07-27 首次真实启动已确认服务账号、固定标签、资源上限、metadata service（元数据服务）拒绝、唯一 sudo（提权）入口和零新增监听端口，但同时证明旧配置的工作/诊断目录仍落在 177.1 GiB 主机文件系统，且运行时目录最终为运行器账号所有。该次验证按失败关闭处理：服务已经停止并禁用，GitHub API（GitHub 应用程序接口）回读为离线，注册和凭据保留；修正配置通过审核并重新实测前不得启用。

修正候选已经在服务器 root-only（仅 root）暂存目录使用 `systemd-tmpfiles --root`（临时目录工具替代根目录）模拟创建，结果为 `root:root 0700`，没有触碰真实 `/run`。服务器的 systemd 255（系统服务管理器版本 255）不支持 `systemd-tmpfiles --dry-run`，后续不能把该参数写入实施命令。

首次修正启动进一步证明 `ExecStartPre`（启动前命令）不能把后续执行阶段的服务私有 tmpfs（内存文件系统）交给运行器账号；listener（监听进程）因无法写诊断目录安全失败，服务再次停止并禁用。最终配置删除该无效命令，直接以固定 `uid=996,gid=988` 挂载，先通过 transient service（瞬态服务）写入探针，再完成真实启动和第二次服务重启。两次最终启动均证明工作/诊断目录为 128 MiB / 32 MiB、`0700`、运行器账号所有，运行时目录为 `root:root 0700`；`NRestarts=0`，日志显示固定版本 `2.336.0` 已连接并等待任务。`systemd-analyze security`（系统服务安全分析）当前评分为 `6.3 MEDIUM`（中等暴露），保留原因包括生产任务所需出站网络和唯一 sudo（提权）入口；本 Task（任务）不以删除真实消费者换取评分。

`--disableupdate` 只关闭运行中自动替换，不能形成永久冻结。`deploy/k8s/README.md` 必须记录固定 runner（运行器）发布时间、安装时间和最晚复核时间；GitHub 发布新 runner（运行器）后 30 天内完成固定版本升级或主动下线旧运行器。升级仍须重新固定 URL（统一资源定位符）、摘要和本 Task（任务）的空任务验证。

- [x] **Step 7（步骤 7）：确认 runner（运行器）尚未接收生产任务**

GitHub API（GitHub 应用程序接口）已回读唯一在线、空闲 runner（运行器）及固定标签；仓库尚无 `published-release-deploy.yml`，K3s（轻量 Kubernetes）仍无应用 Deployment/Pod/Ingress（工作负载 / 容器组 / 入口）。修正后的全部隔离证据已经通过，服务保持在线等待 Task 5 review（任务 5 审核）。

**Rollback（回滚）：** 先在 GitHub（代码托管平台）删除或禁用 runner（运行器），再停止本机服务；撤销注册令牌同样使用环境输入。适配器文件可原子恢复上一审核版本。删除 Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）不属于本 Task（任务）。

**Stop and report（停止并汇报）：** 固定产物摘要、安装权限、Cosign（签名工具）离线验证、sudoers（提权规则）允许/拒绝矩阵、runner scope（运行器范围）、服务加固、监听端口和 K3s（轻量 Kubernetes）零 Deployment（工作负载）证据。等待 Task 5 review（任务 5 审核），该审核通过后总计划 Task 13（任务 13）才算完成。

## Task 6：实现 Published Release（已发布版本）部署与回滚候选工作流

**Precondition（前置条件）：** Task 5（任务 5）及总计划 Task 13（任务 13）审核通过。

**Authority（授权）：** 只修改仓库并通过受控 Pull Request（合并请求）合入工作流；不创建、编辑、删除或 Publish（正式发布）任何 Release（发布版本），不调度生产 runner（运行器）。

**Files（文件）：**

- Create（创建）：`src/release/deployment-authorization.ts`
- Create（创建）：`src/release/deployment-authorization.test.ts`
- Create（创建）：`scripts/deployment-authorization.ts`
- Create（创建）：`scripts/deployment-authorization.test.ts`
- Create（创建）：`.github/workflows/published-release.yml`
- Create（创建）：`.github/workflows/published-release-deploy.yml`
- Create（创建）：`.github/workflows/rollback-candidate.yml`
- Modify（修改）：`.github/workflows/release-artifacts.yml`
- Modify（修改）：`src/release/manifest.ts`
- Modify（修改）：`src/release/manifest.test.ts`
- Modify（修改）：`scripts/release-manifest.ts`
- Modify（修改）：`scripts/release-manifest-cli.test.ts`
- Modify（修改）：`scripts/workflow-contract.test.ts`
- Modify（修改）：`package.json`
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写 authorization（授权）和部署状态反例**

覆盖：

- authorization（授权）字段缺失、未知、类型错误、顺序不稳定或换行不固定；
- `releaseId`、`workflowRunId`、`workflowRunAttempt` 不是规范十进制字符串；
- deploy（部署）使用回滚标签或 rollback（回滚）使用普通发布标签；
- `provenanceBundleSha256` 不是原始文件字节摘要；
- 外层请求把 bundle（证明包）写成对象而不是原文字符串；
- latest successful deployment（最新成功部署）解析接受 pending/failure/inactive（待处理 / 失败 / 非活动）状态、错误环境、错误仓库、非法摘要或多义最新记录；
- 没有成功记录时不返回 `none`；
- release artifacts workflow（发布证据流水线）仍读取 `CURRENT_PRODUCTION_DIGEST`、未从最新成功部署记录解析当前生产镜像的实现必须被契约测试拒绝。

- [x] **Step 2（步骤 2）：实现共享严格 authorization contract（授权契约）**

TypeScript（类型系统）只负责 GitHub-hosted job（GitHub 托管任务）侧生成和验证：

- 固定属性顺序、UTF-8 和一个末尾换行的 authorization JSON（授权 JSON）；
- deploy/rollback（部署 / 回滚）两种严格输入；
- 原始 bundle（证明包）字符串和固定外层请求；
- 整体 64 KiB 上限，以及 JSON string encoding（JSON 字符串编码）后的 authorization / authorization bundle / provenance bundle（授权 / 授权证明包 / 来源证明包）2 KiB / 28 KiB / 32 KiB 独立预算；
- 与 Python adapter（Python 适配器）相同的正反例 fixture（夹具）。

不实现 RFC 8785（JSON 规范化标准）或通用 canonicalizer（规范化器）；固定扁平协议只使用单一构造函数序列化一次。

`package.json` 增加 `deployment:authorize` 作为唯一 CLI（命令行接口）入口，直接消费无副作用模块；`published-release-deploy.yml` 是其生产消费者。`scripts/README.md` 记录输入只来自已经下载并验证的发布事件/附件，输出只包含非敏感授权和证明封装。

- [x] **Step 3（步骤 3）：用 GitHub deployment（GitHub 部署记录）替代人工变量**

`release-artifacts.yml` 只读获取 `production-private` 环境最新成功 deployment record（部署记录），严格解析其非敏感 payload（负载）中的镜像内容摘要；没有记录时返回 `none`。移除 `vars.CURRENT_PRODUCTION_DIGEST` 读取。

生产适配器本机台账仍是权威事实源。GitHub deployment（GitHub 部署记录）只服务下一候选发布说明和外部审计；两者不一致时未来发布停下审核，不能让 GitHub 记录覆盖本机台账。

代码合入并确认没有消费者后，删除外部 repository variable（仓库变量）`CURRENT_PRODUCTION_DIGEST` 需要单独授权和 API（应用程序接口）回读；不把无消费者配置长期保留。

2026-07-27 已在 Pull Request #9（合并请求 #9）合入并完成消费者回查后获得单独授权，删除该变量；GitHub API（GitHub 应用程序接口）回读确认仓库变量列表为空。

- [x] **Step 4（步骤 4）：先写 workflow（流水线）反例**

`published-release.yml` 只能接受 `release: types: [published]`，且只能以 `@main` 调用同仓库 `published-release-deploy.yml` reusable workflow（可复用工作流）。它不能包含普通步骤、生产运行器标签、Secret（密钥）或其他触发器。

`published-release-deploy.yml` 只能接受 `workflow_call`（复用调用），并在任何签名或部署记录写入前拒绝：

- 调用方事件不是 `release`、事件 action（动作）不是 `published`，或调用方 ref/commit（引用 / 提交）不是本次发布标签；
- 非 `release: types: [published]`、`draft=true`、`prerelease=true` 或发布操作者不是唯一管理员；
- 普通发布缺少或多出六项证据，标签/提交/清单/签名/主体不一致；
- 回滚发布标签格式错误、目标来源发布未发布、证明包缺失/多出或目标未绑定完整内容摘要；
- GitHub-hosted validation job（GitHub 托管验证任务）没有在签名授权前完成全部验证；
- GitHub-hosted job（GitHub 托管任务）使用未固定提交哈希或未经当前仓库门禁允许的 Action（流水线动作）；
- production job（生产任务）使用 checkout（检出）、Action（流水线动作）、容器、仓库脚本、下载、动态 shell interpolation（命令插值）或任何 Secret（密钥）；
- production job（生产任务）权限不为空、标签不精确、并发允许取消、超时缺失；
- adapter result（适配器结果）原文进入日志或部署记录；
- draft/edited/deleted（草稿 / 编辑 / 删除）事件能调度生产 runner（运行器）。

`rollback-candidate.yml` 必须拒绝：

- 非 `workflow_dispatch`；
- 操作者不是唯一管理员，或触发 ref（引用）不是受保护 `main`；
- 输入任意 digest/URL/path/manifest（内容摘要 / 网址 / 路径 / 清单）；
- 来源标签不是已发布 `v<semver>`；
- 来源发布清单或 provenance（来源证明）验证失败；
- 并发运行未使用同一不可取消的 concurrency group（并发组）串行化；
- 自动 Publish（正式发布）、创建生产 deployment（部署记录）或使用 self-hosted runner（自托管运行器）；
- 生成的回滚标签未绑定完整目标内容摘要和 workflow run ID（流水线运行标识）。

- [x] **Step 5（步骤 5）：实现 Published Release（已发布版本）验证和授权**

GitHub-hosted validation job（GitHub 托管验证任务）：

1. 从 release trigger workflow（发布触发工作流）继承发布事件，回读 event release（事件发布版本）、真实标签和提交；
2. 对普通发布下载并精确验证六项附件；
3. 对回滚发布验证固定标签格式和唯一 provenance bundle（来源证明包）；
4. 验证 Cosign（签名工具）证明身份、OIDC issuer（开放身份连接签发者）、主体、源码提交和构建类型；
5. 生成固定 authorization（授权）；
6. 使用当前工作流 OIDC（开放身份连接）进行无密钥 `cosign sign-blob`；
7. 立即用完整 identity/issuer/trigger（身份 / 签发者 / 触发器）回验；
8. 生成原文字符串外层请求和单行 Base64（Base64 编码）job output（任务输出）；
9. 创建固定 `production-private` pending deployment（待处理部署记录）。

普通发布的 Git tag commit（Git 标签提交）、发布清单 `sourceCommit` 和 provenance VCS revision（来源证明版本控制提交）必须相同。回滚发布的标签提交只表示本次回滚请求所在的受保护 `main`；authorization（授权）中的 `sourceCommit` 必须来自历史镜像已验证的 provenance（来源证明），不能错误要求它等于回滚标签提交。

GitHub（代码托管平台）会从 release event（发布事件）关联的标签提交读取触发工作流，而不是事后从默认分支读取同名文件。因此发布标签提交必须包含 `published-release.yml`。该文件只负责调用 `main` 上的 `published-release-deploy.yml`；后者的 `job_workflow_ref`（任务工作流引用）形成下述固定授权证书身份。这样既保留人工 Publish（正式发布）触发语义，也让生产适配器只信任受保护默认分支中的集中部署策略。

authorization certificate identity（授权证书身份）固定为：

```text
https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/published-release-deploy.yml@refs/heads/main
```

并检查 OIDC issuer（开放身份连接签发者）与 workflow trigger（工作流触发器）分别为：

```text
https://token.actions.githubusercontent.com
release
```

- [x] **Step 6（步骤 6）：实现最小 production job（生产任务）**

job（任务）固定：

- `runs-on: [self-hosted, Linux, X64, k8s-yaml-assistant-prod]`；
- `permissions: {}`；
- `timeout-minutes: 30`；
- `concurrency.group: production-deploy`；
- `cancel-in-progress: false`；
- 无 checkout（检出）、无 `uses:`、无容器、无网络下载；
- 只把上游 Base64（Base64 编码）输出解码到标准输入并执行无参数 sudo（提权）入口；
- 只把适配器一行非敏感结果编码为 job output（任务输出），不打印请求、证明或环境。

前后 GitHub-hosted job（GitHub 托管任务）负责 deployment status（部署状态）。适配器失败、任务离线，或结果为空、多行、超过 4 KiB、不是规范 Base64（Base64 编码）时记录 failure（失败），不重试到其他 runner（运行器），不自动改变服务器。部署请求与结果分别使用 64 KiB 和 4 KiB 边界；请求内部还预留 2 KiB authorization（授权）、28 KiB authorization bundle（授权证明包）和 32 KiB provenance bundle（来源证明包）预算，避免单一证明包挤占另一份必需证据，且不能用结果上限误拒绝合法请求。

- [x] **Step 7（步骤 7）：实现 rollback candidate（回滚候选）**

管理员只输入来源发布标签。GitHub-hosted runner（GitHub 托管运行器）验证来源发布清单、镜像内容摘要和 provenance（来源证明），再创建唯一 Draft Release（草稿发布版本）并附带唯一证明包。整个工作流使用固定 `rollback-candidate` concurrency group（回滚候选并发组）且不取消在途运行；重复运行串行后遇到同名或已有活动候选时失败关闭，不覆盖未知草稿。

为 `refs/tags/rollback-*` 增加与 `v*` 等价的创建和不可变规则需要单独 GitHub 外部写入授权：

- 只有管理员可绕过创建限制；
- 任何主体都不能更新或删除已经创建的标签。

- [x] **Step 8（步骤 8）：本地和 Pull Request（合并请求）验证**

```bash
npm run adapter:check
npm run deploy:check
npm run release:check
npm run workflow:check
npm test
npm run typecheck
npm run build
git diff --check
```

本地实现完成上述门禁：Python adapter（Python 适配器）52 项测试、部署授权 68 项测试、发布契约 15 项测试和 workflow contract（流水线契约）10 项测试通过；完整 `npm test`、TypeScript（类型检查）、Next.js build（Next.js 构建）、无索引容器构建、fail-closed smoke test（失败关闭烟雾测试）和运行时漏洞门禁通过。

Pull Request #9（合并请求 #9）最终提交 `492b33bb85cb3fe8b680c3b2bf00d0b308e0b263` 的 GitHub Actions（GitHub 自动化流水线）运行 `30259357571` 通过，合并提交为 `1cec0b4cc6e57a2b018ec260627bbb651a1dcb3b`。合入后的 Release lifecycle（发布生命周期）运行 `30259707368` 只执行状态检查；发布准备、证据构建和恢复任务全部跳过。

合入后外部状态回读确认：

- `v0.1.0` 仍是未发布草稿，没有实际 Git tag（Git 标签），且仍绑定旧提交 `d36128253e25243a9a17e291afa08b4e237133af` 和原六项证据；
- 生产运行器 `huawei-k3s-prod-1` 为在线空闲，没有接收任务；
- GitHub deployment（GitHub 部署记录）只有既有 `index-build`（索引构建）记录，没有 `production-private`（私有生产）记录；
- `k8s-yaml-assistant-prod` Namespace（命名空间）没有应用 Deployment/Pod（工作负载 / 容器组）；
- 无消费者的 `CURRENT_PRODUCTION_DIGEST` 仓库变量已按单独授权删除并完成 API（应用程序接口）回读。

**Stop and report（停止并汇报）：** Task 6（任务 6）的原始字节协议、授权身份、普通/回滚发布分支、production job（生产任务）权限、部署记录镜像、变量清退、标签规则和“尚未发布”证据已经审核完成。后续外部操作属于 Task 7（任务 7），必须按步骤分别授权。

## Task 7：验证 draft → publish → private deploy（草稿 → 发布 → 私有部署）和回滚

**Precondition（前置条件）：** Task 6（任务 6）审核通过；当前 `v0.1.0` 草稿仍未发布。草稿修改与证据重建、Publish（正式发布）、首次部署、回滚草稿删除、有限模型冒烟、故障候选、功能回滚和节点重启分别获得当次明确授权。

- [x] **Step 1（步骤 1）：整体重定向 `v0.1.0` 草稿和六项证据**

当前草稿绑定旧提交 `d36128253e25243a9a17e291afa08b4e237133af`；它不包含 Task 6（任务 6）的发布触发工作流，因此不能直接 Publish（正式发布）。经单独授权后：

1. 回读并保存当前草稿的 Release ID（发布版本标识）、目标提交、正文和六项附件摘要，作为本次变更的恢复依据；
2. 以已审核合并提交 `1cec0b4cc6e57a2b018ec260627bbb651a1dcb3b` 为唯一新 source commit（源提交），更新草稿目标和发布说明；发布说明必须覆盖原 `0.1.0` 内容以及草稿形成后已经审核合入的安全和部署生命周期变更；
3. 手工运行 `Release lifecycle`（发布生命周期）恢复入口；该入口从已经重定向的草稿解析 source commit（源提交），复用既有 8,410 条已签名索引，重新构建候选镜像并用 `--clobber` 替换六项证据；
4. 完整回读草稿、镜像内容摘要、索引身份、release notes hash（发布说明哈希）、发布清单、两类 attestation（证明）和六项附件摘要，确认没有残留旧源码证据；
5. 确认草稿修改和证据恢复没有运行 `published-release.yml` 或 `published-release-deploy.yml`、没有调度生产运行器、没有新增 `production-private` GitHub deployment（私有生产部署记录），且 K3s（轻量 Kubernetes）仍没有应用 Deployment/Pod（工作负载 / 容器组）。

该步骤不调用 Voyage embedding/rerank（Voyage 向量嵌入 / 重排），不重建索引，不 Publish（正式发布）。任一身份或证据校验失败时保持草稿状态并停止；不得发布部分更新的草稿。

2026-07-27 外部执行结果：

- 执行前回读并保留 Release ID（发布版本标识）`359948311`、旧目标 `d36128253e25243a9a17e291afa08b4e237133af`、正文和六项附件快照。
- 首次 REST API（REST 应用程序接口）更新未显式发送 `tag_name` 时，GitHub 把同一草稿的标签名改为临时 `untagged-*`；执行立即停止，未触发任何流水线。随后以同一 Release ID（发布版本标识）显式提交 `name`、`tag_name`、`target_commitish`、`body`、`draft=true` 和 `prerelease=false`，恢复 `v0.1.0` 并完成写后回读。以后人工修改草稿身份时必须在同一请求中提交这些字段。
- 手工恢复运行 `30263136111` 成功解析新目标 `1cec0b4cc6e57a2b018ec260627bbb651a1dcb3b`，验证并复用 8,410 条签名索引，构建、冒烟、扫描、证明并签名候选镜像，最后整体替换六项附件。
- 最终候选镜像为 `sha256:8b512c49ce0c434f0b65eaf69d2fd827209b56e8859473a274230612e9e0b5a4`；索引产物仍为 `sha256:d45ec4f2b52941919aaaaddca48bf25d2fa8c38dacaf9b6ea4d50a98470207c1`，语料和索引计数均为 8,410，发布说明摘要为 `d7521c862914c3359df6d626e098a5de2c8f111291d0a09f05123eb8a3b2ac29`。
- 六项附件的写后 SHA-256（安全哈希算法 256 位）回读为：

| 附件 | 执行前 | 执行后 |
| --- | --- | --- |
| `sbom.spdx.json` | `0c4cbca00e734c9a5a00b7faf605b17257bf15466f81e11ca02b2bf64c59138f` | `56ff6d26ca1fb3525e1259e026170ff7975d6e32cebb0b6e72e847f8db3547ec` |
| `provenance.slsa.json` | `f521008a7c451f352333b11bfe66ef65a1eed3df2e2bd723a3ba12a6d9ce6d91` | `db03b3387fdce8a247fdfc9fb4425c6cf65c56461cd4c6576ff79beaa80cef0d` |
| `release-manifest.json` | `329d9f34448d69f40dc657f32889e40b144155dffd5cd2854998d585d55d7fe0` | `d89c93aae1ff7f6e07c44a5b9dc5fbbeb2a4bd6f401d03af0a270b5bfc24c70e` |
| `sbom-attestation.sigstore.json` | `d354cd5d6e2098136755b720e13865dc462937f8f88a8d2e28e168eacffe2613` | `2e6b830755f5e91d013b707551171dabc1cd960faa4132348f2b7072237c2cf7` |
| `provenance-attestation.sigstore.json` | `1585d6570d8603daed4af5d78decbedc33cf3ac7d46119bd544fcfbd7291cc08` | `7976de4a9f54d3dd8642e24d9612b112763ca51c60d5eb33f5372c19688d6763` |
| `release-manifest.sigstore.json` | `aa6aee05e89a37bdbba6ce66e93af1bbf33e1277f80be88eb9aa16a7ab83350f` | `fec44e15e016e426a7d066111e01a73a984153acf195ceaf4f0b03b15d813eae` |

- `verify-draft`（草稿验证）独立契约通过；SLSA provenance（SLSA 来源证明）、SPDX SBOM（SPDX 软件物料清单）、两类 Sigstore bundle（Sigstore 证明包）和发布清单的内部摘要均与下载文件一致。流水线中的漏洞、证明、签名和附件回读步骤全部成功。
- 最终回查确认草稿仍为 `draft=true`、`prerelease=false`、`publishedAt=null`，没有实际 `v0.1.0` Git tag（Git 标签），没有运行 `published-release.yml`，没有 `production-private` GitHub deployment（私有生产部署记录）；生产运行器 `huawei-k3s-prod-1` 在线空闲，K3s（轻量 Kubernetes）中没有应用 Deployment/Pod（工作负载 / 容器组）。

- [ ] **Step 2（步骤 2）：人工复核并 Publish `v0.1.0`**

唯一管理员再次核对：

- Release tag/source commit（发布标签 / 源提交）；
- source commit（源提交）已经包含 `published-release.yml`，且该文件只调用 `published-release-deploy.yml@main`；
- 候选镜像、索引、语料和构建身份；
- 六项证据；
- 已接受的漏洞优先级；
- `ACCESS_MODE=private`；
- 80/443 仍不公开；
- 当前维护窗口和回退动作。

Publish（正式发布）必须由管理员在 GitHub UI/API（GitHub 网页 / 应用程序接口）明确执行；工作流不得代点。

只有 Step 1（步骤 1）的整体回读完成后才能请求本步骤授权；不得只修改 `targetCommitish` 或只替换部分附件。

- [ ] **Step 3（步骤 3）：验证首次 direct deploy（直接部署）**

确认：

- 只有 Published Release（已发布版本）事件触发；
- GitHub-hosted job（GitHub 托管任务）验证和签名成功后才调度生产 runner（运行器）；
- 适配器创建固定单副本 Deployment（工作负载）；
- Deployment image（工作负载镜像）、Pod imageID（容器组镜像标识）、发布清单和授权内容摘要完全一致；
- 台账只有一条成功事件，没有遗留 `operation.json`；
- GitHub deployment（GitHub 部署记录）为 success（成功）；
- 生产 runner（运行器）日志不含请求、证明、Secret（密钥）或 kubeconfig（客户端配置）。

- [ ] **Step 4（步骤 4）：证明真实回滚草稿生命周期不部署**

首次发布和部署成功后，`v0.1.0` 才是 `rollback-candidate.yml` 可验证的真实已发布来源。经创建和删除分别授权后：

1. 只输入 `v0.1.0`，运行 `rollback-candidate.yml` 创建绑定真实已发布镜像内容摘要的 Draft Release（草稿发布版本）；
2. 编辑不参与身份的草稿正文；
3. 回读精确 Release ID（发布版本标识）和标签后删除该草稿。

创建、编辑和删除后分别确认：

- `published-release.yml` 和 `published-release-deploy.yml` 均没有运行；
- 生产运行器没有接收任务；
- 没有新增 `production-private` GitHub deployment（私有生产部署记录）；
- K3s（轻量 Kubernetes）中的应用 Deployment/Pod（工作负载 / 容器组）没有发生 rollout（滚动更新）。

Draft Release（草稿发布版本）不创建实际 Git tag（Git 标签）。删除草稿属于外部破坏性动作，执行前必须再次确认精确 Release ID（发布版本标识）和标签。不得在首发前伪造已发布来源来提前完成本步骤。

- [ ] **Step 5（步骤 5）：通过固定来源隧道完成私有验收**

80/443 保持不公开，只验证：

- live/ready（存活 / 就绪）；
- 8,410 条索引身份和零在线重建；
- `/api/check` 无模型路径；
- non-root/read-only root filesystem（非 root / 只读根文件系统）；
- CPU、内存、临时磁盘和冷启动 RSS（常驻内存）；
- observation（观测）脱敏、采样、轮转、7 天、256 MiB、人工删除和符号链接拒绝；
- 更新期间最多一个 observation writer（观测写入端）；
- 日志无 YAML、prompt、answer、Secret（配置文件 / 提示词 / 回答 / 密钥）。

Ask/Generate/Fix（询问 / 生成 / 修复）模型冒烟只使用另行批准的非敏感输入、次数和费用；不执行正式评估或索引重建。

- [ ] **Step 6（步骤 6）：演练自动恢复**

只有存在真实、可审核且不会沉淀玩具行为的故障候选时才执行生产演练。候选必须拥有完整发布证据和明确清理路径；不能为制造失败向主线落盘硬编码故障。

如果当前没有合格候选：

- 保留 fake k3s（伪 K3s）自动恢复门禁和首次生产正常路径证据；
- 把真实自动恢复演练标记为明确延期风险；
- 不用随意破坏探针、镜像或生产 Secret（密钥）冒充验收。

- [ ] **Step 7（步骤 7）：演练人工确认回滚**

只有本机成功台账中至少存在两个不同内容摘要时才有真实功能回滚目标。满足前置条件后：

1. 手工运行 `rollback-candidate.yml`，只输入历史已发布版本标签；
2. 审核生成的回滚标签、完整目标内容摘要和 provenance bundle（来源证明包）；
3. 管理员 Publish（正式发布）回滚 Release（发布版本）；
4. 适配器验证目标在成功台账后执行；
5. 验证新 GitHub deployment（GitHub 部署记录）和本机台账均把历史内容摘要记录为当前版本。

首发时只有一个成功内容摘要，不创建伪造第二版本；该演练等待第二个真实版本部署后完成。

在 Publish（正式发布）任何 `rollback-*` Release（回滚发布版本）前，必须另行授权并把现有 `v*` 标签保护等价扩展到 `refs/tags/rollback-*`：管理员是唯一创建限制绕过者，已经创建的标签禁止所有主体更新或删除。只创建和删除 Draft Release（草稿发布版本）的 Step 4（步骤 4）不依赖实际标签，因此不以提前放宽规则冒充前置条件。

- [ ] **Step 8（步骤 8）：节点重启恢复**

在单独维护窗口和备份核对后验证：

- K3s、runner（运行器）和固定应用按预期恢复；
- 适配器台账与实际镜像一致；
- observation PVC（观测持久卷声明）保留受控分段；
- GitHub/GHCR（GitHub / GitHub 容器镜像仓库）短暂不可用不影响已运行 Pod（容器组）；
- 没有因服务重启重新构建索引或重复部署。

- [ ] **Step 9（步骤 9）：更新事实状态**

只有上述已获授权的步骤完成并审核后，更新：

- `deploy/k8s/README.md` 非敏感实施证据；
- 本设计和计划状态；
- `docs/AI应用开发能力训练实现方案.md` 当前执行状态；
- `docs/README.md` 文档入口。

**Phase 3 Stop（阶段 3 停止点）：** 汇报草稿不部署、人工发布、实际镜像内容摘要、台账、runner/workflow（运行器 / 流水线）权限、私有功能和安全反例、模型调用次数/费用、RSS（常驻内存）、observation（观测）生命周期、自动恢复实际完成或延期原因，以及人工回滚是否具备两个真实版本前置条件。等待独立 review（审核）。

## 全局回滚边界

- 仓库实现异常：通过新的受控 Pull Request（合并请求）恢复已审核版本，不改写受保护历史。
- workflow（流水线）异常：先禁用生产 runner（运行器）或停止本地服务，保持 80/443 关闭；不删除发布证据或标签。
- adapter（适配器）异常：停止 runner service（运行器服务），原子恢复上一 root-owned（root 所有）版本，重新执行无参数拒绝和证明验证。
- 应用 rollout（滚动发布）异常：优先使用适配器同一请求内自动恢复；恢复失败保留操作标记并转人工。
- 功能回归：只通过新的人工发布 rollback release（回滚发布版本）选择成功台账中的历史内容摘要。
- break-glass（紧急处置）：固定来源 SSH（安全远程登录）只用于工作流/适配器不可用时恢复同一已验收内容摘要，事后补录；不开放公网 22/6443。
- Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）删除、Release（发布版本）删除、runner credential（运行器凭据）清理和 tag（标签）删除均为独立破坏性动作，不能被普通回滚步骤隐含授权。

## 最终验收门禁

- [ ] 生产适配器只有无参数固定 sudo（提权）入口。
- [ ] 两份 Sigstore（供应链签名体系）证明均使用固定信任根、身份和签发者验证。
- [ ] 原始证明包字节在 GitHub-hosted job（GitHub 托管任务）和适配器之间无重序列化漂移。
- [ ] production job（生产任务）无 checkout（检出）、Action（流水线动作）、仓库脚本、Secret（密钥）和有效仓库权限。
- [ ] 适配器不能改变固定应用镜像内容摘要以外的资源字段。
- [ ] 台账、集群和 GitHub deployment（GitHub 部署记录）的职责和漂移行为明确。
- [ ] 重跑不会重复 apply（应用）或追加成功事件。
- [ ] 首次失败、升级失败、恢复失败和崩溃均有确定行为。
- [ ] runner（运行器）账号、文件、sudoers（提权规则）和 systemd（系统服务管理器）实测符合最小权限。
- [ ] 应用不在 `default` Namespace（默认命名空间）。
- [ ] 生产运行时不重建 index（索引），不需要 PVC + Job（持久卷 + 独立任务）。
- [ ] 源码仓库仍为私有；公开前迁移私有部署仓库和注销当前 runner（运行器）的触发条件已记录。
- [ ] 80/443/6443 没有因 Phase 3（阶段 3）而公开。
- [ ] Secret（密钥）未进入仓库、镜像、参数、日志、产物或对话。
- [ ] 自动恢复和人工回滚只记录真实完成状态；没有两个真实成功版本时不伪造人工回滚验收。

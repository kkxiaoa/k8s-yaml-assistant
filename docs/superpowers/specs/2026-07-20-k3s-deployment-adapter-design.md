# K3s 特权部署适配器设计

> 状态：设计及实施计划已通过 review（审核）；Task 1-6（任务 1-6）和 Task 7（任务 7）已完成实现、真实验收或明确延期收敛。经逐项明确授权，`v0.1.1` 已通过运行 `30296287472` Attempt 1（第 1 次尝试）部署并完成 Step 5（步骤 5）的非模型验收和 1 个有限 Ask（询问）模型冒烟；人工回滚 Release（发布版本）`360812512` 随后通过运行 `30325880287` Attempt 1（第 1 次尝试）把生产切换到 `v0.1.0`，恢复 Release（发布版本）`360824879` 又通过运行 `30327301138` Attempt 1（第 1 次尝试）把生产恢复到 `v0.1.1`。重启前的新鲜数据库与服务端令牌分离备份已上传私有 OBS（对象存储服务）并核对摘要，节点重启后应用、运行器、适配器运行时目录、台账、观测分段和索引身份均按设计恢复。2026-07-28 独立审核接受 Step 5（步骤 5）的部分验收边界和 Step 6（步骤 6）的明确延期风险，Step 9（步骤 9）事实状态同步完成；两项仍保持未完成，不冒充生产实证。没有独立身份价值的 runtime-specific（运行时特有）`imageID` 门禁及夹具模拟已经清退。
> 用途：定义华为云单机 K3s（轻量 Kubernetes）中固定应用发布的 deployment adapter（部署适配器）协议、信任边界、权限、并发、回滚和测试门禁。
> 当前仓库和服务器已有固定适配器、信任根与权限配置，生产集群已有固定 bootstrap/Secret（引导配置 / 密钥）；仓库级 self-hosted runner（自托管运行器）已经注册并通过真实隔离、服务重启和节点重启验证。生产当前固定在 `v0.1.1` 镜像摘要，单副本 Deployment（工作负载）为 `1/1` 可用、Pod（容器组）重启为预期的 `1` 且没有继续增加，成功台账仍有四个事件和两个不同摘要，公网 80/443/6443 仍不可达。生产运行器在线空闲，`root:root 0700` 适配器运行时目录已在节点重启后重新创建，操作标记不存在，没有重复部署。
> 对应总计划：`docs/superpowers/plans/2026-07-19-k3s-production-deployment.md` 的 Task 12（任务 12）。独立实施计划位于 `docs/superpowers/plans/2026-07-20-k3s-deployment-adapter.md`。

## 1. 结论

当前阶段推荐一个 root-owned（root 所有）、由 Python 3（Python 运行时）标准库实现的固定适配器。适配器只接受一份有大小上限、经过签名的标准输入，请求只能表达：

- 把固定 Deployment（工作负载）部署为一个 `sha256` 镜像内容摘要；
- 把固定 Deployment（工作负载）回滚到本机验收台账中已有的一个 `sha256` 镜像内容摘要。

适配器不接受动态命令行参数、路径、URL（统一资源定位符）、镜像仓库、命名空间、资源名、清单或额外 `kubectl` 参数。目标名称、GHCR（GitHub 容器镜像仓库）地址、证明身份和本地文件位置全部固化在 root-owned（root 所有）实现中。

标签提交中的 `published-release.yml` 只接收 Published Release（已发布版本）事件，并调用受保护 `main` 中的 `published-release-deploy.yml` reusable workflow（可复用工作流）。后者的 GitHub-hosted job（GitHub 托管任务）验证发布版本、标签、源码提交、发布清单和构建证明，再生成一份新的 deployment authorization（部署授权）并使用固定部署工作流身份进行 Cosign（签名工具）无密钥签名。production runner job（生产运行器任务）不检出代码、不运行 Action（流水线动作）、不下载文件且不持有有效的 `GITHUB_TOKEN` 权限，只把签名请求送入适配器。

适配器跨越 GitHub-hosted runner（GitHub 托管运行器）与生产节点两个独立信任边界，因此在生产节点重新验证：

1. deployment authorization（部署授权）的签名、工作流身份和 `release` 触发器；
2. 候选镜像 SLSA provenance（SLSA 来源证明）的签名、构建工作流身份、主体内容摘要、源码提交和 BuildKit（Docker 构建后端）构建类型；
3. 请求动作、镜像名称和内容摘要与两份证明完全一致；
4. deploy（部署）请求未倒退到旧发布，rollback（回滚）目标已存在于本机成功台账。

验证通过后，适配器只使用固定模板和固定 `k3s kubectl` 子命令变更一个 Deployment（工作负载）。任何证明、状态、并发、超时或就绪检查失败都 fail-closed（失败关闭）。

## 2. 已核对事实

### 2.1 仓库与已发布版本

| 核对项 | 当前事实 |
| --- | --- |
| 仓库 | 个人私有仓库 `kkxiaoa/k8s-yaml-assistant`，默认分支 `main` |
| 已发布应用源码 | `ac9eb22100e300e8b3babd3bdc26ad8e45ea169d` |
| 当前适配器源码 | `d40700ac34ca264df863316710b60275fff759bd` |
| 应用镜像 | `ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37` |
| 平台 | `linux/amd64` |
| Release（发布版本） | `v0.1.1`，Release ID（发布版本标识）`360575653`，已于 `2026-07-27T18:59:54Z` Publish（正式发布）并创建不可变 Git tag（Git 标签） |
| 发布证据 | 六项附件存在，发布清单 schema（模式）版本为 2 |
| 证明提供者 | `sigstore-cosign` |
| 构建证明身份 | `https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main` |
| OIDC issuer（开放身份连接签发者） | `https://token.actions.githubusercontent.com` |
| 当前生产内容摘要 | `sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37` |

当前实际附件大小为：

| 文件 | 字节数 | 适配器是否需要 |
| --- | ---: | --- |
| `provenance-attestation.sigstore.json` | 25,977 | 是 |
| `provenance.slsa.json` | 14,677 | 否；同一 predicate（断言）已在证明包的 DSSE envelope（签名信封）中 |
| `release-manifest.json` | 3,819 | GitHub 托管验证任务需要，适配器不重复接收 |
| `release-manifest.sigstore.json` | 10,756 | GitHub 托管验证任务需要，适配器不重复接收 |
| `sbom-attestation.sigstore.json` | 1,480,492 | 否；不把与部署授权无关的大文件交给生产节点 |
| `sbom.spdx.json` | 1,102,121 | 否 |

现有来源证明包为 Sigstore bundle v0.3（Sigstore 证明包版本 0.3），包含 `dsseEnvelope` 和 `verificationMaterial`。其受签名内容实际绑定：

- 主体 `ghcr.io/kkxiaoa/k8s-yaml-assistant` 及镜像 SHA-256（安全哈希算法）；
- `https://slsa.dev/provenance/v1`；
- BuildKit SLSA v1（BuildKit 供应链来源证明版本 1）构建类型；
- Dockerfile 的 `runtime` 目标；
- 固定索引产物内容摘要；
- Git 源地址和精确源码提交。

### 2.2 GitHub（代码托管平台）边界

2026-07-27 通过官方 API（应用程序接口）回读并在 Task 5（任务 5）注册后复核：

- repository-level runner（仓库级运行器）为唯一 `huawei-k3s-prod-1`，固定标签包含 `k8s-yaml-assistant-prod`；当前服务运行且状态为在线空闲；
- 仓库默认 `GITHUB_TOKEN` 权限为只读；
- 当前只有 `index-build` Environment（索引构建环境）；
- 仓库属于个人账号，不能使用 organization runner group（组织运行器组）把运行器限制到单一工作流；
- `v*` 标签创建和不可变规则已经启用。

GitHub 的 label（标签）只负责把任务路由到匹配运行器，不是授权边界。个人仓库中的任意已进入默认分支的工作流都可能请求同一 repository-level runner（仓库级运行器），因此适配器不能只根据 `runs-on`、工作流文件名或 runner label（运行器标签）信任请求。

### 2.3 K3s 与服务器

2026-07-27 通过已恢复的 SSH（安全远程登录）入口完成 Task 4（任务 4）实时 preflight（前置核对）和创建后回读：

| 核对项 | 实时事实 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.4 LTS，内核 `6.8.0-136-generic` |
| CPU 架构 | `x86_64`，对应发布平台 `linux/amd64` |
| K3s | `v1.36.2+k3s1` |
| Kubernetes（容器编排系统） | `v1.36.2` |
| K3s 服务 | `active`，`k3s.service` 为 `enabled` |
| 拓扑 | 单节点、SQLite（嵌入式数据库）、非高可用 |
| 应用 Namespace（命名空间） | `k8s-yaml-assistant-prod` 已创建并为 `Active`，Pod Security（容器组安全）固定 `restricted:v1.36` |
| 固定 bootstrap（引导配置） | ServiceAccount、ConfigMap、ClusterIP Service、PVC 和 NetworkPolicy（服务账户 / 普通配置 / 集群内服务 / 持久卷声明 / 网络策略）已创建 |
| 运行时 Secret（密钥） | `deepseek-runtime`、`voyage-runtime`、`ghcr-pull` 已按职责创建；值未回读 |
| 应用 Deployment（工作负载） | 固定单副本，镜像为已发布 OCI Image Index root digest（开放容器镜像索引根摘要），当前 `1/1` 可用 |
| 生产 runner（运行器） | 固定 UID/GID `996/988` 的 Linux 账号、同名组和 GitHub runner service（GitHub 运行器服务）已创建；运行器已注册，服务为 `active/enabled`（运行中 / 开机自启），GitHub 状态为在线空闲 |
| kubeconfig（客户端配置） | `/etc/rancher/k3s/k3s.yaml`，`root:root 0600` |
| Python（Python 运行时） | `3.12.3` |
| sudo（提权工具） | `1.9.15p5`，`visudo` 位于 `/usr/sbin/visudo` |
| systemd（系统服务管理器） | `255`，`systemd-analyze` 可用 |
| 基础验证工具 | `jq`、`flock`、`timeout`、`sha256sum`、`openssl`、`curl`、`base64`、`install` 和 `getent` 均可用 |
| 需独立安装的工具 | Cosign `v3.1.2`（签名工具版本 3.1.2）已按固定摘要安装 |
| 不作为依赖的工具 | GitHub CLI（GitHub 命令行工具）和 Node.js（Node.js 运行时）均未安装 |
| 适配器固定路径 | 入口、配置目录、状态目录和 root-only（仅 root）运行时目录已按固定权限安装 |

回读没有输出 kubeconfig（客户端配置）内容、Secret（密钥）值或凭据。Task 4（任务 4）只创建固定 bootstrap/Secret（引导配置 / 密钥）；Task 5（任务 5）按固定版本和摘要安装适配器、Cosign（签名工具）与生产 runner（运行器）并完成注册。修正配置已经通过真实 tmpfs（内存文件系统）容量、所有权、写入和服务重启验证。Task 7 Step 3（任务 7 步骤 3）的运行 `30265452918/5` 已创建固定 Deployment（工作负载），GitHub deployment（GitHub 部署记录）`5624354635` 为 `success`，应用 `1/1` 可用且 Pod（容器组）零重启；公网端口仍未开放。

## 3. 目标与非目标

### 3.1 目标

1. 让生产运行器只能请求固定应用的 deploy（部署）或 rollback（回滚）。
2. 让生产节点独立证明镜像来自固定发布构建工作流，且本次变更经过 Published Release（已发布版本）工作流重新授权。
3. 不让生产运行器获得 kubeconfig（客户端配置）、模型 Secret（密钥）、SSH 私钥、Docker socket（Docker 套接字）或镜像仓库推送凭据。
4. 对重复请求、并发请求、中途崩溃、就绪失败和回滚失败给出确定且可审计的行为。
5. 让全部破坏性边界可由隔离 fake adapter（伪适配器）和 fixture（夹具）验证，不用生产集群试错。

### 3.2 非目标

- 不实现通用 Kubernetes（容器编排系统）部署工具、GitOps（拉取式部署管理）控制器或任意清单执行器。
- 不接受 Namespace、Deployment、container、registry 或 repository（命名空间 / 工作负载 / 容器 / 镜像仓库 / 仓库）作为调用参数。
- 不管理 Secret、ConfigMap、Service、Ingress、PVC 或 NetworkPolicy（密钥 / 普通配置 / 服务 / 入口 / 持久卷声明 / 网络策略）。
- 不实现 `set-access-mode`，该动作必须等待 Phase 4（阶段 4）审核。
- 不提供任意历史镜像选择；rollback（回滚）只能指向本机成功台账中的内容摘要。
- 不在生产节点重新下载 GitHub Release（GitHub 发布版本）附件，不在生产运行器执行 `gh`、`curl`、`docker`、`npm` 或仓库脚本。
- 不借本设计创建应用资源、注册运行器、正式发布或调用模型。

## 4. 固定部署身份

本阶段固定以下名称，Task 13（任务 13）的 Kubernetes（容器编排系统）清单、适配器常量和契约测试必须使用同一组值：

| 类别 | 固定值 |
| --- | --- |
| GHCR 应用镜像 | `ghcr.io/kkxiaoa/k8s-yaml-assistant` |
| Namespace | `k8s-yaml-assistant-prod` |
| Deployment | `k8s-yaml-assistant` |
| container | `app` |
| Service | `k8s-yaml-assistant` |
| ServiceAccount | `k8s-yaml-assistant` |
| ConfigMap | `k8s-yaml-assistant` |
| observation PVC（观测持久卷声明） | `k8s-yaml-assistant-observation` |
| imagePullSecret（镜像拉取密钥） | `ghcr-pull` |
| Linux runner account（Linux 运行器账号） | `gha-k8s-yaml-prod` |
| GitHub runner name（GitHub 运行器名称） | `huawei-k3s-prod-1` |
| 适配器入口 | `/usr/local/sbin/k8s-yaml-assistant-deploy` |
| 固定 Deployment 模板 | `/etc/k8s-yaml-assistant-deployer/deployment-template.yaml` |
| Sigstore trusted root（Sigstore 信任根） | `/etc/k8s-yaml-assistant-deployer/sigstore-trusted-root.json` |
| 状态目录 | `/var/lib/k8s-yaml-assistant-deployer` |
| 运行时临时目录 | `/run/k8s-yaml-assistant-deployer` |

应用不使用 `default` Namespace（默认命名空间）。适配器不通过运行时配置切换这些值；改变任一身份都需要代码、清单、测试和文档共同审核。

## 5. 请求协议

### 5.1 逻辑协议与实际传输

总计划中的：

```text
deploy sha256:<64-hex> <bounded-provenance-bundle>
rollback sha256:<64-hex> <bounded-provenance-bundle>
```

定义的是逻辑字段，不直接映射为动态 `sudo` 参数。若把动作和内容摘要放入 `sudoers` wildcard（提权规则通配符）或 shell command interpolation（命令插值），会扩大参数注入面。

实际调用固定为无参数命令：

```bash
sudo -n /usr/local/sbin/k8s-yaml-assistant-deploy
```

调用方通过标准输入传入一个不超过 64 KiB 的 UTF-8 JSON（JSON 文本）对象。适配器读取第 65,537 个字节用于检测超限；超限、空输入、非法 UTF-8、重复键、非对象顶层或未知字段均失败。标准输入之外不读取调用方路径。

`sudoers`（提权规则）只允许生产运行器账号执行上述无参数命令；带任何参数、环境变量赋值、替代可执行路径或其他 root 命令都必须被拒绝。具体语法在实施计划中依据服务器实际 sudo（提权工具）版本编写，并通过 `visudo -c`、允许用例和拒绝用例验证，不使用 `*`。

### 5.2 外层请求

```json
{
  "schemaVersion": 1,
  "authorization": "<canonical deployment authorization JSON>",
  "authorizationBundle": "<raw Sigstore bundle JSON>",
  "provenanceBundle": "<raw Sigstore bundle JSON>"
}
```

- `authorization` 是待验证的原始 JSON 字节对应字符串；不得在验证签名前重新序列化。
- `authorizationBundle` 是该原始字节对应的 Sigstore bundle v0.3（Sigstore 证明包版本 0.3）原文字符串。
- `provenanceBundle` 是候选镜像已有 `provenance-attestation.sigstore.json` 的原文字符串。
- 两份 bundle（证明包）都以字符串传递，解析外层请求后必须恢复出与来源文件完全相同的 UTF-8 字节；不得把 JSON（JSON 文本）对象重新序列化后用于验证或计算摘要。
- 外层 `schemaVersion` 只负责请求封装版本，不复制内部身份。
- GitHub 托管验证边界按外层 JSON string encoding（JSON 字符串编码）后的实际占用，分别限制 `authorization` 为 2 KiB、`authorizationBundle` 为 28 KiB、`provenanceBundle` 为 32 KiB；三项与对象结构合计仍必须小于等于 64 KiB。该分配为外层结构保留余量，并让任一证明包超限时在调度生产运行器前失败。

GitHub 托管验证任务将该对象进行标准 Base64（Base64 编码）后作为 job output（任务输出）传给生产任务，并在编码前后按 64 KiB 原文上限严格校验。生产任务只做固定的 Base64（Base64 编码）解码并通过管道写入 `sudo`，不把数据拼入命令文本，不落盘。适配器结果是另一条独立边界：只允许一行、不超过 4 KiB 的非敏感 JSON（JSON 文本）；结果为空、多行、超限或编码非法时，本次生产任务和 GitHub deployment（GitHub 部署记录）均按失败处理。

### 5.3 受签名 deployment authorization（部署授权）

`authorization` 严格包含：

```text
schemaVersion
action
repository
releaseId
releaseTag
sourceCommit
publishedAt
imageName
imageDigest
provenanceBundleSha256
workflowRunId
workflowRunAttempt
```

字段消费者如下：

| 字段 | 直接消费者 |
| --- | --- |
| `schemaVersion` | 适配器选择唯一严格 decoder（解码器）；未知版本失败 |
| `action` | 选择 deploy（部署）或 rollback（回滚）状态机 |
| `repository` | 固定为 `kkxiaoa/k8s-yaml-assistant` |
| `releaseId` | 幂等、冲突和审计关联；使用十进制字符串避免跨运行时整数精度差异 |
| `releaseTag` | 区分应用发布与受控回滚发布并写入台账 |
| `sourceCommit` | 与来源证明中的 VCS revision（版本控制提交）比较 |
| `publishedAt` | 拒绝旧 deploy（部署）授权重放 |
| `imageName` | 固定 GHCR（GitHub 容器镜像仓库）名称 |
| `imageDigest` | 目标镜像、来源证明主体和台账身份 |
| `provenanceBundleSha256` | 把授权与本次携带的来源证明包绑定 |
| `workflowRunId` / `workflowRunAttempt` | GitHub 运行、生产日志和台账关联；使用十进制字符串避免跨运行时整数精度差异 |

没有直接消费者的 Release body（发布正文）、PR ID（合并请求标识）、SBOM（软件物料清单）、漏洞表、当前生产内容摘要或任意 URL（统一资源定位符）不进入协议。

## 6. 信任链

### 6.1 为什么构建来源证明不等于部署授权

现有 SLSA provenance（SLSA 来源证明）只能证明镜像由固定 `release-artifacts.yml` 构建，不能证明管理员已经点击 Publish（正式发布）。如果适配器只验证该证明，个人仓库中另一个工作流可以重放尚处于草稿阶段的有效候选，从而绕过人工发布门禁。

因此 Published Release（已发布版本）验证任务必须在 GitHub-hosted runner（GitHub 托管运行器）完成全部发布身份检查后，生成并签名 deployment authorization（部署授权）。该授权的证书身份固定为：

```text
https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/published-release-deploy.yml@refs/heads/main
```

OIDC issuer（开放身份连接签发者）固定为：

```text
https://token.actions.githubusercontent.com
```

GitHub（代码托管平台）从 release event（发布事件）关联的标签提交读取触发工作流，因此该提交必须包含 `published-release.yml`。触发文件没有普通步骤，只以 `@main` 调用 `published-release-deploy.yml`；GitHub OIDC（开放身份连接）的 `job_workflow_ref`（任务工作流引用）由被调用工作流和 `refs/heads/main` 组成，从而与上述固定证书身份一致。被调用工作流只提供 `workflow_call`（复用调用），但必须再次检查调用方 `event_name=release`、`event.action=published`、标签 ref（引用）、标签提交、唯一管理员和发布证据；其他事件即使调用它也会在签名前失败。

Cosign（签名工具）验证还必须检查 GitHub workflow trigger（GitHub 工作流触发器）为 `release`。触发工作流不提供 `workflow_dispatch`、`push` 或 `pull_request` 入口，被调用部署工作流不提供除 `workflow_call` 外的入口。

### 6.2 生产节点验证顺序

适配器按固定顺序执行，前一步失败时不运行后一步：

1. 严格解码外层请求并对恢复出的 `provenanceBundle` UTF-8 原始字节计算 SHA-256（安全哈希算法）。
2. 把三个受限对象写入 `/run/k8s-yaml-assistant-deployer` 下随机、root-only（仅 root）临时目录；禁止符号链接，退出时清理。
3. 使用固定路径 Cosign（签名工具）和本地 trusted root（信任根）验证 `authorization` 的 blob signature（文件签名）、部署工作流身份、OIDC issuer（开放身份连接签发者）和 `release` 触发器。
4. 严格解码已验证的 `authorization`；检查动作、仓库、镜像名称、内容摘要、来源证明包哈希和字段上限。
5. 使用 `cosign verify-blob-attestation`、固定构建工作流身份、固定 OIDC issuer（开放身份连接签发者）、`slsaprovenance1` predicate type（断言类型）和请求镜像摘要验证来源证明包，不访问镜像仓库。
6. 解码已验证 DSSE payload（DSSE 负载），检查：
   - `_type` 为当前实际的 `https://in-toto.io/Statement/v0.1`；
   - 主体只有固定镜像名称和同一 SHA-256（安全哈希算法）；
   - `predicateType` 为 `https://slsa.dev/provenance/v1`；
   - BuildKit（Docker 构建后端）构建类型与当前发布契约一致；
   - Dockerfile 目标为 `runtime`；
   - VCS source/revision（版本控制来源 / 提交）与固定仓库和 `sourceCommit` 一致。
7. 检查本机台账、集群当前镜像和请求的重放/回滚资格。
8. 只有全部通过才调用 `k3s kubectl`。

生产节点不安装或调用 `gh`，不读取 GitHub Release API（GitHub 发布接口），不持有 GitHub PAT（GitHub 个人访问令牌）或 GHCR pull token（GHCR 拉取令牌）。Sigstore trust root（Sigstore 信任根）、Cosign（签名工具）和其摘要在实施计划中固定版本；验证过程不以在线获取新信任根替代已审核输入。

## 7. 实现选择

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| shell script（命令行脚本） | 不选 | root 上下文中的 JSON（JSON 文本）、二进制上限、原子状态和超时处理容易形成引用与错误传播缺陷 |
| TypeScript/Node.js（TypeScript / Node.js 运行时） | 不选 | 服务器应用运行镜像之外没有已审核的 Node.js 运行时；不能借用 GitHub runner（GitHub 运行器）内置运行时 |
| Go binary（Go 二进制） | 暂不选 | 会为单个固定适配器新增工具链、模块和二进制交付链；当前没有复用证据 |
| Python 3 标准库 | 推荐 | 服务器已确认 Python 3.12.3，具备严格 JSON（JSON 文本）、`fcntl` 文件锁、原子文件和无 shell 子进程能力，不引入第三方包 |

Python（Python 运行时）实现必须：

- 使用绝对解释器路径和 isolated mode（隔离模式），忽略 `PYTHONPATH`、`PYTHONHOME` 和用户 site package（用户扩展包）；
- 只导入标准库；
- 所有子进程使用参数数组、绝对可执行路径、固定环境和 `shell=False`；
- 不从当前工作目录、生产运行器工作目录或输入指定路径导入代码；
- 不向日志输出请求正文、证明内容、命令完整 stderr（标准错误）或环境变量；
- 不提供 plugin（插件）、hook（钩子）、配置覆盖、调试执行或通用命令接口。

若 Task 13（任务 13）的实施前核对发现 Python 3（Python 运行时）不再是已审核的 3.12 系列或缺少所需标准库能力，必须停止重新 review（审核），不能临时改用 shell script（命令行脚本）。

## 8. Kubernetes（容器编排系统）变更协议

### 8.1 固定模板

Task 13（任务 13）把经过契约测试的 Deployment（工作负载）模板安装为 root-owned（root 所有）只读文件。模板只包含一个唯一镜像标记；适配器要求该标记恰好出现一次，然后替换为：

```text
ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:<64-hex>
```

适配器不实现通用模板引擎。Namespace、Deployment、container、探针、资源、卷、安全上下文和更新策略不能由请求改变。

### 8.2 固定命令面

适配器只允许内部调用以下能力，实际参数全部由常量或已验证内容摘要形成：

1. 读取固定 Deployment（工作负载）的 JSON（JSON 文本）状态；
2. 通过标准输入对固定模板执行 server-side apply（服务端应用）；
3. 等待固定 Deployment（工作负载） rollout status（滚动发布状态）；
4. 读取固定 label selector（标签选择器）的 Pod spec/status（容器组声明 / 状态）；
5. 在首次部署失败且本次调用确实新建 Deployment（工作负载）时删除该固定 Deployment；
6. 在已有版本更新失败时用同一模板恢复上一个台账内容摘要。

不使用 `--force-conflicts`。若资源由其他 field manager（字段管理者）改动并产生冲突，适配器失败并等待人工审核，不覆盖未知变更。

### 8.3 成功条件

只有同时满足以下条件才写入成功台账：

- Deployment（工作负载）已观察到最新 generation（代次）；
- 副本数、可用副本和就绪副本均为 1；
- 只有一个匹配 Pod（容器组）处于 Ready（就绪）；
- Deployment（工作负载）镜像引用严格等于固定镜像加请求摘要；
- Pod spec image（容器组声明镜像）严格等于固定镜像加请求摘要；
- 本轮没有遗留未完成操作标记。

授权和发布清单绑定的是 OCI Image Index root digest（开放容器镜像索引根摘要）。适配器通过 Deployment/Pod 声明镜像绑定已签名根摘要，containerd（容器运行时）再按内容寻址校验并解析节点平台镜像。CRI `imageID`（容器运行时接口镜像标识）只表达运行时内部配置摘要，不能独立证明它对应授权根摘要；节点失陷时，该字段也与其他 Pod status（容器组状态）处于同一不可信边界。因此适配器不读取或解析 `imageID`，不把可从镜像索引派生的配置摘要加入发布协议。

## 9. 并发、幂等与状态

### 9.1 双层串行化

- GitHub workflow（GitHub 工作流）使用固定 production deployment concurrency group（生产部署并发组），`cancel-in-progress=false`；
- rollback candidate workflow（回滚候选工作流）使用固定 `rollback-candidate` concurrency group（回滚候选并发组），`cancel-in-progress=false`，避免并发人工触发同时创建多个活动草稿；
- 适配器使用 `/run` 下 root-owned（root 所有）文件和 `fcntl.flock` 独占锁。

锁文件存在不表示锁仍被持有。进程退出后内核释放锁，后续调用可以复用同一文件；不得通过删除 PID 文件处理所谓 stale lock（遗留锁）。锁已被其他进程持有时立即返回 `busy`，不排队执行第二次生产变更。

### 9.2 台账

唯一持久状态为：

```text
/var/lib/k8s-yaml-assistant-deployer/ledger.json
/var/lib/k8s-yaml-assistant-deployer/operation.json
```

`ledger.json` 是上限 1 MiB 的严格 JSON（JSON 文本），只保存成功事件数组。`operation.json` 上限为 16 KiB。当前生产内容摘要由最后一条成功事件推导，不保存重复的 `currentDigest` 字段。每条事件只保存：

```text
action
releaseId
releaseTag
sourceCommit
publishedAt
imageDigest
workflowRunId
workflowRunAttempt
deployedAt
```

`operation.json` 是跨崩溃门禁。适配器在首次 Kubernetes（容器编排系统）写入前原子创建；成功、或失败后确认已经恢复原状态时才删除。进程退出后仍存在该文件时，下一次请求返回 `recovery_required`，不自动猜测集群状态或删除标记。

操作标记只保存 `startedAt/action/releaseId/sourceCommit/previousDigest/targetDigest/workflowRunId`，不保存 authorization（部署授权）、证明包或命令输出。`previousDigest` 在这里是跨崩溃恢复所需快照，与可由成功台账推导的稳定状态职责不同。

两份文件都使用同目录临时文件、`fsync`、原子 rename（重命名）和目录 `fsync` 更新；禁止符号链接和非普通文件。日志不是台账事实源。

### 9.3 幂等与重放

- 同一 `releaseId + action + imageDigest + sourceCommit` 已成功且集群状态一致时返回成功，不因 workflow run/attempt（流水线运行 / 尝试次数）变化再次 apply（应用）或追加重复成功事件；本次 run/attempt（运行 / 尝试次数）只进入调用日志。
- 同一 `releaseId` 对应不同动作、内容摘要或源码提交时失败。
- 新 deploy（部署）的 `publishedAt` 必须晚于当前成功事件；旧授权不能把生产回退到历史版本。
- rollback（回滚）目标必须至少出现在一条历史成功事件中，且本次 rollback（回滚）授权本身必须来自新的 Published Release（已发布版本）事件。
- 台账和实际集群内容摘要不一致时返回 `state_drift`，不把任一方静默覆盖为事实源。

### 9.4 GitHub deployment（GitHub 部署记录）镜像

适配器成功台账是生产内容摘要和回滚资格的权威事实源。GitHub-hosted finalizer（GitHub 托管收尾任务）只把适配器返回的非敏感结果写为 `production-private` 环境的 deployment status（部署状态），供发布审核和下一候选发布读取。

下一候选发布从最新成功 deployment record（部署记录）解析 `currentProductionDigest`；没有成功记录时为 `none`。这替代需要人工同步、容易漂移的 `CURRENT_PRODUCTION_DIGEST` repository variable（当前生产内容摘要仓库变量），不引入新的写权限 Secret（密钥）。GitHub 记录损坏、缺失或与本机台账不一致时停止发布审核；适配器不能用 GitHub 记录增加回滚资格或覆盖本机状态。

## 10. 失败与回滚

### 10.1 更新失败

已有生产版本时：

1. 保留 `operation.json`；
2. 用上一个成功内容摘要重新应用固定模板；
3. 等待并验证上一版本恢复；
4. 恢复成功后删除操作标记，返回 `apply_failed_rolled_back`；
5. 恢复失败时保留操作标记，返回 `rollback_failed`，停止自动操作。

首次部署失败时没有历史内容摘要。适配器只在确认 Deployment（工作负载）由本次调用首次创建后删除该固定资源并验证其消失；不会删除 Namespace、Secret、PVC 或其他 bootstrap resource（引导资源）。

### 10.2 超时

候选值如下，实施计划必须用隔离测试验证后固定：

| 操作 | 候选上限 |
| --- | ---: |
| 单次 Cosign（签名工具）验证 | 30 秒 |
| 单次 `kubectl get/apply/delete` | 30 秒 |
| rollout status（滚动发布状态） | 10 分钟 |
| 自动恢复 rollout（滚动发布） | 10 分钟 |
| GitHub production job（生产任务） | 30 分钟 |

子进程超时后必须终止整个进程组并等待退出，不能留下后台 `kubectl`。候选发布和自动恢复分别拥有独立超时；不能因为候选已消耗 10 分钟而跳过恢复。

真实 GHCR（GitHub 容器镜像仓库）冷拉取中，最慢 45.5 MB 层按稳定约 1.05 MB/分钟预计需要约 43 分钟，说明该公网路径不满足生产分发要求。不得用继续扩大上述超时掩盖分发问题；同区域镜像仓库方案审核完成前不再重试生产部署。

## 11. 权限与运行器边界

### 11.1 production runner job（生产运行器任务）

生产任务必须：

- 使用 repository-level self-hosted runner（仓库级自托管运行器）；
- 显式设置空 `permissions`（权限），不把 `GITHUB_TOKEN` 注入命令环境；
- 不使用 checkout（检出）、第三方 Action（流水线动作）、容器 Action（容器流水线动作）或 service container（服务容器）；
- 不执行仓库文件；
- 不调用网络下载工具；
- 只执行固定 Base64（Base64 编码）解码和无参数 `sudo` 命令；
- 设置 30 分钟任务超时；
- 工作流脚本和适配器不主动输出请求、证明或完整命令环境。GitHub Actions（GitHub 自动化流水线）会把普通 step env（步骤环境变量）渲染到受仓库权限控制的运行日志；跨 job（任务）使用 `add-mask`（日志遮罩）会使该值不能继续作为 output（输出）传递。因此跨任务请求只允许包含已发布证明和非敏感发布身份，不得包含 Secret、kubeconfig、用户 YAML 或模型输入（密钥 / 客户端配置 / 配置文件 / 模型输入）。若未来请求出现敏感字段，必须先引入受审核的外部 secret store（密钥存储）句柄传递，不能继续使用当前明文任务输出。

GitHub deployment（GitHub 部署记录）的创建和最终状态更新放在前后两个 GitHub-hosted job（GitHub 托管任务），不为记录状态向生产运行器发放 `deployments:write`。

### 11.2 Linux 账号与文件

`gha-k8s-yaml-prod`：

- 是无密码、无交互 shell（命令行环境）的独立系统账号；
- 不属于 `docker`、`k3s`、`sudo` 或其他管理组；
- 不能读取 `/root`、`/etc/rancher/k3s`、模型 Secret（密钥）或适配器状态；
- 只对适配器无参数入口拥有一条 `NOPASSWD`（免密码）规则；
- runner credential（运行器凭据）只对该账号可读，不写入仓库、日志或对话；
- 注销时先在 GitHub（代码托管平台）删除运行器，再停止服务并清理凭据。

适配器、模板、Cosign（签名工具）和 trusted root（信任根）均为 `root:root`，生产运行器不可写。适配器使用 K3s（轻量 Kubernetes）现有 root-only admin kubeconfig（仅 root 管理客户端配置），不复制第二份长期 Kubernetes（容器编排系统）凭据。该选择接受“适配器进程具有集群管理员能力”的明确风险，以固定代码、零动态参数、双证明、最小 `sudoers`（提权规则）和隔离测试收敛调用面；若该风险不可接受，必须另行设计专用身份与创建资源的准入约束，不能只创建一个可在命名空间内任意创建工作负载的宽权限 token（令牌）。

### 11.3 systemd（系统服务管理器）

GitHub runner（GitHub 运行器）固定版本安装后禁用自动更新，二进制为 root-owned（root 所有）；仅配置、诊断和工作目录按运行所需授予 runner account（运行器账号）权限。GitHub 要求禁用自动更新的运行器在新版本发布后 30 天内升级，实施计划必须定义版本检查、停服升级和过期下线，不能长期冻结。

候选 systemd hardening（systemd 加固）至少包括：

- `UMask=0077`；
- `ProtectSystem=strict`；
- `ProtectHome=true`；
- `PrivateTmp=true`；
- `PrivateDevices=true`；
- `ProtectKernelTunables=true`；
- `ProtectKernelModules=true`；
- `ProtectControlGroups=true`；
- `ProtectClock=true`；
- `ProtectHostname=true`；
- `LockPersonality=true`；
- `RestrictRealtime=true`；
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`；
- `IPAddressDeny=169.254.0.0/16`，拒绝实例 metadata service（元数据服务）；
- `ReadWritePaths` 只包含适配器状态和运行时目录；runner（运行器）工作、诊断目录只能由有界 `TemporaryFileSystem`（临时文件系统）提供；
- 有界 `MemoryMax`、`CPUQuota` 和 `TasksMax`。

由于生产 runner（运行器）必须调用唯一 `sudo` 入口，本服务不能使用会阻止该提权路径的 `NoNewPrivileges=true`。也不能在未验证 runner（运行器）和 Cosign（签名工具）系统调用前盲目增加 `SystemCallFilter` 或 `MemoryDenyWriteExecute`。实施时先用 `systemd-analyze security` 和真实空任务验证候选项；需要放宽时逐项说明消费者，不退化为无约束服务。

生产任务不检出仓库或下载附件，runner（运行器）工作目录和诊断目录应分别使用候选 128 MiB 与 32 MiB 的 service-private tmpfs（服务私有内存文件系统），或经审核的等价硬上限，避免仓库级运行器被滥用后占满 180 GiB 系统盘。该候选必须连同 `MemoryMax` 实测；不能同时承诺互相矛盾的内存上限。若 GitHub runner（GitHub 运行器）要求整个安装目录可写、无法把二进制与有界运行状态分离，停止并重新 review（审核），不得把 `/opt` 或 `/var/lib` 整体交给运行器账号。

当前 systemd 255（系统服务管理器版本 255）会为不同执行阶段重建服务私有挂载，`ExecStartPre`（启动前命令）不能持久修改后续 tmpfs（内存文件系统）的所有者。实现因此固定专用账号 UID/GID（用户 / 组数字标识）为 `996/988`，由 tmpfs 挂载选项直接指定所有者；灾难恢复时必须先验证数字标识没有冲突，不能动态分配后继续使用旧配置。

`/run/k8s-yaml-assistant-deployer` 在节点重启后不存在，必须由 root-owned（root 所有）的 `tmpfiles.d`（临时目录创建规则）以 `root:root 0700` 重新创建。不能使用会把所有权交给服务账号的 `RuntimeDirectory`（运行时目录），不能把 `/run` 整体设为可写，也不能让 runner account（运行器账号）拥有适配器运行时目录。工作和诊断目录不得同时出现在 `TemporaryFileSystem` 与 `ReadWritePaths`：后者的绑定挂载会遮蔽前者的容量上限。2026-07-28 的授权节点重启已验证该目录按固定规则和权限自动恢复。

## 12. 日志

适配器只输出一个有大小上限的结果 JSON（JSON 文本），供后续 GitHub 托管记录任务消费；同时向 journald（系统日志）记录相同的非敏感摘要。字段限制为：

```text
event
action
releaseId
releaseTag
sourceCommit
workflowRunId
workflowRunAttempt
previousDigest
targetDigest
result
failureCode
durationMs
```

`previousDigest` 是本次操作开始时从成功台账推导的诊断字段，不写回台账。失败只记录稳定 `failureCode`，不原样记录 JSON（JSON 文本）解析错误、Cosign（签名工具）输出、`kubectl describe`、环境变量、证明、发布正文或 Kubernetes Secret（Kubernetes 密钥）。

明确的故障码至少包括：

```text
invalid_request
request_too_large
authorization_invalid
provenance_invalid
identity_mismatch
replay_rejected
rollback_not_accepted
busy
recovery_required
state_drift
apply_failed_rolled_back
rollback_failed
verification_failed
internal_error
```

## 13. 反例优先测试矩阵

Task 13（任务 13）必须先写失败测试，再实现生产代码。测试使用 Python（Python 运行时）标准库临时目录、fake cosign（伪签名工具）和 fake kubectl（伪 Kubernetes 命令行工具）；生产集群不承担故障注入。

| 类别 | 必须先失败的反例 |
| --- | --- |
| 输入 | 空输入、超过 64 KiB、任一授权或证明分项预算超限、非法 UTF-8、重复键、未知字段、错误 schema（模式）版本、额外命令行参数 |
| 参数注入 | 内容摘要含空格/换行/命令字符，请求出现路径、URL（统一资源定位符）、清单或额外 `kubectl` 参数 |
| 部署授权 | 签名缺失、bundle（证明包）篡改、错误工作流身份、错误 OIDC issuer（开放身份连接签发者）、非 `release` 触发器 |
| 来源证明 | 错误主体、错误 digest（内容摘要）、错误镜像仓库、错误源码提交、错误 BuildKit（Docker 构建后端）类型、错误 Dockerfile 目标 |
| 状态 | 台账损坏、超限、符号链接、权限错误、集群与台账漂移、遗留 `operation.json` |
| 并发 | 第二次调用遇到持有中的锁；锁文件仍存在但没有进程持锁时可以继续 |
| 幂等 | 完全相同请求不产生 Kubernetes（容器编排系统）写入；同一发布标识不同摘要失败 |
| 重放 | 旧 deploy（部署）授权不能把当前版本退回；未记录内容摘要不能 rollback（回滚） |
| 超时 | Cosign（签名工具）、apply（应用）、rollout（滚动发布）分别超时且没有后台进程 |
| 部分失败 | 首次部署失败删除本轮固定 Deployment（工作负载）；升级失败恢复上一摘要；恢复失败保留操作标记 |
| 就绪 | generation（代次）、副本、Pod Ready（容器组就绪）或 Deployment/Pod 声明镜像引用任一不符时，都不写成功台账 |
| 日志 | 输入包含伪 Secret（密钥）、YAML（配置文件）和长错误体时，stdout（标准输出）与 journald（系统日志）均不出现原文 |
| sudoers（提权规则） | 只允许无参数固定入口；带参数、环境赋值、替代路径和其他命令均拒绝 |
| runner offline（运行器离线） | 已发布任务只排队，不触发其他 runner（运行器）或服务器变更；恢复在线后仍需同一证明验证 |

真实系统验收只验证已经通过隔离测试的正常路径、固定拒绝路径和权限，不通过生产集群制造任意命令、证明篡改或回滚失败。

## 14. 安装、升级与撤销边界

本设计审核通过后的实施计划必须分别固定：

- Python 3（Python 运行时）、sudo（提权工具）和 systemd（系统服务管理器）的服务器实际版本；
- Cosign（签名工具）版本、官方产物、SHA-256（安全哈希算法）和 Sigstore trusted root（Sigstore 信任根）摘要；
- GitHub Actions runner（GitHub 自动化流水线运行器）版本和官方摘要；
- 适配器、模板、服务单元、提权规则和状态目录权限；
- runner registration token（运行器注册令牌）的一次性获取、使用和清理；
- runner credential（运行器凭据）的注销与删除顺序；
- 适配器升级时的停锁、原子替换、版本回读和回滚；
- 证明工作流身份变更时的双版本短窗口或停发策略。

不能使用 `latest`、在线安装脚本管道、自动接受新 trusted root（信任根）或生产节点源码构建。适配器文件发生变化必须先通过 Pull Request（合并请求）门禁和独立 Task（任务）审核，再在固定 SSH（安全远程登录）维护窗口安装。

## 15. 需要本次 review（审核）确认的关键取舍

1. **新增 deployment authorization（部署授权）是必要门禁。** 现有来源证明只证明“谁构建”，不证明“管理员已发布”；不增加该授权就无法在个人 repository-level runner（仓库级运行器）上防止草稿候选重放。
2. **逻辑协议保留动作和内容摘要，但实际 `sudo` 无动态参数。** 动态字段全部在受签名、严格解码的标准输入中，避免提权规则通配符。
3. **生产节点只接收小证明闭包。** SBOM（软件物料清单）和完整发布附件留在 GitHub 托管验证任务，不把约 2.6 MiB 的无关证据传给生产节点。
4. **当前使用 root-only admin kubeconfig（仅 root 管理客户端配置）。** 不新增长期 Kubernetes token（Kubernetes 令牌）；代价是适配器进程权限高，必须接受或改为另行设计专用身份和准入策略。
5. **选择 Python 3（Python 运行时）标准库。** 避免 root shell script（root 命令行脚本）和新增 Go（Go 语言）交付链；服务器已确认 Python 3.12.3。
6. **使用持久 repository-level runner（仓库级运行器），不假装 label（标签）形成隔离。** 当前用固定证明、零任务令牌、最小 sudoers（提权规则）和 systemd（系统服务管理器）收敛风险；源码仓库开源前必须迁移到独立私有部署仓库并注销本运行器。

## 16. 本设计的停止条件

出现以下任一情况，不编写实施计划：

- Task 13（任务 13）实施前核对发现服务器版本、CPU 架构、K3s（轻量 Kubernetes）、Python（Python 运行时）、sudo（提权工具）或 systemd（系统服务管理器）与第 2.3 节不一致；
- 无法使用无参数精确 sudoers（提权规则）；
- Cosign（签名工具）不能使用固定 trusted root（信任根）和 bundle（证明包）完成所需验证；
- GitHub（代码托管平台）无法为 Published Release（已发布版本）验证工作流签发可固定身份的无密钥证明；
- 生产运行器必须获得模型 Secret（密钥）、kubeconfig（客户端配置）、SSH 私钥、镜像仓库写凭据或有效仓库写令牌；
- 固定适配器无法在不接受任意路径、清单或 `kubectl` 参数的前提下完成首次部署和恢复；
- 不能证明失败后最多一个 observation writer（观测写入端）存在。

## 17. 官方依据

- [GitHub secure use reference（GitHub 安全使用参考）](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub self-hosted runners reference（GitHub 自托管运行器参考）](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub runner group access（GitHub 运行器组访问控制）](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
- [Sigstore Cosign verification（Sigstore 签名验证）](https://docs.sigstore.dev/cosign/verifying/verify/)
- [K3s cluster access（K3s 集群访问）](https://docs.k3s.io/cluster-access)
- [systemd.exec（systemd 进程执行边界）](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [systemd.resource-control（systemd 资源控制）](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [sudoers（提权规则）](https://www.sudo.ws/docs/man/sudoers.man/)
- [Kubernetes Deployment（Kubernetes 工作负载）](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)

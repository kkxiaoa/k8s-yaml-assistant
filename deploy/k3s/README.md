---
status: 任务 4 已实施；等待审核
purpose: 定义固定版本 K3s 单节点安装输入、主机加固边界、恢复材料和任务 4 验收方法
auditedAt: "2026-07-20"
implementedAt: "2026-07-20"
release:
  version: v1.36.2+k3s1
  kubernetesVersion: v1.36.2
  architecture: amd64
  releaseUrl: https://github.com/k3s-io/k3s/releases/tag/v1.36.2%2Bk3s1
  checksumManifestUrl: https://github.com/k3s-io/k3s/releases/download/v1.36.2%2Bk3s1/sha256sum-amd64.txt
  artifacts:
    installer:
      fileName: install.sh
      sourceUrl: https://raw.githubusercontent.com/k3s-io/k3s/v1.36.2+k3s1/install.sh
      sha256: 46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad
    binary:
      fileName: k3s
      sourceUrl: https://github.com/k3s-io/k3s/releases/download/v1.36.2%2Bk3s1/k3s
      sha256: 65a55ec56c24eab44383086166ec620a491952b7e23941a49ddca6e8a4c4b4de
    airgapImages:
      fileName: k3s-airgap-images-amd64.tar.zst
      sourceUrl: https://github.com/k3s-io/k3s/releases/download/v1.36.2%2Bk3s1/k3s-airgap-images-amd64.tar.zst
      sha256: da6a3b2dbd55cc368d930078ae8814ed22eb9c92247f7b9b46bf073445ff55b3
topology:
  serverCount: 1
  datastore: sqlite
  highAvailability: false
hostAudit:
  operatingSystem: ubuntu-24.04
  architecture: amd64
  approvedSshSourceCidr: 42.232.250.103/32
  ufw: inactive
  dockerHubRegistryReachable: false
network:
  podCidr: 10.42.0.0/16
  serviceCidr: 10.43.0.0/16
  publicApi6443: false
  publicFlannel8472: false
  publicKubelet10250: false
  publicHttp80: false
  publicHttps443: false
sshHardening:
  passwordAuthentication: false
  permitRootLogin: prohibit-password
backup:
  target:
    provider: huawei-obs
    region: cn-north-4
    endpoint: https://obs.cn-north-4.myhuaweicloud.com
    bucket: kkx-k8s-yaml-assistant-prod-backup-cn4-20260720
    access: private
    storageClass: standard
    redundancy: multi-az
    serverSideEncryption: SSE-OBS
    versioning: true
    worm: false
  writerIdentity:
    type: ecs-agency
    agencyName: k3s-prod-obs-backup
    policyName: k3s-prod-obs-backup-writer
    credentialSource: instance-metadata
    persistentAccessKey: false
    canRead: false
    canDelete: false
  uploader:
    name: obsutil
    version: 5.8.3
    artifact:
      fileName: obsutil_linux_amd64.tar.gz
      sourceUrl: https://obs-community.obs.cn-north-1.myhuaweicloud.com/obsutil/current/obsutil_linux_amd64.tar.gz
      sha256: 1a90e8861d4ce7f8829ae4392850bfb7d56a3e02e7cdd1f951135b7ae68ff9dd
  database:
    path: /var/lib/rancher/k3s/server/db
    backupSet: k3s-sqlite-database
    objectPrefix: k3s-sqlite-database/
    encrypted: true
    offNode: true
    containsServerToken: false
  serverToken:
    path: /var/lib/rancher/k3s/server/token
    backupSet: k3s-server-token
    objectPrefix: k3s-server-token/
    encrypted: true
    offNode: true
    containsDatabase: false
  manifest:
    objectPrefix: manifests/
    containsSecrets: false
  restoreRequiresBoth: true
implementationEvidence:
  host:
    operatingSystem: ubuntu-24.04.4
    kernel: 6.8.0-136-generic
    pendingPackageUpdates: 0
  cluster:
    version: v1.36.2+k3s1
    nodeReady: true
    nonHealthyPods: 0
    apiReady: true
    secretsEncryption: true
    kubeconfigMode: "0600"
    podSecurityAdmission: restricted-v1.36-dry-run-passed
    applicationNamespacesCreated: false
  network:
    publicTcpPortsVerifiedClosed:
      - 80
      - 443
      - 6443
      - 10250
      - 30991
      - 32164
    publicUdp8472Verification: security-group-rule
  ssh:
    passwordAuthentication: false
    permitRootLoginEffective: without-password
    independentKeyLoginVerified: true
    passwordOnlyLoginRejected: true
  backup:
    backupId: 20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e
    obsutilVersion: 5.8.3
    database:
      objectKey: k3s-sqlite-database/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e/k3s-sqlite-database.tar.gz
      sizeBytes: 5824126
      sha256: 0ba42e673493e6053a8d451d353487209e9340ddfa6d2a3c650aa3e0b550c231
    serverToken:
      objectKey: k3s-server-token/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e/k3s-server-token.tar.gz
      sizeBytes: 274
      sha256: 8a50321faf0a7aa178ba0685514403fe83482e40d631690f264b2ecae2997ed9
    manifest:
      objectKey: manifests/backups/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e.json
      sizeBytes: 1082
      sha256: 3bef7106c7532b579d2d677507186f3f66416e8fcc61f91e975dc3ebde920d5c
    servicePauseSeconds: 7
    recoverySeconds: 7
    writerReadDeniedCount: 3
    administratorReadVerified: true
    persistentAccessKey: false
    temporaryFilesRemoved: true
---

# 固定版本 K3s（轻量 Kubernetes）单节点变更包

> 状态：Task 4（任务 4）已完成实施和 review（审核）。
> 用途：定义固定版本 K3s（轻量 Kubernetes）安装输入、主机加固边界、恢复材料和 Phase 1 Task 4（阶段 1 任务 4）非敏感验收证据。K3s 与备份工具已安装；后续适配器实施计划 Task 4（任务 4）已创建应用固定 Namespace/bootstrap/Secret（命名空间 / 引导配置 / 密钥），Task 5（任务 5）的生产 runner（运行器）已完成真实隔离验证并在线空闲；仍未创建应用工作负载或修改公网安全组。

## 1. 使用边界

- 本目录只包含非敏感配置和可公开核对的 artifact identity（产物身份）；不包含 password（密码）、private key（私钥）、API key（应用程序接口密钥）、server token（服务端令牌）或 kubeconfig（客户端配置）。
- 2026-07-20 已在明确授权的维护窗口安装 K3s（轻量 Kubernetes）与 `obsutil`（OBS 命令行工具），绑定专用私有 OBS（对象存储服务）桶和仅写 IAM（身份与访问管理）委托；服务器不保存永久 AK/SK（访问密钥）。
- 二进制、安装器和镜像包只在受控临时目录下载、核验和使用，没有提交到 Git（版本控制系统）；安装后服务器与本机临时目录均已清理。不执行 `curl | sh`，也不使用 `stable`、`latest` 或其他 moving channel（移动通道）。
- 主机已升级为 Ubuntu 24.04.4、`amd64`、内核 `6.8.0-136-generic`；K3s 保持单节点 SQLite（嵌入式数据库）拓扑，没有安装第二套 container runtime（容器运行时）。

## 2. 发布身份和供应链校验

固定版本为 `v1.36.2+k3s1`，对应 Kubernetes（容器编排系统）`v1.36.2`。版本升级必须形成新的摘要差异并单独审核，不能在实施时自动跟随新版本。

| 产物 | 固定来源 | SHA-256（安全哈希算法）来源 |
|---|---|---|
| `install.sh` | 固定 release tag（发布标签）的 K3s（轻量 Kubernetes）官方仓库文件 | 对固定标签原始内容独立计算并记录在 front matter（文档元数据） |
| `k3s` | K3s（轻量 Kubernetes）官方 release asset（发布产物） | 同一发布版本的官方 `sha256sum-amd64.txt` |
| `k3s-airgap-images-amd64.tar.zst` | K3s（轻量 Kubernetes）官方 air-gap image bundle（离线镜像包） | 同一发布版本的官方 `sha256sum-amd64.txt` |

实施时必须同时满足：下载 URL（统一资源定位符）与文档元数据一致、三个文件的 SHA-256（安全哈希算法）与文档元数据一致、官方 checksum manifest（校验和清单）中的二进制和镜像包摘要仍与本文一致。任一项不一致立即停止，不安装、不用新摘要覆盖本文。

在 Task 4（任务 4）的受控临时目录完成下载后，使用以下固定输入验证；命令不访问 Secret（密钥），也不执行安装：

```bash
printf '%s  %s\n' \
  '46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad' \
  'install.sh' | sha256sum --check --strict
printf '%s  %s\n' \
  '65a55ec56c24eab44383086166ec620a491952b7e23941a49ddca6e8a4c4b4de' \
  'k3s' | sha256sum --check --strict
printf '%s  %s\n' \
  'da6a3b2dbd55cc368d930078ae8814ed22eb9c92247f7b9b46bf073445ff55b3' \
  'k3s-airgap-images-amd64.tar.zst' | sha256sum --check --strict
sha256sum --check --strict --ignore-missing sha256sum-amd64.txt
```

`sha256sum-amd64.txt` 必须来自 front matter（文档元数据）的 `checksumManifestUrl`；最后一条命令必须至少报告 `k3s` 和 `k3s-airgap-images-amd64.tar.zst` 为 `OK`。如果没有检查到这两个本地文件，即使命令退出成功也不能继续。

备份上传工具固定为华为云官方 `obsutil`（OBS 命令行工具）`5.8.3`。华为云只提供 `current`（当前版本）下载地址，因此 URL（统一资源定位符）不是版本身份；必须以官方文档公布的压缩包 SHA-256（安全哈希算法）和包内目录 `obsutil_linux_amd64_5.8.3/` 共同确认身份：

```bash
printf '%s  %s\n' \
  '1a90e8861d4ce7f8829ae4392850bfb7d56a3e02e7cdd1f951135b7ae68ff9dd' \
  'obsutil_linux_amd64.tar.gz' | sha256sum --check --strict
tar -tzf obsutil_linux_amd64.tar.gz
```

目录名、文件清单或摘要任一不符时停止；不得因为 `current` 地址内容变化而自动接受新版本或覆盖本文摘要。配置仅写入北京四 endpoint（端点）和 `autoChooseSecurityProvider=true`，AK/SK（访问密钥）字段必须为空；`obsutil`（OBS 命令行工具）从实例元数据取得自动轮换的临时凭证。

服务器审计发现 GitHub（代码托管平台）、GHCR（GitHub 容器镜像仓库）和 `registry.k8s.io` 可达，但 Docker Hub（Docker 公共镜像仓库）的 registry endpoint（仓库端点）超时。因此本变更包采用 K3s（轻量 Kubernetes）官方 air-gap image bundle（离线镜像包），首次启动没有依赖 Docker Hub（Docker 公共镜像仓库）且系统组件全部就绪。这不是永久断网部署承诺；后续业务镜像的 GHCR（GitHub 容器镜像仓库）拉取仍须在 Phase 2-3（阶段 2-3）使用固定 digest（内容摘要）单独验证。

## 3. 配置契约

`config.yaml` 只固定已审核的最小边界：

| 字段或缺省行为 | 约束 |
|---|---|
| `write-kubeconfig-mode: "0600"` | 管理客户端配置只允许 owner（所有者）读写；不得复制完整内容到仓库、日志或对话。 |
| `secrets-encryption: true` | Kubernetes Secret（Kubernetes 密钥）在 SQLite（嵌入式数据库）中启用静态加密；Task 4（任务 4）必须用状态命令验证。 |
| `disable-network-policy: false` | 保持内置 NetworkPolicy controller（网络策略控制器）启用。 |
| `flannel-backend: vxlan` | 固定当前单节点默认 overlay network（覆盖网络）实现，避免安装时隐式漂移。 |
| `cluster-cidr` / `service-cidr` | 固定为审计过的 `10.42.0.0/16` 和 `10.43.0.0/16`；后续防火墙规则必须整体考虑这两个网段。 |
| `kube-apiserver-arg` | 只加载同目录的 Pod Security Admission（Pod 安全准入）配置。 |
| 未配置 datastore（数据存储）或其他 server（服务端）地址 | 使用单 server（服务端）默认 SQLite（嵌入式数据库），不启用 external datastore（外部数据存储）、cluster-init（集群初始化）或 high availability（高可用）。 |
| 未配置 `disable` | 保持 K3s（轻量 Kubernetes）内置 Traefik（入口控制器）和 ServiceLB（服务负载均衡器）启用。 |

`admission-config.yaml` 对普通 Namespace（命名空间）默认执行、审计并警告 `restricted` Pod Security Standards（受限 Pod 安全标准），策略版本固定为 `v1.36`。仅 `kube-system` 因 K3s（轻量 Kubernetes）系统组件获得 Namespace（命名空间）豁免；不提供用户名或 runtime class（运行时类）豁免。应用资源必须满足受限策略，不能靠新增豁免绕过。

配置不得增加明文凭据、`token`、`write-kubeconfig` 路径、外部 datastore endpoint（数据存储端点）、join server（加入服务端）、组件禁用列表或公网监听声明。需要改变这些边界时先修改契约测试并重新审核。

## 4. 主机、SSH 和网络边界

### 4.1 当前审计事实

- 公网 IP（互联网协议地址）通过云 NAT（网络地址转换）映射到主机私网地址；Kubernetes API（Kubernetes 应用程序接口）不能依赖主机监听地址代替安全组边界。
- 华为云安全组当前只允许 `42.232.250.103/32` 访问 SSH（安全远程登录）22；该来源地址已不同于设计文档中的旧值。家庭出口地址可能变化，每个实施窗口都必须从云控制台和本机重新核对，不能复制历史值。
- K3s（轻量 Kubernetes）现按预期在主机监听 6443/TCP、10250/TCP 和 8472/UDP；公网安全组仍未放行这些端口。实施机外部 TCP（传输控制协议）测试确认 80、443、6443、10250 及当次 ServiceLB（服务负载均衡器）NodePort（节点端口）30991/32164 均不可达；8472/UDP 依据未变更的安全组规则核对，未以 UDP 主动探测结果冒充可达性证明。
- UFW（简单防火墙）当前未启用。K3s（轻量 Kubernetes）官方建议关闭主机防火墙，或在启用时完整放行所需端口和 Pod/Service CIDR（容器组 / 服务网段）。Task 4（任务 4）不顺带切换 UFW（简单防火墙）状态；当前由云安全组承担外层入口边界。未来若启用 UFW（简单防火墙），必须单独审核 `10.42.0.0/16`、`10.43.0.0/16`、DNS（域名系统）和控制面流量，不能只开放一个端口后试错。

### 4.2 SSH（安全远程登录）目标状态

主机已通过 `/etc/ssh/sshd_config.d/00-k3s-hardening.conf` 应用以下状态：

- `PasswordAuthentication no`；
- `PermitRootLogin prohibit-password`，保留已经验证的 root key authentication（root 密钥认证），禁用 root 密码登录。

实施时保留原 SSH（安全远程登录）会话，通过 `sshd -t` 语法检查和 reload（重新加载）后，第二个独立 `huawei-k3s` key（密钥）会话成功；password-only login（仅密码登录）只返回 `publickey` 拒绝。OpenSSH（安全远程登录服务）把 `prohibit-password` 规范化显示为等价的 `without-password`。private key（私钥）、agent socket（代理套接字）和完整服务端配置均未写入仓库。

## 5. Task 4（任务 4）受控实施顺序

2026-07-20 按以下顺序完成实施：

1. 安装前重新核对主机、端口、出口和安全状态；完成 `136` 个软件包升级和新内核安装，重启后确认无待升级软件包。
2. 仅写 IAM（身份与访问管理）委托上传非敏感 canary（探测对象）成功，写入身份读取被拒绝；管理员下载后的 SHA-256（安全哈希算法）与源文件一致后才进入安装。
3. K3s（轻量 Kubernetes）制品先在本机从固定官方 URL（统一资源定位符）下载并校验，再通过 SSH（安全远程登录）传输；服务器端再次核对文档摘要和官方 checksum manifest（校验和清单）。
4. 固定二进制、离线镜像包和两份审核配置按推荐权限安装，安装器使用 `INSTALL_K3S_SKIP_DOWNLOAD=true`、`INSTALL_K3S_VERSION=v1.36.2+k3s1` 和 `INSTALL_K3S_EXEC=server`，没有重新选择版本或下载产物。
5. 集群、Pod Security Admission（Pod 安全准入）、Secret encryption（密钥静态加密）、公网 TCP（传输控制协议）边界通过后，才独立完成 SSH（安全远程登录）加固。
6. 最后在 root-only tmpfs（仅 root 内存临时文件系统）中停服生成分离备份；K3s 恢复健康、三个对象上传并由管理员核对后，清理全部临时文件。

推荐文件权限：`/usr/local/bin/k3s` 和受控临时目录内的 `install.sh` 为 `root:root 0755`；离线镜像包为 `root:root 0644`；两个 K3s（轻量 Kubernetes）配置文件为 `root:root 0600`。安装前后只用 `stat` 和摘要校验核对元数据，不输出配置外的敏感文件内容。

## 6. 验收门禁

Task 4（任务 4）至少执行计划中的系统级检查：

```bash
sudo systemctl status k3s
sudo k3s --version
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get pods -A -o wide
sudo k3s kubectl get --raw=/readyz
sudo k3s check-config
sudo k3s secrets-encrypt status
sudo stat -c '%a %U:%G %n' /etc/rancher/k3s/k3s.yaml
sudo ss -lntup
sudo journalctl -u k3s --since '30 minutes ago'
```

还必须人工核对：

- 实际版本严格等于 `v1.36.2+k3s1`，节点、CoreDNS（集群域名服务）、Traefik（入口控制器）、ServiceLB（服务负载均衡器）和网络组件健康；
- kubeconfig（客户端配置）权限为 `0600`，Secret encryption（密钥静态加密）状态已启用；
- 以 server-side dry run（服务端试运行）提交不符合受限策略的 Pod（容器组）时被拒绝，符合受限策略的对象可以通过，且不持久化测试工作负载；
- 从公网验证 6443/TCP、8472/UDP、10250/TCP、80/TCP 和 443/TCP 仍不可达；22/TCP 仍只允许实施日确认的单一 `/32` 来源；
- 系统日志、命令历史和审核记录中没有 server token（服务端令牌）、完整 kubeconfig（客户端配置）或其他 Secret（密钥）。

2026-07-20 验收结果：

- K3s（轻量 Kubernetes）版本为 `v1.36.2+k3s1`，单节点为 `Ready`（就绪），CoreDNS（集群域名服务）、Traefik（入口控制器）、ServiceLB（服务负载均衡器）、Metrics Server（指标服务）和 Local Path Provisioner（本地路径存储供应器）均健康；非健康系统 Pod（容器组）为 `0`。
- `/readyz` 通过，`k3s secrets-encrypt status` 显示 `Enabled` 且服务端哈希一致；kubeconfig（客户端配置）、server token（服务端令牌）和两份审核配置均为 `root:root 0600`。
- 不满足 `restricted:v1.36` 的 Pod（容器组）在 server-side dry run（服务端试运行）中被拒绝；满足约束的对象通过，`default` Namespace（默认命名空间）没有持久化测试资源，也没有创建应用 Namespace（命名空间）。
- 安装后 K3s systemd service（系统服务）首次检查约占 `1.8 GB`，节点指标约 `1010 MiB`；主机最终仍有约 `6.2 GiB` 可用内存和 `163 GiB` 可用磁盘。该值只是空载实施基线，不是容量承诺。
- 备份恢复后的 K3s 错误级日志为 `0`；软件包为 `0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded`。

## 7. 备份与恢复边界

单节点 SQLite（嵌入式数据库）的集群状态位于 `/var/lib/rancher/k3s/server/db`。`/var/lib/rancher/k3s/server/token` 是恢复加密 bootstrap data（引导数据）所需的独立恢复材料；只有数据库而没有原 server token（服务端令牌）不能构成可验证恢复。

Task 4（任务 4）已按以下目标完成上传与管理员读取验证：

- target（目标）：北京四私有桶 `kkx-k8s-yaml-assistant-prod-backup-cn4-20260720`，标准存储、多 AZ（可用区）、SSE-OBS（OBS 服务端加密）、versioning（版本控制）开启、WORM（一次写入多次读取）关闭；
- writer identity（写入身份）：实例委托 `k3s-prod-obs-backup` 通过 `k3s-prod-obs-backup-writer` 只允许向三个固定前缀写入和处理分段上传，不允许读取、删除或管理桶，不使用永久 AK/SK（访问密钥）；
- `k3s-sqlite-database/`：仅包含停服窗口内生成的一致性数据库 archive（归档），不包含 server token（服务端令牌）；
- `k3s-server-token/`：只包含 server token（服务端令牌）的独立 archive（归档），不包含数据库；
- `manifests/`：只记录 K3s（轻量 Kubernetes）版本、备份时间、非敏感对象键、大小和 SHA-256（安全哈希算法），不记录 token（令牌）内容、临时凭证或完整 kubeconfig（客户端配置）。

上传全程使用 HTTPS（安全超文本传输协议），对象落盘由 SSE-OBS（OBS 服务端加密）保护，密钥由华为云托管，因此生产节点和仓库均不保存客户解密密钥。该边界防止节点磁盘丢失和服务器凭证读取备份，但不防止华为云主账号失陷；恢复读取只由启用 MFA（多因素认证）的管理员身份在受控窗口执行。若未来要求云服务商也无法解密，必须另行审核 client-side encryption（客户端加密）和独立密钥托管，不能临时在生产节点生成长期私钥。

数据库与 server token（服务端令牌）使用不同对象前缀、不同 archive（归档）和不可复用对象键；恢复流程明确要求同时取得两者。生成 archive（归档）时优先使用容量核对后的 root-only tmpfs（仅内存临时文件系统），上传并由管理员核对后立即清理；空间不足时停止，不能回退到未审核的系统盘明文暂存。应用检索索引不在此处备份；其持久事实源是语料、构建代码和固定 image digest（镜像内容摘要）。

本次恢复材料 identity（身份）为 `20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e`：

| 对象 | 大小 | SHA-256（安全哈希算法） |
|---|---:|---|
| `k3s-sqlite-database/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e/k3s-sqlite-database.tar.gz` | `5,824,126` bytes（字节） | `0ba42e673493e6053a8d451d353487209e9340ddfa6d2a3c650aa3e0b550c231` |
| `k3s-server-token/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e/k3s-server-token.tar.gz` | `274` bytes（字节） | `8a50321faf0a7aa178ba0685514403fe83482e40d631690f264b2ecae2997ed9` |
| `manifests/backups/20260720T100909Z-b0c0c408-885b-462f-8a9b-86084961877e.json` | `1,082` bytes（字节） | `3bef7106c7532b579d2d677507186f3f66416e8fcc61f91e975dc3ebde920d5c` |

K3s（轻量 Kubernetes）停服归档与重新启动耗时约 `7` 秒，恢复后非健康 Pod（容器组）为 `0`。三个上传均返回 HTTP `200`；节点写入身份对三个对象的读取均被拒绝，管理员从 OBS（对象存储服务）控制台下载后复算的三个摘要全部一致。未执行破坏性恢复演练。

## 8. 失败处理与回滚

- Task 4（任务 4）已经改变服务器状态；不能再把回滚描述为仅恢复仓库差异。K3s（轻量 Kubernetes）服务、配置和恢复材料必须作为整体处理。
- Task 4（任务 4）若摘要、内核检查、服务启动、Pod Security Admission（Pod 安全准入）、加密或端口验证失败，先停止继续变更并保留诊断证据。不得把关闭准入、关闭网络策略、开放 6443 或放宽 kubeconfig（客户端配置）权限作为修复。
- K3s（轻量 Kubernetes）卸载会删除集群数据，不是自动失败处理。只有精确列出删除目标、核对两套加密节点外备份并取得单独 destructive action（破坏性操作）授权后才能执行。
- SSH（安全远程登录）加固失败时使用仍保持的原会话恢复上一个已验证配置；没有并行密钥会话时不得 reload（重新加载）服务。

当前剩余风险：

- 仍是单节点、单副本和 SQLite（嵌入式数据库），节点故障会造成整体不可用；本阶段不承诺 high availability（高可用）。
- 本次只证明停服备份、上传、管理员读取和摘要一致，尚未执行破坏性恢复演练，也尚未配置周期化备份、失败告警或 retention automation（保留期自动化）。
- OBS（对象存储服务）使用 SSE-OBS（OBS 服务端加密）而不是 client-side encryption（客户端加密）；华为云主账号失陷不在该边界内。
- 8472/UDP 的公网关闭结论来自未变更安全组规则，不把无响应 UDP 探测当作独立证据；后续任何安全组变更都必须重新审核。
- root key login（root 密钥登录）仍按审核边界保留；密码认证已关闭。后续若改为非 root 运维账号和最小 `sudo`（提权），必须形成独立变更。

## 9. 官方依据

- [K3s v1.36.2+k3s1 release（发布版本）](https://github.com/k3s-io/k3s/releases/tag/v1.36.2%2Bk3s1)
- [K3s air-gap install（离线安装）](https://docs.k3s.io/installation/airgap)
- [K3s requirements（安装要求）](https://docs.k3s.io/installation/requirements)
- [K3s configuration file（配置文件）](https://docs.k3s.io/installation/configuration)
- [K3s secrets encryption（密钥静态加密）](https://docs.k3s.io/security/secrets-encryption)
- [Kubernetes Pod Security Admission（Kubernetes Pod 安全准入）](https://kubernetes.io/docs/tasks/configure-pod-container/enforce-standards-admission-controller/)
- [K3s backup and restore（备份与恢复）](https://docs.k3s.io/datastore/backup-restore)
- [Flexus L instance agency（Flexus L 实例委托）](https://support.huaweicloud.com/flexusl_faq/flexusl_faq_0001.html)
- [OBS IAM policy（OBS 身份与访问管理策略）](https://support.huaweicloud.com/usermanual-obs/obs_03_0121.html)
- [obsutil download and checksum（OBS 命令行工具下载与校验和）](https://support.huaweicloud.com/utiltg-obs/obs_11_0003.html)
- [obsutil automatic temporary credentials（OBS 命令行工具自动临时凭证）](https://support.huaweicloud.com/intl/zh-cn/utiltg-obs/obs_11_0067.html)

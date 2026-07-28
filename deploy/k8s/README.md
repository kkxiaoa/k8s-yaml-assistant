状态：Task 4-5（任务 4-5）已完成实施和 review（审核）；Task 7 Step 7（任务 7 步骤 7）的真实人工回滚与恢复及 Step 8（步骤 8）的节点重启恢复均已完成。私有 K3s（轻量 Kubernetes）先从 `v0.1.1` 切换到 `v0.1.0`，再恢复到 `v0.1.1`，随后在新鲜分离备份和独立授权下完成节点重启。2026-07-28 独立审核接受 Step 5（步骤 5）的部分验收边界和 Step 6（步骤 6）的明确延期风险，Step 9（步骤 9）事实状态同步完成；两项仍保持未完成，不冒充真实观测生命周期或自动恢复生产实证。
用途：定义生产 Kubernetes（容器编排系统）固定非敏感资源、应用模板及其审核和回退边界。

# K3s 生产资源边界

2026-07-27 在单独获得 bootstrap/Secret（引导配置 / 密钥）授权后，生产集群已创建本目录的固定 bootstrap（引导配置）和三类运行时 Secret（密钥）。2026-07-28 经逐项授权，`app/deployment-template.yaml` 已由固定部署适配器先应用 `v0.1.1`，再通过人工确认回滚切换到 `v0.1.0`，最后通过同一受信链恢复到 `v0.1.1`；节点重启后当前固定单副本 Deployment/Pod（工作负载 / 容器组）为 `1/1` 可用，Pod（容器组）重启为预期的 `1` 且没有继续增加。集群仍没有 Ingress（入口），公网 80/443/6443 不可达。

同日已把 GitHub Actions runner `v2.336.0`（GitHub 自动化流水线运行器版本 2.336.0）安装并注册为 `huawei-k3s-prod-1`。首次真实隔离验证发现旧 drop-in（附加配置）的 `ReadWritePaths` 会遮蔽工作/诊断目录的有界 tmpfs（内存文件系统），且 `RuntimeDirectory`（运行时目录）最终把适配器运行时目录交给服务账号；首次修正又证明 `ExecStartPre`（启动前命令）无法修改下一执行阶段的私有挂载。最终配置由 tmpfs 挂载直接使用固定 `UID 996 / GID 988`（用户 / 组数字标识），已通过真实启动、写入和第二次服务重启验证。当前服务为 `active/enabled`（运行中 / 开机自启），GitHub 状态在线空闲。

| Runner lifecycle（运行器生命周期） | 固定事实 |
| --- | --- |
| 官方发布时间 | 2026-07-20 17:45:55 UTC（协调世界时） |
| 安装和注册时间 | 2026-07-27 |
| 当前服务单元 | `actions.runner.kkxiaoa-k8s-yaml-assistant.huawei-k3s-prod-1.service` |
| 最晚版本复核 | 2026-08-19，或后续固定版本发布后 30 天内，以更早触发者为准 |

| systemd isolation（系统服务隔离） | 实测结果 |
| --- | --- |
| 工作目录 | 128 MiB tmpfs（内存文件系统），`gha-k8s-yaml-prod:gha-k8s-yaml-prod 0700` |
| 诊断目录 | 32 MiB tmpfs（内存文件系统），`gha-k8s-yaml-prod:gha-k8s-yaml-prod 0700` |
| 适配器运行时目录 | `root:root 0700` |
| 服务资源 | `MemoryMax=1G`、`CPUQuota=200%`、`TasksMax=256` |
| metadata service（元数据服务） | `169.254.0.0/16` 拒绝 |
| 服务重启 | PID（进程标识）更换后重新连接 GitHub，挂载边界保持不变 |
| 安全分析 | `systemd-analyze security`（系统服务安全分析）为 `6.3 MEDIUM`（中等暴露）；保留必需出站网络和唯一 sudo（提权）入口 |

## 资源、职责与所有者

| 文件或资源 | 职责 | 字段所有者 |
| --- | --- | --- |
| `bootstrap/namespace.yaml` | 创建 `k8s-yaml-assistant-prod`，固定 restricted Pod Security（受限容器组安全）策略及 Kubernetes 1.36 版本 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/service-account.yaml` | 提供不创建额外 RBAC（基于角色的访问控制）、不自动挂载令牌的应用身份 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/config-map.yaml` | 提供模型身份、供应商地址、镜像内索引路径、私有访问模式和安全在线观测参数 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/service.yaml` | 只用 ClusterIP Service（集群内服务）把 80 转发到应用 3000 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/observation-pvc.yaml` | 为脱敏后的安全 observation segment（观测分段）申请 1 GiB local-path PVC（本地路径持久卷声明） | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/network-policy.yaml` | 限制应用入站，并只显式放行 DNS（域名系统）和公网 IPv4 的 443/TCP 出站 | `k8s-yaml-assistant-bootstrap` |
| `app/deployment-template.yaml` | 固定应用的副本、资源、安全上下文、探针、卷和凭据引用，只允许部署适配器替换镜像摘要 | `k8s-yaml-assistant-deployer` |

bootstrap（引导配置）只管理不随应用版本变化的固定资源。应用版本只能由 root-owned adapter（超级用户所有的适配器）把模板中的唯一镜像标记替换成 `ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:<64-hex>` 后应用。Ingress（入口）、TLS（传输层安全）和认证等入口资源属于 Phase 4（阶段 4），不放进当前 bootstrap（引导配置）或应用版本模板。

`ACCESS_MODE=private` 是后续入口治理的固定部署契约；当前应用尚未消费该值，所以它本身不构成认证或授权。当前私有边界仍依靠“没有入口资源、80/443 不公开”和受限验证路径。完成应用侧 fail-safe authorization（失败时安全关闭的授权）、认证与限流前，不得公开服务。

## Secret 职责与轮换

仓库只固定引用且不保存 Secret（密钥）值；生产集群当前存在以下三个按职责拆分的对象：

| 名称 | 类型与 key | 职责 |
| --- | --- | --- |
| `deepseek-runtime` | Opaque（不透明密钥），`api-key` | 只注入 `DEEPSEEK_API_KEY` |
| `voyage-runtime` | Opaque（不透明密钥），`api-key` | 只注入 `VOYAGE_API_KEY` |
| `ghcr-pull` | `kubernetes.io/dockerconfigjson` | 只用具有 `read:packages` 权限的 GHCR（GitHub 容器镜像仓库）凭据拉取私有镜像 |

创建或轮换时，从仓库外的密码管理器把每项内容分别写入权限为 `0600` 的受控临时输入。DeepSeek 和 Voyage 通过 `--from-file=api-key=/dev/stdin` 创建；GHCR（GitHub 容器镜像仓库）凭据在本机内存中转换为 `.dockerconfigjson` 后通过标准输入创建。值不进入命令参数、仓库、日志或持久 YAML（配置文件），字段所有者固定为 `k8s-yaml-assistant-secrets`。

更新同名 Secret（密钥）后，环境变量不会自动进入现有 Pod（容器组）。管理员必须在受限 SSH（安全远程登录）路径执行受审核的 `rollout restart`（滚动重启），等待就绪并核对仍运行原授权镜像摘要。轮换完成后先列出临时文件的精确路径并再次确认范围，再删除；泄露时立即吊销供应商或 GHCR 凭据、生成最小权限替代项、更新对应 Secret（密钥）并完成滚动重启。任何核对命令都不得输出 `.data`、完整环境或镜像仓库认证内容。

## 存储边界

`k8s-yaml-assistant-observation` 只挂载到 `/app/data/observability`，应用只把 `/app/data/observability/segments` 作为 local sink（本地写入端）根目录。应用配置定义 7 天、单文件 16 MiB、总量 256 MiB 的轮转和删除边界；1 GiB PVC（持久卷声明）不是应用可无限使用的配额。2026-07-28 的首次真实验收发现 local-path PV（本地路径持久卷）的挂载根目录为 `0777 root:10001`，不符合旧 `0700` 根目录契约，`v0.1.0` 因此以 `root_unsafe` 安全关闭观测。`v0.1.1` 已在相同挂载中由 UID/GID（用户 / 组标识）`10001/10001` 创建 `0700` 私有子目录，且日志不再出现 `root_unsafe`；经单独授权的有限模型冒烟已创建 1 条 `0600 10001:10001` 真实分段并验证安全投影。回滚到 `v0.1.0` 后 `root_unsafe` 按预期再次出现，观测写入关闭；恢复到 `v0.1.1` 后私有子目录和正常写入边界重新生效，启动日志不再出现 `root_unsafe`。既有分段在整个往返过程中保持 1,170 字节、1 行、`0600 10001:10001` 且不是符号链接。单条记录不能证明 16 MiB 轮转、7 天 / 256 MiB 清理、人工删除或符号链接攻击拒绝，因此仍不得声称这些边界已经完成生产验收。

索引固定在镜像 `/app/data/index` 中，依靠只读根文件系统读取，不挂载 PVC（持久卷声明），Pod（容器组）重启也不会重建索引。`/tmp` 使用上限为 64 MiB 的 emptyDir（临时卷）。不得把索引、原始 YAML、模型回答、Secret（密钥）或未来计量状态写入 observation PVC（观测持久卷声明）。

K3s local-path（K3s 本地路径）卷与当前单节点处于同一节点故障域：PVC（持久卷声明）可以跨 Pod（容器组）重启保留，但不能抵御节点或系统盘故障，也不构成异地备份。Phase 3（阶段 3）必须验证 `fsGroup=10001` 的写权限、轮转、磁盘增长和滚动更新期间的单写入端不变量。

## 网络策略的实际能力

应用只接受 `kube-system` 中带 Traefik（入口控制器）标签的 Pod（容器组）访问 3000/TCP；当前没有 Ingress（入口），所以该许可不会自行产生公开路由。出站只显式放行 CoreDNS（集群域名服务）的 53/UDP、53/TCP，以及排除私网和链路本地地址后的公网 IPv4 443/TCP。

标准 NetworkPolicy（网络策略）不能按域名建立可靠 allowlist（允许名单）；当前 443 规则比 DeepSeek/Voyage 两个供应商域名更宽。它也不能保证阻止到所在节点的流量，策略是否实际执行取决于 K3s（轻量 Kubernetes）的网络插件。后续若必须按域名约束，应单独审核 egress proxy（出站代理），不能把当前规则描述成域名隔离。

## Task 4 试运行与核对

以下命令只在 Task 4（任务 4）获得当次授权、进入包含本目录的审核后版本，并重新核对服务器后执行。先做全部文件的客户端解析，再单独试运行并创建 Namespace（命名空间）；否则其余资源的服务端试运行会因为目标命名空间尚不存在而失败：

```bash
sudo k3s kubectl apply --dry-run=client --validate=strict -f deploy/k8s/bootstrap
sudo k3s kubectl apply --server-side --dry-run=server --validate=strict --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap/namespace.yaml
sudo k3s kubectl diff --server-side --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap/namespace.yaml
sudo k3s kubectl apply --server-side --validate=strict --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap/namespace.yaml
```

Namespace（命名空间）回读符合预期后，才对完整目录做不落盘的服务端校验和字段差异。`kubectl diff`（差异检查）返回 1 表示存在预期差异，返回值大于 1 才是命令错误；仍必须人工审核输出：

```bash
sudo k3s kubectl apply --server-side --dry-run=server --validate=strict --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap
sudo k3s kubectl diff --server-side --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap
```

只有完整差异审核通过后才可执行其余 bootstrap（引导配置）：

```bash
sudo k3s kubectl apply --server-side --validate=strict --field-manager=k8s-yaml-assistant-bootstrap -f deploy/k8s/bootstrap
```

回读只检查身份、类型和安全边界，不读取 Secret（密钥）值：

```bash
sudo k3s kubectl get namespace k8s-yaml-assistant-prod --show-labels
sudo k3s kubectl -n k8s-yaml-assistant-prod get serviceaccount,configmap,service,persistentvolumeclaim,networkpolicy -o name
sudo k3s kubectl -n k8s-yaml-assistant-prod get service k8s-yaml-assistant -o jsonpath='{.spec.type}{"\n"}'
sudo k3s kubectl auth can-i --as=system:serviceaccount:k8s-yaml-assistant-prod:k8s-yaml-assistant get secrets -n k8s-yaml-assistant-prod
sudo k3s kubectl auth can-i --as=system:serviceaccount:k8s-yaml-assistant-prod:k8s-yaml-assistant get configmaps -n k8s-yaml-assistant-prod
sudo k3s kubectl -n k8s-yaml-assistant-prod get deployment,pod,ingress
```

最后一组预期是两次 `no`，且不存在 Deployment/Pod/Ingress（工作负载 / 容器组 / 入口）。PVC（持久卷声明）在首个消费者出现前可能因 StorageClass（存储类）的绑定模式保持 Pending（等待中）；Task 4（任务 4）必须结合实际 `local-path` 配置判断，不通过删除或重建绕过。

## Task 4（任务 4）非敏感实施证据

2026-07-27 的实时 preflight（前置核对）、服务端试运行、创建和回读结果为：

- K3s/Python/sudo/systemd（K3s / Python 运行时 / 提权工具 / 系统服务管理器）版本未漂移，K3s API（K3s 应用程序接口）健康且 Secret encryption（密钥静态加密）为 `Enabled`；
- 初始目标 Namespace（命名空间）、适配器和生产 runner（运行器）均不存在；全部清单通过客户端解析，Namespace 和完整 bootstrap（引导配置）通过严格服务端试运行，`diff`（差异）只有预期新增对象，未强制接管字段所有权；
- Namespace、ServiceAccount、ConfigMap、Service、PVC 和 NetworkPolicy（命名空间 / 服务账户 / 普通配置 / 服务 / 持久卷声明 / 网络策略）均由 `k8s-yaml-assistant-bootstrap` 管理；Service（服务）为 `ClusterIP`，没有 NodePort、external IP 或 LoadBalancer（节点端口 / 外部地址 / 负载均衡器）；
- `deepseek-runtime`、`voyage-runtime` 和 `ghcr-pull` 的类型与 key（键）集合分别为 `Opaque/api-key`、`Opaque/api-key` 和 `kubernetes.io/dockerconfigjson/.dockerconfigjson`，均由 `k8s-yaml-assistant-secrets` 管理；回读未输出 `.data`；
- 应用 ServiceAccount（服务账户）不能 get/list Secret（读取 / 列举密钥），也不能创建 Deployment（工作负载）；
- `local-path` StorageClass（本地路径存储类）使用 `WaitForFirstConsumer`（等待首个消费者），因此 observation PVC（观测持久卷声明）在没有 Pod（容器组）时为预期 `Pending`（等待中）；
- 集群不存在应用 Deployment/Pod/Ingress（工作负载 / 容器组 / 入口）；服务器目标监听仍只有既有 K3s `6443`，从当次外部来源验证 80/443/6443 均不可达；
- 三个本地临时输入和 `ghcr.io` Docker Keychain（Docker 钥匙串）登录项在单独确认删除范围后清理；GitHub PAT（GitHub 个人访问令牌）和 Kubernetes Secret（Kubernetes 密钥）不属于该删除范围。

## Task 7（任务 7）`v0.1.1` 与人工回滚、恢复非敏感实施证据

2026-07-28 经本次明确授权完成发布、部署和非模型验收：

- `v0.1.1` Release（发布版本）`360575653` 精确绑定源提交 `ac9eb22100e300e8b3babd3bdc26ad8e45ea169d`，包含六项证据；`Deploy published release`（部署已发布版本）运行 `30296287472` Attempt 1（第 1 次尝试）成功，GitHub deployment（GitHub 部署记录）`5628234264` 最终为 `success`。
- 因跨境 GHCR（GitHub 容器镜像仓库）冷拉取过慢且 SWR（华为云容器镜像服务）企业版仍待审批，本次在 Publish（正式发布）前把精确 `linux/amd64` 镜像制作为保留根摘要的 OCI archive（开放容器镜像归档），校验 SHA-256（安全哈希算法）`86766515ef4793329808f60747dfce4a50c43e610e1cbaeafbc7f06aa535ff29` 后经 SSH（安全远程登录）传输并由 `k3s ctr images import` 导入。临时认证文件和两端归档已删除，节点保留生产所需的已导入内容；这是一条一次性临时路径，不替代同区域镜像分发。
- 人工回滚 Release（发布版本）`360812512` 通过不可变标签精确绑定 `v0.1.0` 摘要和唯一 provenance bundle（来源证明包）；`Deploy published release`（部署已发布版本）运行 `30325880287` Attempt 1（第 1 次尝试）成功，GitHub deployment（GitHub 部署记录）`5633580284` 最终为 `success`。节点事件确认目标镜像已存在于本机，没有跨境拉取。
- 恢复 Release（发布版本）`360824879` 通过不可变标签精确绑定 `v0.1.1` 摘要和唯一 provenance bundle（来源证明包），于 `2026-07-28T03:56:06Z` Publish（正式发布）；仓库 `Latest`（最新发布）仍为普通 `v0.1.1` Release（发布版本）。`Deploy published release`（部署已发布版本）运行 `30327301138` Attempt 1（第 1 次尝试）成功，GitHub deployment（GitHub 部署记录）`5633826683` 最终为 `success`。节点事件确认目标镜像已存在于本机，没有跨境拉取。
- 当前生产镜像为 `ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37`；Deployment/Pod（工作负载 / 容器组）为 `1/1` 可用，节点重启后 Pod（容器组）重启为预期的 `1` 且没有继续增加。生产运行器服务为 `active/enabled`（运行中 / 开机自启），GitHub（代码托管平台）显示在线空闲，适配器操作标记不存在。成功台账已有四个事件和两个不同摘要，最新事件仍为精确绑定运行 `30327301138/1` 的 `action=rollback`。
- `/api/health/live`、`/api/health/ready` 和非模型 `/api/check` 均通过固定本机 SSH tunnel（SSH 隧道）验证；8,410 条镜像内索引的身份和文件哈希与发布清单一致，文件时间早于 Pod（容器组），没有在线重建。公网 80/443/6443 仍不可达，没有 Ingress（入口）。
- `v0.1.1` 容器进程保持 UID/GID（用户 / 组标识）`10001/10001`、只读根文件系统、零 Linux capability（Linux 能力）和未挂载 ServiceAccount token（服务账户令牌）。其 `/app/data/observability/segments` 为 `10001:10001 0700`，回滚前日志没有 `root_unsafe`、观测失败或敏感内容模式。
- 经单独授权发送 1 个非敏感 `/api/ask` 客户端请求，允许 SDK（软件开发工具包）自动重试最多 2 次且没有手工重试；请求返回 HTTP 200、两个预期来源、完整结束事件和零错误。精确字段路径未进入 Voyage（向量与重排模型）；当前路由不返回 DeepSeek（回答模型）的实际上游重试次数或 `usage`，因此不记录猜测的调用次数和费用。
- 生产创建 1,170 字节的 `serving-observations.2026-07-28.0001.jsonl`，权限与所有者为 `0600 10001:10001`、非符号链接且只有 1 条严格记录。记录不含当前 YAML（配置文件）、提示词或回答，Pod（容器组）日志也没有这些内容、`root_unsafe` 或观测失败模式；模型冒烟后 Pod（容器组）继续就绪且重启为 `0`。
- 与 `v0.1.1` 源码一致的配置、脱敏、投影、采样、轮转、保留、总量清理和符号链接拒绝本地门禁为 55/55 通过。恢复后的 `/app/data/observability/segments` 为 `10001:10001 0700`，既有分段仍为 1,170 字节、`0600 10001:10001`、1 行且不是符号链接；启动日志没有 `root_unsafe` 或观测失败，恢复过程没有模型调用。16 MiB 轮转、7 天 / 256 MiB 清理、人工删除和符号链接攻击拒绝仍没有生产实证。
- 节点重启前已创建数据库与服务端令牌分离备份 `20260728T041517Z-8d2b24cc-0d2d-4954-9997-ce6b2f1aa3e6`，上传私有 OBS（对象存储服务）的三个对象均由管理员回读核对摘要。重启后 K3s（轻量 Kubernetes）、生产运行器和应用自动恢复，适配器运行时目录重新创建为 `root:root 0700`；节点复用本地 `v0.1.1` 镜像，没有跨境拉取。
- 节点重启没有改变 Deployment（工作负载）代次、成功台账、操作标记、observation PVC（观测持久卷声明）分段或三个索引文件的时间与摘要，也没有产生 GitHub（代码托管平台）运行、deployment（部署记录）、模型调用或在线索引重建。启动瞬间一条 startup probe（启动探针）连接拒绝警告后，live/ready（存活 / 就绪）持续返回 HTTP `200`。

## 非破坏性回退

如果试运行、字段冲突或实际应用失败，立即停止后续 Secret（密钥）和应用版本步骤，保留 Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）以便诊断。不要使用强制字段接管，也不要删除有状态资源。

需要恢复普通配置时，从独立、干净的上一份已审核的 bootstrap（引导配置）目录先运行同样的服务端试运行和 `diff`（差异），再由相同 `k8s-yaml-assistant-bootstrap` 字段所有者重新应用。PVC（持久卷声明）的不可变字段冲突时停止并重新审核；不通过删除 PVC（持久卷声明）实现“回退”。应用版本部署失败由固定适配器按成功台账自动恢复上一镜像摘要，不直接修改 Deployment（工作负载）或绕过台账。

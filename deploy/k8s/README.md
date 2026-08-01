状态：Task 4-7（任务 4-7）的既有生产实施证据保持不变。Task 16-17（任务 16-17）的三态体验控制、持久额度与费用门禁、公开入口及短期公网 IP 证书已完成生产非模型验收；GitHub OAuth 2.0（GitHub 开放授权 2.0）真实 callback（回调）因固定依赖的 3.5 秒出站超时而不稳定。本地修复候选已把该请求超时显式设为 15 秒并通过测试、类型检查和生产构建，但尚未发布、部署或完成生产复验，模型开关仍关闭。
用途：定义生产 Kubernetes（容器编排系统）固定非敏感资源、应用模板及其审核和回退边界。

# K3s 生产资源边界

2026-07-27 至 2026-07-28 已完成既有私有生产基线与 `v0.1.1` 部署、回滚、恢复及节点重启验证；2026-07-31 已发布并部署 `v0.2.0`，随后在保持同一镜像根摘要的前提下接入生产认证 Secret（密钥）、控制库 PVC（持久卷声明）和固定应用模板。当前生产通过 Traefik IngressRoute（入口路由）公开唯一基础路径 `/k8s-yaml-assistant`，使用绑定 `120.46.57.214` 的 Let’s Encrypt（证书颁发机构）短期证书；公网 80 只服务 ACME HTTP-01（自动证书管理环境 HTTP 控制权校验），公网 443 服务应用。

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
| `bootstrap/config-map.yaml` | 提供模型身份、供应商地址、镜像内索引路径、首次关闭模型的运维开关、控制库路径及安全在线观测参数 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/service.yaml` | 只用 ClusterIP Service（集群内服务）把 80 转发到应用 3000 | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/observation-pvc.yaml` | 为脱敏后的安全 observation segment（观测分段）申请 1 GiB local-path PVC（本地路径持久卷声明） | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/control-pvc.yaml` | 为模式、额度、费用与请求预留状态申请独立 1 GiB local-path PVC（本地路径持久卷声明） | `k8s-yaml-assistant-bootstrap` |
| `bootstrap/network-policy.yaml` | 限制应用入站，并只显式放行 DNS（域名系统）和公网 IPv4 的 443/TCP 出站 | `k8s-yaml-assistant-bootstrap` |
| `app/deployment-template.yaml` | 固定应用的副本、资源、安全上下文、探针、卷和凭据引用，只允许部署适配器替换镜像摘要 | `k8s-yaml-assistant-deployer` |
| `access/middlewares.yaml` / `access/routes.yaml` / `access/http-redirect.yaml` | 由 Traefik（入口控制器）直接暴露唯一语义化基础路径，将该路径的明文 HTTP（超文本传输协议）请求重定向到 HTTPS（加密超文本传输协议），并限制请求体、速率和并发 | Task 16（任务 16）入口实施 |
| `tls/` | 固定公网 IP 证书签发、自动续期和唯一默认 TLSStore（传输层安全证书仓库） | Task 16（任务 16）入口实施 |

bootstrap（引导配置）只管理不随应用版本变化的固定资源。应用版本只能由 root-owned adapter（超级用户所有的适配器）把模板中的唯一镜像标记替换成 `ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:<64-hex>` 后应用。入口和证书作为独立资源由 `k8s-yaml-assistant-public-entry` 与固定 cert-manager（证书管理器）安装字段分别管理，不由镜像替换适配器隐式修改。

应用内 NextAuth.js（身份认证库）直接处理 GitHub 登录，任何有效 GitHub 用户均可登录；只有固定数字 GitHub 用户编号可进入 `/k8s-yaml-assistant/admin`。匿名浏览器使用服务端签名 Cookie（浏览器标识）获得 30 天 7 点体验包，登录后获得独立每日额度，`check` 不扣产品点数；清除 Cookie 可以重置匿名身份，因此该机制不作为机器人防护。模型能力由持久控制库的 `normal | interview | sleep`、主体点数、全局费用和最高优先级 `MODEL_ACCESS_ENABLED` 共同决定；协议值 `interview` 的页面名称为“开放展示模式”。生产首次配置固定 `MODEL_ACCESS_ENABLED=false`，新建控制库固定为 `sleep`；匿名页面和已有登录会话下的管理员读取通过，本地候选已把 OAuth token exchange（开放授权令牌交换）超时从依赖默认的 3.5 秒显式放宽为 15 秒，仍须在新版本发布和部署后重新验收真实 GitHub callback（开放授权回调）。任何发布、部署、模型开放或调用仍需另行授权。

## Secret 职责与轮换

仓库只固定引用且不保存 Secret（密钥）值；以下四项均已存在于生产：

| 名称 | 类型与 key | 职责 |
| --- | --- | --- |
| `deepseek-runtime` | Opaque（不透明密钥），`api-key` | 只注入 `DEEPSEEK_API_KEY` |
| `voyage-runtime` | Opaque（不透明密钥），`api-key` | 只注入 `VOYAGE_API_KEY` |
| `ghcr-pull` | `kubernetes.io/dockerconfigjson` | 只用具有 `read:packages` 权限的 GHCR（GitHub 容器镜像仓库）凭据拉取私有镜像 |
| `k8s-yaml-assistant-auth` | Opaque（不透明密钥），`github-client-id`、`github-client-secret`、`session-secret`、`admin-github-id`、`subject-hmac-key` | 应用内 GitHub OAuth 2.0（GitHub 开放授权 2.0）、管理员数字身份、会话签名、账本匿名化和匿名体验 Cookie（浏览器标识）签名 |

创建或轮换时，从仓库外的密码管理器把每项内容分别写入权限为 `0600` 的受控临时输入。值不进入命令参数、仓库、日志或持久 YAML（配置文件），字段所有者固定为 `k8s-yaml-assistant-secrets`。GitHub OAuth App（GitHub 开放授权应用）的 callback（回调）固定为 `https://120.46.57.214/k8s-yaml-assistant/api/auth/callback/github`，权限范围固定为 `read:user`。轮换 `NEXTAUTH_SECRET` 会使现有会话失效；轮换主体 HMAC（带密钥安全哈希）密钥会使现有登录额度主体和匿名体验 Cookie（浏览器标识）失效，但全局费用预算仍保留。

更新同名 Secret（密钥）后，环境变量不会自动进入现有 Pod（容器组）。管理员必须在受限 SSH（安全远程登录）路径执行受审核的 `rollout restart`（滚动重启），等待就绪并核对仍运行原授权镜像摘要。轮换完成后先列出临时文件的精确路径并再次确认范围，再删除；泄露时立即吊销供应商或 GHCR 凭据、生成最小权限替代项、更新对应 Secret（密钥）并完成滚动重启。任何核对命令都不得输出 `.data`、完整环境或镜像仓库认证内容。

## 存储边界

`k8s-yaml-assistant-observation` 只挂载到 `/app/data/observability`，应用只把 `/app/data/observability/segments` 作为 local sink（本地写入端）根目录。应用配置定义 7 天、单文件 16 MiB、总量 256 MiB 的轮转和删除边界；1 GiB PVC（持久卷声明）不是应用可无限使用的配额。2026-07-28 的首次真实验收发现 local-path PV（本地路径持久卷）的挂载根目录为 `0777 root:10001`，不符合旧 `0700` 根目录契约，`v0.1.0` 因此以 `root_unsafe` 安全关闭观测。`v0.1.1` 已在相同挂载中由 UID/GID（用户 / 组标识）`10001/10001` 创建 `0700` 私有子目录，且日志不再出现 `root_unsafe`；经单独授权的有限模型冒烟已创建 1 条 `0600 10001:10001` 真实分段并验证安全投影。回滚到 `v0.1.0` 后 `root_unsafe` 按预期再次出现，观测写入关闭；恢复到 `v0.1.1` 后私有子目录和正常写入边界重新生效，启动日志不再出现 `root_unsafe`。既有分段在整个往返过程中保持 1,170 字节、1 行、`0600 10001:10001` 且不是符号链接。单条记录不能证明 16 MiB 轮转、7 天 / 256 MiB 清理、人工删除或符号链接攻击拒绝，因此仍不得声称这些边界已经完成生产验收。

`k8s-yaml-assistant-control` 只挂载到 `/app/data/control`，应用在卷内创建自己持有的 `0700` 私有子目录，并把 SQLite（嵌入式数据库）放在 `/app/data/control/private/control.sqlite3`，不修改可能由 `root` 持有的挂载根目录权限。数据库只保存模式、匿名化额度、费用账本和请求预留状态，不保存用户名、网络地址、YAML、问题、回答或 OAuth（开放授权）令牌。新库从 `sleep` 开始，账本保留 35 天。

2026-07-31 的生产验收确认控制 PVC（持久卷声明）为 `Bound`（已绑定），卷内 `private` 目录为 `10001:10001 0700`，SQLite（嵌入式数据库）主文件、WAL（预写日志）和共享内存文件均为 `10001:10001 0600` 且不是符号链接。首次 HMAC（带密钥安全哈希）输入误用 Base64URL（网址安全型基础六十四编码），实际文件不存在证明控制库初始化失败；该键按 32 字节规范 Base64（基础六十四编码）契约轮换并滚动替换 Pod（容器组）后，数据库真实创建且模式为 `sleep`。验收期间 `MODEL_ACCESS_ENABLED=false`，只执行 live/ready（存活 / 就绪）、体验状态、认证提供器、OAuth（开放授权）回调尝试和 `/api/check` 非模型请求；控制库仍为 `sleep`，请求账本为 `0`，没有调用模型、重建索引或重启节点。

索引固定在镜像 `/app/data/index` 中，依靠只读根文件系统读取，不挂载 PVC（持久卷声明），Pod（容器组）重启也不会重建索引。`/tmp` 保持既有上限为 64 MiB 的 emptyDir（临时卷），作为只读根文件系统下唯一有界可写临时路径。不得把索引、原始 YAML、模型回答或 Secret（密钥）写入 observation/control PVC（观测／控制持久卷声明）。

K3s local-path（K3s 本地路径）卷与当前单节点处于同一节点故障域：PVC（持久卷声明）可以跨 Pod（容器组）重启保留，但不能抵御节点或系统盘故障。控制库不做异地备份；节点磁盘完全损坏时允许丢失这些低价值控制状态，历史额度和费用累计也会在新库内从零开始。新库从 `sleep` 开始，管理员必须显式恢复 `normal` 或限时开放展示后才会重新产生模型费用。Phase 3（阶段 3）必须验证 `fsGroup=10001` 的写权限、磁盘增长和滚动更新期间的单写入端不变量。

## 网络策略的实际能力

应用只接受 `kube-system` 中带 Traefik（入口控制器）标签的 Pod（容器组）访问 3000/TCP；HTTPS IngressRoute（加密入口路由）只匹配 `/k8s-yaml-assistant` 并转发到应用 Service（服务），HTTP IngressRoute（明文入口路由）只匹配同一应用路径并在转发前重定向到 HTTPS（加密超文本传输协议）。两条入口均不匹配根路径或 `/.well-known/acme-challenge/`；根健康路径仅供集群探针使用，新镜像以单次同主机 HTTP `307` 临时重定向连接基础路径健康处理器，kubelet（节点代理）按官方契约跟随同主机重定向。出站只显式放行 CoreDNS（集群域名服务）的 53/UDP、53/TCP，以及排除私网和链路本地地址后的公网 IPv4 443/TCP。

标准 NetworkPolicy（网络策略）不能按域名建立可靠 allowlist（允许名单）；当前 443 规则比 DeepSeek/Voyage 两个供应商域名更宽。它也不能保证阻止到所在节点的流量，策略是否实际执行取决于 K3s（轻量 Kubernetes）的网络插件。后续若必须按域名约束，应单独审核 egress proxy（出站代理），不能把当前规则描述成域名隔离。

## Task 16-17（任务 16-17）公网入口与真实身份非敏感实施证据

2026-07-31 经分阶段生产授权完成以下验收：

- cert-manager（证书管理器）固定为 `v1.21.0`，官方静态清单 SHA-256（安全哈希算法）为 `6e499c3f1ab356abe79a7853911f80cb09c213885bfdf81092fdff142ba63c4a`；controller、cainjector、webhook（控制器、证书注入器、回调服务）均为 `1/1` 可用且零重启，六个 CRD（自定义资源定义）均已建立，回调 CA（证书颁发机构）注入完成。
- 公网 80 开放后，Let’s Encrypt staging（预发布证书颁发机构）的 `CertificateRequest`（证书请求）为 `Ready=True`、`Order`（订单）为 `valid`，证书 IP SAN（主题备用名称）精确为 `120.46.57.214`。随后 production（生产）证书由 `YR1` 签发，生效时间为 `2026-07-31T13:40:56Z`、到期时间为 `2026-08-07T05:40:55Z`、自动续期时间为 `2026-08-05T00:52:55Z`。
- 唯一默认 TLSStore（传输层安全证书仓库）、每分钟 120 次且突发 40 次的速率限制、16 个并发限制、256 KiB 请求体限制和唯一语义路径 IngressRoute（入口路由）已应用。公网 HTTPS（加密超文本传输协议）应用路径返回 `200` 且证书校验成功，HTTPS 根路径和明文 HTTP 应用路径均返回 `404`；未登录管理接口返回 `401`。
- 生产 Auth.js（认证框架）提供器公布的 callback（回调）精确为 `https://120.46.57.214/k8s-yaml-assistant/api/auth/callback/github`，页面登录按钮也会直接进入 GitHub 授权链。已有会话曾显示 `kkxiaoa` 管理员入口并成功读取 `sleep` 状态，但真实回调重复尝试中有 5 次在 OAuth token exchange（开放授权令牌交换）阶段触发 `outgoing request timed out after 3500ms`；因此不能据已有会话宣称完整回调验收成功。五个认证环境变量均存在、长度符合当前契约且无首尾空白，Pod（容器组）对 `github.com` 和 `api.github.com` 的无凭据 HEAD（仅读取响应头）请求均为 `200`，阻断已定位为固定 `openid-client 5.7.1`（开放身份客户端 5.7.1 版）的 3.5 秒默认出站超时。本地修复候选通过 Provider（身份提供器）的既有 `httpOptions` 契约把超时固定为 15 秒，未增加重试、代理、环境变量或平行抽象；定向测试、完整测试、类型检查和生产构建均通过。该候选尚未进入生产，OAuth（开放授权）尝试未写入控制库身份或令牌，请求账本仍为 `0`。
- 应用和 cert-manager（证书管理器）全部 Pod（容器组）保持零重启，生产镜像摘要保持 `sha256:ebfdefd9c2e057891eeb3b4b70cd3d823e7b75b67b8d62f9227bc128931cdaba`。本次没有模型调用、索引重建、baseline（基线）晋升或节点重启；`MODEL_ACCESS_ENABLED=false` 和 `sleep` 继续构成两层独立费用关闭边界。

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
- 因跨境 GHCR（GitHub 容器镜像仓库）冷拉取过慢且 SWR（华为云容器镜像服务）企业版仍待审批，本次在 Publish（正式发布）前把精确 `linux/amd64` 镜像制作为保留根摘要的 OCI archive（开放容器镜像归档），校验 SHA-256（安全哈希算法）`86766515ef4793329808f60747dfce4a50c43e610e1cbaeafbc7f06aa535ff29` 后经 SSH（安全远程登录）传输并由 `k3s ctr images import` 导入。临时认证文件和两端归档已删除，节点保留生产所需的已导入内容；这是 `v0.1.1` 的历史一次性实施证据。
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

## Publish（正式发布）前镜像预热

SWR（华为云容器镜像服务）企业版可用前，应用和回滚 Draft Release（草稿发布版本）统一使用仓库内的 `scripts/k3s-image-preheat.sh`。脚本是发布前缓存预热入口，不承担完整发布身份授权；应用草稿从 `release-manifest.json` 读取镜像根摘要，回滚草稿从规范标签 `rollback-vX.Y.Z-sha256-<64 位十六进制摘要>-r<运行号>` 读取镜像根摘要。

执行顺序固定为：

1. 由 Release lifecycle（发布生命周期）生成应用草稿及六项证据，或由 rollback candidate workflow（回滚候选流水线）生成规范回滚草稿；
2. 维护者人工核对对应草稿的正文、目标提交或来源标签、镜像摘要和现有证据，并确认实际标签仍不存在；
3. 获得本次生产节点镜像导入授权后，在仓库根目录传入目标草稿标签：

   ```bash
   KYA_DRAFT_TAG='vX.Y.Z'
   bash scripts/k3s-image-preheat.sh "$KYA_DRAFT_TAG"
   ```

   回滚时把 `KYA_DRAFT_TAG` 替换为该草稿页面显示的完整规范回滚标签。

4. 只有脚本输出 K3s（轻量 Kubernetes）已按目标根摘要完成预热，且两端临时归档已清理，才进入单独的 Publish（正式发布）确认；
5. 脚本失败时保留草稿并停止。不得用可变标签、服务器直接跨境拉取、手工替换摘要或跳过根摘要回读继续发布。

脚本只接受尚未发布且不是 Pre-release（预发布）的 `vX.Y.Z` 应用草稿或规范回滚草稿；它固定仓库、镜像、生产节点和 SSH（安全远程登录）密钥路径，在本机使用 Skopeo（容器镜像复制工具）或固定摘要的 Skopeo 容器生成 OCI（开放容器镜像）归档，校验传输哈希后导入 K3s（轻量 Kubernetes），并回读同一根摘要引用。回滚草稿的来源发布、provenance（来源证明）和部署台账仍由 Publish（正式发布）后的部署流水线完整校验，不在预热脚本中重复实现。该操作不修改 Deployment（工作负载）、不创建 Git tag（Git 标签）、不触发发布流水线，也不构成 Publish（正式发布）或部署授权；同区域镜像分发可用后应重新审核是否下线该步骤。

## 非破坏性回退

如果试运行、字段冲突或实际应用失败，立即停止后续 Secret（密钥）和应用版本步骤，保留 Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）以便诊断。不要使用强制字段接管，也不要删除有状态资源。

需要恢复普通配置时，从独立、干净的上一份已审核的 bootstrap（引导配置）目录先运行同样的服务端试运行和 `diff`（差异），再由相同 `k8s-yaml-assistant-bootstrap` 字段所有者重新应用。PVC（持久卷声明）的不可变字段冲突时停止并重新审核；不通过删除 PVC（持久卷声明）实现“回退”。应用版本部署失败由固定适配器按成功台账自动恢复上一镜像摘要，不直接修改 Deployment（工作负载）或绕过台账。

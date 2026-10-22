# Kubernetes deployment manifests

本目录保存 K8s YAML Authoring Copilot（K8s YAML 编写辅助）的非敏感 Kubernetes（容器编排系统）资源、不可变镜像模板和公开入口。仓库只提交 Secret（密钥）引用，不保存 Secret 值。

## 目录职责

| 目录 | 资源边界 |
| --- | --- |
| `bootstrap/` | Namespace（命名空间）、ServiceAccount（服务账户）、ConfigMap（普通配置）、Service（服务）、PVC（持久卷声明）和 NetworkPolicy（网络策略） |
| `app/` | 只允许部署适配器替换镜像摘要的 Deployment（工作负载）模板 |
| `access/` | 正式域名的独立 Issuer / Certificate（签发者 / 证书）、Traefik（入口控制器）路由、HTTPS 重定向和流量限制 |
| `tls/` | 共享 IP 入口的签发者、证书和默认 TLSStore（传输层安全证书仓库）；由仍使用它们的入口共同依赖 |

bootstrap（引导配置）只管理不随应用版本变化的资源。应用版本由受限部署适配器把 `app/deployment-template.yaml` 中的唯一镜像标记替换为：

```text
ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:<64-hex>
```

入口和证书由各自的 Kubernetes field manager（字段管理器）维护，不由镜像替换适配器隐式修改。

## Secret（密钥）边界

部署模板只引用以下职责，不包含实际值：

- DeepSeek 与 Voyage AI 的运行时凭据；
- GHCR（GitHub 容器镜像仓库）只读拉取凭据；
- GitHub OAuth 2.0（GitHub 开放授权 2.0）、会话、管理员身份和主体匿名化密钥。

Secret（密钥）必须从仓库外的密码管理器通过受控输入创建或轮换。不要在命令参数、GitHub Actions（自动化流水线）日志、YAML、环境转储或测试夹具中输出值。轮换注入为环境变量的 Secret（密钥）后，需要单独授权滚动替换工作负载。

## 存储与网络

- 观测数据和体验控制状态使用独立 PVC（持久卷声明）与独立挂载路径；
- 应用以非 root（超级用户）身份、只读根文件系统和受限 Linux capability（Linux 权能）运行；
- NetworkPolicy（网络策略）限制应用入站，并只允许 DNS（域名系统）和必要的 HTTPS（加密超文本传输协议）出站；
- GitHub OAuth（GitHub 开放授权）出站经固定代理端点转发，NetworkPolicy（网络策略）只允许应用访问该端点的 TCP/3128，模型供应商请求保持直连；
- 该策略不是完整互联网隔离承诺，仍需集群网络插件和外层防火墙共同执行；
- 公开入口只匹配 `yaml.kubesmith.cloud`，应用位于根路径 `/`；明文 HTTP（超文本传输协议）重定向到同一域名的 HTTPS（加密超文本传输协议），IP 和其他 Host（主机名）不匹配应用路由。

## 出站代理证书信任

`HTTPS_PROXY` 使用固定端点的 HTTPS（加密超文本传输协议）地址；`NODE_USE_ENV_PROXY=1` 启用 Node 原生环境代理，`NO_PROXY` 保留集群内部地址及模型供应商直连。不要设置冲突的小写代理变量、关闭证书校验或绕过 GitHub 的代理路径。

安装者管理 `k8s-yaml-assistant-prod/k8s-yaml-assistant-proxy-trust` ConfigMap（配置对象），只保存 `proxy.crt`。它是代理专用自签服务端证书的公开部分，不是私钥，也不是公共 CA（证书颁发机构）签发的证书。通过受信通道取得证书后，核对批准的指纹、代理 IP SAN（IP 身份）、有效期、`CA:false` 与服务端认证用途；不要把代理私钥、真实证书或证书占位内容写入仓库和镜像。

在固定 K3s 节点、确认集群及证书身份后，首次创建命令为：

```bash
sudo k3s kubectl -n k8s-yaml-assistant-prod create configmap \
  k8s-yaml-assistant-proxy-trust \
  --from-file=proxy.crt=/usr/local/share/ca-certificates/containerd-egress-proxy.crt
```

对象已存在时先核对归属和内容，再单独批准更新；不要删除重建来绕过冲突。Deployment（工作负载）只投影该 key，以只读目录挂载到 `/app/trust/egress-proxy`，不使用 `subPath`（子路径挂载），并显式设置 `NODE_EXTRA_CA_CERTS=/app/trust/egress-proxy/proxy.crt`。证书文件须允许运行用户 UID 10001 读取。对象或 key 缺失时卷挂载失败；文件内容错误则可能只产生 Node 警告，不能以进程存活或 Pod Ready（容器组就绪）代替信任验证。

`NODE_EXTRA_CA_CERTS` 向 Node 进程的默认公共根追加信任，不是仅绑定代理连接的配置。保持代理和隧道内目标的证书链、有效期及身份校验，不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不覆盖公共根。Node 只在进程启动时加载额外证书，更新 ConfigMap 不会使运行中的进程重新加载。

安装前私有备份现有配置及服务器固定模板。先准备证书 ConfigMap，再由安装者更新 `/etc/k8s-yaml-assistant-deployer/deployment-template.yaml` 与 HTTPS 代理配置；模板须保持正确属主、普通文件及禁止组 / 其他用户写入的权限。仓库模板不会由发布自动复制到服务器，也不能直接应用含镜像占位符的模板。首次接入通过下一正式签名发布使新模板与新进程生效。

验证应覆盖非 root（非超级用户）的证书文件可读性、原生 `https.request` 与 `fetch` 的代理连接、错误身份 / 不可信证书拒绝及真实 GitHub 登录。代理握手与隧道内目标验证都成功，才说明信任接线有效；健康检查不执行外部 OAuth（开放授权）往返。

适配器自动恢复使用当前模板替换旧镜像，不恢复 ConfigMap 或旧模板；同一已部署发布重放会直接返回 `already_applied`。配置故障需由安装者按核定备份成套恢复，保全现有部署账本，不靠重放发布或删除操作记录恢复；代理仍为 HTTPS 监听时，改回 HTTP 不是有效回退。

证书轮换须单独批准：先为应用和节点 containerd 准备新旧证书兼容信任并启动新进程，再切换代理证书，验证后移除旧信任并再次重启。共享代理与节点信任的变更由各自管理边界执行，不能从应用部署授权推导；证书到期监测不等于自动续期。

## 正式域名与认证

应用镜像、入口和认证配置构成同一部署包：

| 输入 | 固定值 |
| --- | --- |
| 应用地址 | `https://yaml.kubesmith.cloud/` |
| `NEXTAUTH_URL` | `https://yaml.kubesmith.cloud/api/auth` |
| `APP_PUBLIC_ORIGIN` | `https://yaml.kubesmith.cloud` |
| GitHub OAuth callback（开放授权回调） | `https://yaml.kubesmith.cloud/api/auth/callback/github` |
| 独立 TLS Secret（证书密钥引用） | `k8s-yaml-assistant-prod/k8s-yaml-assistant-tls` |

Next.js 的基础路径在构建时确定，不能只修改入口来切换已有子路径镜像。健康检查直接访问 `/api/health/live` 与 `/api/health/ready`，无需重定向。会话和匿名体验 Cookie（浏览器凭据）只属于当前主机，路径为 `/`，不跨子域共享。更换来源需要重新登录；旧来源的匿名体验身份和浏览器草稿不会跨来源搬迁，登录用户的服务端额度账本仍保存在原控制库。

安装者须先核对以下前置条件，再单独批准入口切换：

1. `yaml.kubesmith.cloud` 的 A 记录指向固定入口，80/443 可达；没有经验证的 IPv6 入口时不要添加 AAAA。备案服务范围须覆盖该域名，页脚服务号链接到工信部备案系统。
2. cert-manager（证书管理器）和 Traefik（入口控制器）支持仓库声明的 API；实际 NetworkPolicy（网络策略）允许 HTTP-01 验证 Pod 接收入口流量。不要把应用标签添加到 solver（验证服务）Pod，或为签发放宽应用入站。
3. 由安装者分别应用 `access/domain-issuer.yaml` 与 `access/domain-certificate.yaml`，等待 `Certificate/k8s-yaml-assistant` 就绪，核对唯一域名、证书链与到期时间。它们只管理本 Namespace（命名空间）的独立证书，不修改 `tls/` 下的共享资源。
4. 私有备份原配置和控制库，核定可恢复性；绑定正式签名 Release（发布版本）的镜像摘要与原索引身份。OAuth（开放授权）回调、`bootstrap/config-map.yaml`、两个精确 Host 路由和根路径镜像须在同一维护窗口成套切换，镜像仍通过受限适配器部署。不要用 `kubectl apply -f access/` 代替分步签发与切换。
5. 验证根路径、静态资源、健康响应、登录 / 退出、来源与 CSRF（跨站请求伪造）拒绝、额度连续性和 SSE（服务器发送事件）；核对 IP / 未知 Host 无法访问本应用，其他站点不受影响。模型请求需要独立预算。

回退也必须成套处理镜像、配置、认证回调和正式域名路由，保全控制库中的新增账本；不得只回退镜像、清空额度或自动恢复 IP 入口。共享 IP Certificate / Issuer / TLSStore（证书 / 签发者 / 证书仓库）须保留到全部实际消费者退役并单独获准删除。证书自然续期需要持续监测，首次签发不等于续期验证。

## 发布与部署

正式 Release（发布版本）先在 GitHub 托管 runner（运行器）上验证标签、镜像根摘要、发布清单、SBOM（软件物料清单）、SLSA provenance（供应链来源证明）和 Sigstore（无密钥签名）证明，再创建有界部署授权。

生产 self-hosted runner（自托管运行器）不检出仓库源码，只把已签名且有大小上限的授权请求交给 root-owned adapter（超级用户所有的适配器）。适配器只接受固定镜像仓库、固定模板、离线证明和唯一部署动作。Pull Request（合并请求）代码不会发送到生产 runner（运行器）。

## 本地校验

```bash
npm run deploy:check
npm run workflow:check
```

这些命令只读取仓库文件，不连接生产、不调用模型、不构建索引。实际发布、部署、入口变更、证书变更和 Secret（密钥）轮换都需要独立运维授权。

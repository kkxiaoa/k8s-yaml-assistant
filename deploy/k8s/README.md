# Kubernetes deployment manifests

本目录保存 K8s YAML Authoring Copilot（K8s YAML 编写辅助）的非敏感 Kubernetes（容器编排系统）资源、不可变镜像模板和公开入口。仓库只提交 Secret（密钥）引用，不保存 Secret 值。

## 目录职责

| 目录 | 资源边界 |
| --- | --- |
| `bootstrap/` | Namespace（命名空间）、ServiceAccount（服务账户）、ConfigMap（普通配置）、Service（服务）、PVC（持久卷声明）和 NetworkPolicy（网络策略） |
| `app/` | 只允许部署适配器替换镜像摘要的 Deployment（工作负载）模板 |
| `access/` | Traefik（入口控制器）的 HTTPS（加密超文本传输协议）路由、HTTP（超文本传输协议）重定向和流量限制 |
| `tls/` | cert-manager（证书管理器）的签发者、证书和默认 TLSStore（传输层安全证书仓库） |

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
- 公开入口只服务 `/k8s-yaml-assistant` 基础路径，明文 HTTP（超文本传输协议）重定向到 HTTPS（加密超文本传输协议）。

## 发布与部署

正式 Release（发布版本）先在 GitHub 托管 runner（运行器）上验证标签、镜像根摘要、发布清单、SBOM（软件物料清单）、SLSA provenance（供应链来源证明）和 Sigstore（无密钥签名）证明，再创建有界部署授权。

生产 self-hosted runner（自托管运行器）不检出仓库源码，只把已签名且有大小上限的授权请求交给 root-owned adapter（超级用户所有的适配器）。适配器只接受固定镜像仓库、固定模板、离线证明和唯一部署动作。Pull Request（合并请求）代码不会发送到生产 runner（运行器）。

## 本地校验

```bash
npm run deploy:check
npm run workflow:check
```

这些命令只读取仓库文件，不连接生产、不调用模型、不构建索引。实际发布、部署、入口变更、证书变更和 Secret（密钥）轮换都需要独立运维授权。

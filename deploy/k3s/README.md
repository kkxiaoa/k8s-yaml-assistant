# K3s host configuration

本目录保存单节点 K3s（轻量 Kubernetes）的非敏感配置契约，不包含安装器、二进制、镜像归档、kubeconfig（客户端配置）、服务端令牌、备份对象、云凭据或主机实施日志。

## 文件

| 文件 | 作用 |
| --- | --- |
| `config.yaml` | 固定 kubeconfig（客户端配置）权限、Secret（密钥）静态加密、网络实现、Pod / Service CIDR（容器组 / 服务网段）和准入配置路径 |
| `admission-config.yaml` | 对普通 Namespace（命名空间）执行固定版本的 restricted Pod Security（受限容器组安全）策略，只豁免 `kube-system` |

## 安全边界

- `write-kubeconfig-mode` 固定为 `0600`；
- `secrets-encryption` 必须开启；
- 内置 NetworkPolicy controller（网络策略控制器）保持开启；
- Pod Security Admission（容器组安全准入）的 enforce / audit / warn（执行 / 审计 / 警告）均固定为 `restricted`；
- 不在配置中保存 token（令牌）、外部 datastore（数据存储）凭据或公网监听放宽；
- 单节点 SQLite（嵌入式数据库）拓扑不承诺高可用。

云安全组、SSH（安全远程登录）、主机补丁、备份恢复和 K3s（轻量 Kubernetes）升级属于仓库外运维边界。它们必须在独立授权和受控维护窗口中完成，不能从本目录推断当前生产状态。

## 本地校验

```bash
npm run deploy:check
```

该门禁解析真实 YAML，检查固定配置、准入策略、应用清单和部署适配器的权限边界；它不连接服务器或 Kubernetes（容器编排系统），也不修改生产。

版本升级必须同时审核 `config.yaml`、`admission-config.yaml`、应用 Namespace（命名空间）的 Pod Security（容器组安全）版本和部署契约测试，不能跟随浮动通道自动升级。

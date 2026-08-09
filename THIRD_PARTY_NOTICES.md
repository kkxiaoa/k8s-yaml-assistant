# Third-party notices

## Generated Kubernetes schemas

`data/schemas/generated/` 包含从集群 OpenAPI（开放应用程序接口规范）快照归一化并审核提交的 Schema（模式定义）精选闭包。当前闭包包含来自以下上游项目的 API（应用程序接口）结构和字段说明：

| 上游项目 | 项目地址 | 许可证 |
| --- | --- | --- |
| Kubernetes | <https://github.com/kubernetes/kubernetes> | Apache License 2.0 |
| cert-manager | <https://github.com/cert-manager/cert-manager> | Apache License 2.0 |
| Kubernetes Gateway API（网关应用程序接口） | <https://github.com/kubernetes-sigs/gateway-api> | Apache License 2.0 |
| Kubernetes CSI external-snapshotter（外部快照控制器） | <https://github.com/kubernetes-csi/external-snapshotter> | Apache License 2.0 |

这些文件经过格式归一化和精选闭包裁剪；仓库中的旧生成清单没有记录每个上游组件的精确版本，因此不得把快照日期或当前集群版本解释为上游版本证明。更新 Schema（模式定义）时，应同时更新可追溯来源与本通知。

## Kubernetes 官方文档

`data/knowledge/kubernetes-docs/` 包含 Kubernetes 官方网站简体中文文档的版本固定快照。当前来源如下：

| 文档 | 上游版本 | 上游路径 | 许可证 |
| --- | --- | --- | --- |
| 资源配额 | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/policy/resource-quotas.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |

版权所有者为 Kubernetes 文档贡献者。仓库保存字节一致的上游简体中文 Markdown（标记语言）文件；运行时删除上游为翻译维护保留的英文 HTML（超文本标记语言）注释，只提取 manifest（清单）明确选择的中文章节，添加规范化标题、来源锚点和适用目标。未选择的配置示例不会进入 `docs` 知识源。

## Runtime and development dependencies

JavaScript（脚本语言）依赖及其许可证记录在 `package-lock.json`，发布产物还包含机器可读的 SBOM（软件物料清单）。各依赖仍受其各自许可证约束；本项目的 Apache License 2.0 不替代第三方许可证。

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
| 限制范围 | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/policy/limit-range.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| ConfigMap | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/configuration/configmap.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| Deployment | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/workloads/controllers/deployment.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| HorizontalPodAutoscaler | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| StatefulSet | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/workloads/controllers/statefulset.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| 容器镜像 | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/containers/images.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| Pod 卷 | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/storage/volumes.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |
| StorageClass | `kubernetes/website@7eae8915497224dd9ba4803a8ebd0efec33b303b` | `content/zh-cn/docs/concepts/storage/storage-classes.md` | [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) |

版权所有者为 Kubernetes 文档贡献者。仓库保存字节一致的上游简体中文 Markdown（标记语言）文件；运行时删除上游为翻译维护保留的英文 HTML（超文本标记语言）注释，只提取 manifest（清单）明确选择的中文章节，添加规范化标题、来源锚点和适用目标。未选择的配置示例不会进入 `docs` 知识源。

## Kubernetes 官方 YAML 示例

`data/knowledge/kubernetes-examples/` 包含同一固定 `kubernetes/website` 提交中的八份 YAML（配置文件）示例：ResourceQuota、LimitRange、ConfigMap、Deployment、Pod、StatefulSet、PersistentVolumeClaim 和 StorageClass。快照保持上游字节一致；数据提供器验证 Git blob（版本对象）、资源身份、`metadata.name` 和清单声明的目标路径后，以 `example` 来源提供带代码围栏的配置参考。StatefulSet 上游快照同时包含 Service，摄取边界只提取其中唯一匹配清单身份的 StatefulSet 文档。

这些示例同样由 Kubernetes 文档贡献者按 [CC-BY-4.0](https://github.com/kubernetes/website/blob/7eae8915497224dd9ba4803a8ebd0efec33b303b/LICENSE) 提供。本项目只添加固定版本来源信息、规范化标题与适用目标，不把示例解释为本项目自行创作，也不使用它替代当前集群 schema（模式定义）的合法性事实。

## Highlight.js

代码围栏语法高亮使用 [Highlight.js](https://highlightjs.org/) `11.11.1`，按 BSD-3-Clause（三条款 BSD 许可证）提供：

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Runtime and development dependencies

JavaScript（脚本语言）依赖及其许可证记录在 `package-lock.json`，发布产物还包含机器可读的 SBOM（软件物料清单）。各依赖仍受其各自许可证约束；本项目的 Apache License 2.0 不替代第三方许可证。

# Kubernetes 官方 YAML 示例快照

本目录保存 Kubernetes 官方网站仓库中的版本固定 YAML（配置文件）快照，作为 `example` 知识源的数据提供器输入。

`manifest.json` 固定 `kubernetes/website` 的精确提交、每份上游快照的 Git blob（版本对象）、CC-BY-4.0（知识共享署名 4.0）许可证、标题和适用目标。数据提供器先验证字节身份，再解析一次 YAML 并确认资源身份、`metadata.name` 和目标路径，最后用带来源信息的代码围栏构造 `example` 检索片段。

示例用于配置参考，不声明字段一定被当前集群 schema（模式定义）接受，也不覆盖组织策略。当前只摄取有现有评估消费者的 ResourceQuota、LimitRange、ConfigMap、Deployment、Pod、StatefulSet、PersistentVolumeClaim 和 StorageClass 示例；目录中的覆盖范围不代表产品承诺支持全部 Kubernetes 资源。上游文件包含多个 YAML 文档时，数据提供器只接受目标资源身份唯一匹配的文档，歧义输入会被拒绝。

更新流程：

1. 选择并审核 `kubernetes/website` 的精确提交与完整 YAML 文件。
2. 使用字节一致的上游文件替换本地快照。
3. 更新提交、Git blob（版本对象）、许可证链接和捕获时间。
4. 审核资源身份、目标路径和最终检索片段。
5. 运行 provider（数据提供器）测试与评估契约门禁。
6. 人工审核通过后重建索引并定向复测。

署名与再分发条款记录在 `THIRD_PARTY_NOTICES.md`。

# Kubernetes 官方文档快照

本目录保存 Kubernetes 官方网站简体中文文档的版本固定快照，作为 `docs` 知识源的数据提供器输入，不保存索引、评估产物或项目路线状态。

`manifest.json` 固定 `kubernetes/website` 的精确提交、每份上游 Markdown（标记语言）快照的 Git blob（版本对象）、CC-BY-4.0（知识共享署名 4.0）许可证、引用锚点和规范知识目标。数据提供器先校验原文身份，再删除简体中文源文件中供翻译维护使用的英文 HTML（超文本标记语言）注释，最后只把清单选中的中文章节写入 `docs` 语料。

当前清单选择以下与 YAML 编写问题直接对应的章节：

- ResourceQuota 的基础设施资源配额；
- LimitRange 的资源限制、默认请求与准入语义；
- ConfigMap 的不可变更语义；
- Deployment 选择算符与 Pod 模板标签约束；
- Pod 镜像拉取策略及默认规则。

上游原文中的其他章节和代码样例不会自动进入 `docs` 语料；完整 YAML 示例由 `data/knowledge/kubernetes-examples/` 的独立数据提供器维护。

更新流程：

1. 选择并审核 `kubernetes/website` 的精确提交。
2. 使用字节一致的上游简体中文文件替换本地快照。
3. 更新提交、Git blob（版本对象）、许可证链接和捕获时间。
4. 审核章节标题、锚点、目标和最终提取的中文检索片段。
5. 运行测试与 `npm run eval:check`。
6. 重建索引并在发布前核对语料、模型和索引格式身份。

署名与再分发条款记录在 `THIRD_PARTY_NOTICES.md`。

# Generated schemas

本目录由 `ingest:schemas` 从 Kubernetes OpenAPI v3（开放应用程序接口规范版本 3）或 CRD（自定义资源定义）归一化生成，采用 registry（注册表）布局：

- `resources/*.json`：资源入口，保留原始 `$ref`；
- `definitions/*.json`：共享 OpenAPI（开放应用程序接口规范）定义；
- `manifest.json`：生成时间和输出数量。

生成示例：

```bash
npm run ingest:schemas -- --source kubernetes --input openapi.json
npm run ingest:schemas -- --source crd --input path/to/resource.yaml
npm run ingest:schemas -- --source cluster-discovery --out data/schemas/generated
```

每个输出目录是一份完整快照。再次写入时，工具只删除上一份受管清单拥有、当前快照不再生成的直接子级 JSON（数据交换格式）文件；不会认领或覆盖来源不明的同名文件。

完整集群快照默认被 `.gitignore` 排除。仓库只通过强制跟踪保留 `data/schemas/curated.json` 所选资源及其 `$ref` 传递闭包，使克隆后的源码可以在不连接集群的情况下构建语料：

```bash
npm run corpus:closure
npm run corpus:closure -- --list
```

上游来源与许可证见根目录 `THIRD_PARTY_NOTICES.md`。更新生成快照时必须同步核对精选闭包、来源和许可证。

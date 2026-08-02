# Generated schemas

本目录是经审核并提交的精选 Schema（模式定义）闭包，采用 registry（注册表）布局：

- `resources/*.json`：资源入口，保留原始 `$ref`；
- `definitions/*.json`：共享 OpenAPI（开放应用程序接口规范）定义；

`ingest:schemas` 生成的完整快照还包含 `manifest.json`，用于声明工具拥有的文件。该清单不属于仓库中的精选闭包。

生成示例：

```bash
npm run ingest:schemas -- --source kubernetes --input openapi.json --out data/schemas/snapshots/kubernetes
npm run ingest:schemas -- --source crd --input path/to/resource.yaml --out data/schemas/snapshots/example-crd
npm run ingest:schemas -- --source cluster-discovery --out data/schemas/snapshots/cluster
```

`--out` 必须显式提供，并指向空目录或由上一份 `manifest.json` 明确拥有的目录。再次写入时，工具只删除上一份清单拥有、当前快照不再生成的直接子级 JSON（数据交换格式）文件；不会认领或覆盖来源不明的同名文件。

完整快照默认被 `.gitignore` 排除。维护者审核来源后，只把 `data/schemas/curated.json` 所选资源及其 `$ref` 传递闭包更新到本目录，使克隆后的源码可以在不连接集群的情况下构建语料：

```bash
npm run corpus:closure
npm run corpus:closure -- --list
```

上游来源与许可证见根目录 `THIRD_PARTY_NOTICES.md`。更新生成快照时必须同步核对精选闭包、来源和许可证。

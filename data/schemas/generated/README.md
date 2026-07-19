# Generated Schemas

由 `ingest:schemas` 从 K8s OpenAPI v3 生成的规范化 schema,采用 registry 布局:

- `resources/*.json` —— 资源入口(`${group}.${version}.${kind}.json`),保留原始 `$ref`。
- `definitions/*.json` —— OpenAPI definition registry,运行时本地解析 `$ref`(不请求网络)。
- `manifest.json` —— 版本、生成来源、时间，以及 `ingest-schemas` 明确拥有的资源和定义文件。

生成方式:

```bash
npm run ingest:schemas -- --source kubernetes --input openapi.json   # 官方 OpenAPI spec
npm run ingest:schemas -- --source cluster-discovery                  # 连集群自动发现
npm run ingest:schemas -- --source crd --input path/to/my-crd.yaml    # 单个 CRD
```

每个输出目录是一份完整生成快照。再次写入时只删除上一份 manifest（清单）拥有、当前快照不再生成的直接子级 JSON 文件；README、未归属文件和其他目录不会被删除。未归属文件与新目标同名时直接失败，不会静默覆盖。

旧版只含数量的 manifest（清单），或没有清单但已含 JSON 的目录，不会被自动认领。迁移时先使用空的临时 `--out` 目录生成并审核，再显式替换目标目录。

## Git 跟踪范围:只跟踪 curated 白名单闭包

全量 generated(约 1300 资源 / 73MB)在 `.gitignore` 中被整目录忽略。**只有 curated 白名单的传递闭包**
(白名单资源 + 它们 `$ref` 递归依赖到的 definitions,约 266 文件 / 0.5MB)被 `git add -f` 显式跟踪进仓库。

这样仓库自包含、可复现、体积可控:clone 下来即可构建 CORPUS,无需重新 ingest 或连集群。

维护(往 `curated.json` 加资源后):

```bash
npm run corpus:closure            # 查看闭包统计
npm run corpus:closure -- --list | xargs git add -f   # 同步跟踪范围
```

上线态:CI 从该闭包 `index:build` 出向量索引烤进镜像;运行时只加载索引,不 ingest、不重嵌。

# K8s YAML Authoring Copilot

面向 Kubernetes YAML 编写场景的 AI 辅助工具。当前阶段不做泛化 K8s 运维助手,重点解决用户在编辑器里写 YAML 时的四类任务:

- 解释字段和当前配置
- 检查并修复 YAML
- 根据自然语言生成资源 YAML
- 给出可追溯的答案依据


## 当前能力

| 能力 | 入口 | 状态 |
|------|------|------|
| 编辑器内 YAML 编写 | `npm run dev` | ✅ |
| 检查与修复 | Web `/api/check`、`/api/fix`;CLI `npm run check` | ✅ |
| 生成资源 YAML | Web `/api/generate`;CLI `npm run gen` | ✅ |
| 上下文化问答 | Web `/api/ask` | ✅ |
| 答案依据展示 | SSE `sources` + 前端“答案依据” | ✅ |
| 检索评估 | `npm run eval` | 契约已纠偏，待重跑 full baseline |
| Grounded Answer / Judge 评估 | `npm run eval:faith`、`npm run eval:judge` | 契约已纠偏，待重跑 calibration/baseline |
| Generation / Fix 评估 | `npm run eval:gen`、`npm run eval:fix` | evaluator 已纠偏，待重跑 full baseline |
| schema ingestion 骨架 | `npm run ingest:schemas` | ✅ |

## Web 使用

```bash
npm install
# 创建 .env，填入 DEEPSEEK_API_KEY 和 VOYAGE_API_KEY
npm run dev
```

打开 Next.js 输出的本地地址,默认通常是:

```text
http://localhost:3000
```

如果端口被占用,Next.js 会自动切到下一个可用端口。

Web 端当前包含:

- Monaco YAML 编辑器
- `生成资源`
- `检查与修复`
- `解释当前配置`
- `答案依据`

问答请求会携带当前 YAML、`kind`、`apiVersion`、选中文本、光标路径和校验错误,用于更贴近当前编辑上下文地检索与回答。

## CLI 使用

```bash
# 字段问答
npm run ask -- "reclaimPolicy 能填哪些值?默认是什么?"
npm run ask -- "怎么允许 PVC 扩容?"

# YAML 检查
npm run check -- examples/storageclass-invalid.yaml
npm run check -- examples/storageclass-valid.yaml

# 生成 + 自检修正闭环
npm run gen -- "用 AWS EBS CSI、保留策略、延迟绑定、允许扩容的 StorageClass,名字 prod-ssd"

# 单测
npm test
```

## 核心架构

```text
data/schemas/generated/resources/*.json
data/schemas/generated/definitions/*.json
data/schemas/curated.json
data/policies.json
data/aliases/schema-field-aliases.jsonl
        ↓
src/knowledge/{schemas,schema-corpus,policy-corpus,corpus}.ts
        ↓
src/retrieval/{exact-field,query-expansion,retrieve,router,rerank}.ts
        ↓
src/server/pipeline.ts
        ↓
app/api/{ask,check,fix,generate}
        ↓
app/ Monaco Web UI
```

关键设计:

- schema 是字段事实层,同时服务问答语料和 YAML 校验。
- policy 是组织约束层,在 Ask 中与 schema 分层表达,不冒充 schema validation。
- `curated.json` 控制当前训练语料范围;不再读取 `data/schemas/*.json` 手写 fixture。
- `resources/` 保存资源入口 schema,`definitions/` 保存 OpenAPI `$ref` registry,运行时本地解析引用,不请求网络。
- reviewed alias 为中文问题补充真实英文字段术语,serving 与 eval 共用同一 query expansion。
- 问答返回 SSE:先发送 `sources`,再发送答案 `delta`。
- 检索会结合用户问题、当前资源、光标字段、选中文本和校验错误。
- 生成和修复通过 agentic loop 执行“生成/修复 → schema 校验 → 再修正”。

## Schema Ingestion

不要靠手动 import 或根目录 fixture 扩展资源覆盖。项目支持把外部 schema 标准化生成到:

```text
data/schemas/generated/
  resources/
  definitions/
  manifest.json
```

系统不再回退到 `data/schemas/*.json` fixture。缺少 generated 产物时会直接失败,应重新运行 ingestion。

示例:

```bash
# 从 CRD YAML 生成 SchemaDoc
npm run ingest:schemas -- --source crd --input examples/my-crd.yaml

# 从 Kubernetes OpenAPI JSON 生成内置资源 SchemaDoc
npm run ingest:schemas -- --source kubernetes --input openapi.json

# 从集群 OpenAPI 导出的 JSON 生成 SchemaDoc
npm run ingest:schemas -- --source cluster --input openapi.json

# 从当前 kubeconfig 指向的集群拉取完整 OpenAPI v3 discovery
npm run ingest:schemas -- --source cluster-discovery --out data/schemas/generated
```

标准化后的数据结构:

```ts
interface SchemaDoc {
  resource: string;
  apiVersion: string;
  group?: string;
  version?: string;
  kind: string;
  schema: SchemaNode;
  source: 'builtin' | 'cluster' | 'crd';
}
```

`resources/*.json` 保留资源 schema 入口,`definitions/*.json` 保留如 `io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta`、`io.k8s.api.core.v1.PodSpec` 这类共享 definition。应用运行时通过本地 registry 解析 `$ref`,避免把通用 schema 复制进每个资源文件。

## 评估与验证

### 本地质量门禁

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval:check
npm run build
```

这些命令不调用模型、embedding 或 rerank。`npm run build` 使用 `next/font`，首次构建可能访问 Google Fonts。

### Eval 调用与成本边界

| 命令 | 外部调用 | 用途与边界 |
|---|---|---|
| `npm run eval` | Voyage embedding、rerank；index miss 时会重建全量 corpus embedding | full semantic retrieval eval |
| `npm run eval:faith` | Voyage embedding/rerank；DeepSeek 回答与 judge | full Grounded Answer eval |
| `npm run eval:faith -- <N>` / `--policy` | 同上 | smoke/policy 子集，只用于诊断，不可晋升 baseline |
| `npm run build:calibration` | 无 | 从已完成的非 smoke faith run/trace 与人工标签生成 judge calibration snapshot |
| `npm run eval:judge` | DeepSeek judge，默认每个 case 计划 5 票 | 完整 calibration eval；先执行 `build:calibration` |
| `npm run eval:gen` | DeepSeek generation/repair 请求 | full Generation eval；repair 会增加请求轮次 |
| `npm run eval:fix` | DeepSeek fix/repair 请求 | full Fix eval；repair 会增加请求轮次 |
| `npm run eval:compare -- <runId>` | 无 | 本地读取 run 与同 kind baseline，不修改 artifact |
| `npm run eval:promote -- <runId>` | 无 | 人工审核后显式晋升；不会由 eval 或 compare 自动执行 |

调用外部服务的命令会产生实际 API 请求和费用。runner 会在执行前打印 case 数，judge/repair 的实际尝试次数保存在 trace；当前尚未贯通统一 usage/cost 统计，因此执行真实 eval 前应按 case 数、票数和最大 repair 轮次估算调用量。

### Run、Trace、Compare 与 Promote

每次 eval 使用独立 runId，并写入：

```text
data/eval/runs/<runId>.json
data/eval/traces/<runId>.<kind>.jsonl
```

run 记录 dataset、模型/corpus/index/prompt/config identity、metric definition version、状态和 trace 相对路径；trace 保存逐 case 输入、结果、outcome 和结构化错误阶段。baseline 只在显式 promote 后写入：

```text
data/eval/baselines/<kind>.json
```

compare 只有在 kind、dataset id/hash/caseCount、metric definition version 兼容，且 retrieval 的 `k` 相同时才输出 improved/regressed。模型、corpus、index、prompt 等配置变化作为实验变量展示；required metric 缺失属于阻断性 harness gap，`null` observation 显示为 N/A，不生成方向结论。

promote 只接受 completed、完整 scope、当前 metric registry、required metric 非 null、trace selection 完整且 harness error 为 0 的 run。retrieval/faith/generation/fix 必须是 full；judge 必须匹配当前完整 calibration snapshot。baseline 是可移植 snapshot，不保存 run/trace 路径或工作区绝对路径。

模型或基础设施出错时，先保留并检查本次证据：

```bash
cat data/eval/runs/<runId>.json
less data/eval/traces/<runId>.<kind>.jsonl
```

先查看 run 的 `status/failure`，再按 trace 的 `outcome/error.stage/error.message` 定位 case。不要删除或复用原 runId；修复后重新执行会生成新 runId，不会覆盖原 run/trace。

当前契约纠偏已完成结构实现，正式 baseline 尚待新版本 full run 和逐项人工审核；旧 baseline 与当前 identity/metric registry 不可直接比较。

评估数据与运行产物的边界:

```text
data/eval/
  bad-cases.jsonl                 # 可提交的问题台账
  judge-calibration-labels.jsonl  # 可提交的人工 calibration 标签
  judge-calibration.jsonl         # build:calibration 生成的 judge 输入快照
  baselines/<kind>.json           # 人工晋升后提交的可移植 baseline snapshot
  runs/<runId>.json               # 本地 EvalRun,不提交
  traces/<runId>.<kind>.jsonl     # 本地逐 case TraceEnvelope,不提交

data/observability/
  serving-traces.jsonl            # serving 观测数据,不属于 eval run,不提交
```

`EvalRun.artifactPaths.trace` 保存相对 `data/eval/` 的 POSIX 路径,由运行时解析到当前工作区。`runs/`、`traces/` 和 `data/observability/` 由运行时按需创建,可以清理后重建;旧 artifact 格式不提供兼容读取。baseline 不复制 run 文件,也不保存 ignored trace 路径。

说明:

- `npm run build` 会使用 `next/font` 拉取 Google Fonts,离线或沙箱网络受限时可能失败。
- `npm test` 和 `npm run ingest:schemas` 使用 `tsx`,部分沙箱环境可能会拦截 IPC pipe 创建。

## 环境变量

```bash
DEEPSEEK_API_KEY=...
VOYAGE_API_KEY=...
```

当前模型接入:

- 回答/生成:`Anthropic SDK` 接 DeepSeek Anthropic 兼容端点
- embedding / rerank:Voyage AI

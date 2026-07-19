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
| 检索评估 | `npm run eval` | 契约已纠偏，待按 tuning（调优集）/ Holdout（留出集）/ full（完整集）重跑并审核 baseline（基线） |
| Grounded Answer / Judge 评估 | `npm run eval:faith`、`npm run eval:judge` | 契约已纠偏，待重建 calibration（校准集）并审核 baseline（基线） |
| Generation / Fix 评估 | `npm run eval:gen`、`npm run eval:fix` | evaluator（评估器）已纠偏，待按角色套件重跑并审核 baseline（基线） |
| schema ingestion 骨架 | `npm run ingest:schemas` | ✅ |

## Web 使用

```bash
npm install
# 创建 .env，填入 DEEPSEEK_API_KEY 和 VOYAGE_API_KEY
npm run dev
```

生产模式需要先构建再启动：

```bash
npm run build
npm run start
```

`dev` 和 `start` 只负责启动 Web 服务；Ask、Generate 和 Fix 请求到达对应 API（应用程序接口）后才会调用外部模型或检索服务。

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
```

| 命令 | 外部调用 | 写盘边界 |
|---|---|---|
| `npm run ask -- "..."` | 索引命中时调用 Voyage 查询 embedding（向量嵌入）、rerank（重排）和 DeepSeek 回答；索引缺失或失效时还会在内存中重新嵌入全量当前语料 | 读取 `INDEX_DIR` 中经过身份校验的持久化索引；运行时重建不写索引文件 |
| `npm run check -- <yaml>` | DeepSeek tool loop（工具循环）；工具内部执行本地 schema validation（模式校验） | 不修改输入文件 |
| `npm run gen -- "..."` | DeepSeek generation/repair loop（生成 / 修复循环） | 不写文件；最终 YAML 输出到终端 |

这些 CLI（命令行界面）命令会产生真实 API（应用程序接口）请求和费用。
执行 `npm run ask` 前可先运行 `npm run index:build`。语料内容、元数据和嵌入模型均匹配时，问答命令直接复用持久化索引；任一身份不匹配时明确重建，不读取旧格式或不完整索引。

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
npm run ingest:schemas -- --source crd --input path/to/my-crd.yaml

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

每个 `--out` 目录表示一次完整生成快照。新版 `manifest.json` 会列出 `ingest:schemas` 明确拥有的资源和定义文件；再次写入同一目录时，只删除上一份清单拥有、当前快照不再生成的文件。未归属文件会保留，若与新目标同名则在写盘前失败。

旧版只记录数量的清单，以及“没有清单但已经包含 JSON”的输出目录，不具备可验证的所有权，命令会在修改文件前拒绝。迁移时先写入空的临时 `--out` 目录，审核新清单和文件差异后再显式更新目标生成产物，最后运行 `npm run schemas:check`；命令不会静默认领或清空旧目录。

### 数据维护命令

| 命令 | 外部调用 | 写盘与用途 |
|---|---|---|
| `npm run ingest:schemas -- ...` | 文件来源无；`--source cluster-discovery` 通过 `kubectl` 访问当前集群 | 默认写入 `data/schemas/generated/`；按 manifest（清单）所有权更新资源和定义，并清理本次已失效的自有文件 |
| `npm run schemas:check` | 无 | 只读；按运行时惰性解析方式遍历当前 generated schemas（生成的模式定义），拒绝缺失、非法及直接成环引用，并检查联合类型分支可消费 |
| `npm run aliases:check [-- --draft <path>]` | 无 | 只读；默认校验正式 alias registry（别名注册表），`--draft` 校验生成草稿；两者均核对目标、语料及评估用例的可追溯性 |
| `npm run aliases:generate` | DeepSeek；每个目标失败时最多尝试 3 次 | 独占写入 `data/aliases/drafts/` 下带时间戳的 draft artifact（草稿产物）；不修改正式注册表 |
| `npm run aliases:review -- <draft> [--apply]` | 无 | 默认只预览已人工审核草稿与正式注册表的合并结果；显式 `--apply` 才原子合并，且保留草稿未覆盖的正式记录 |
| `npm run corpus:stats` | 无 | 只读；输出语料规模、资源覆盖及内容 / manifest hash（清单哈希） |
| `npm run corpus:closure [-- --list]` | 无 | 只读；计算 curated whitelist（精选白名单）的 `$ref` 传递闭包 |
| `npm run index:build` | index miss（索引未命中）时调用 Voyage document embedding（文档向量嵌入） | 默认写入 `data/index/`；索引身份命中时跳过重建 |

Alias（别名）人工审核流程：

```bash
npm run aliases:generate
npm run aliases:check -- --draft data/aliases/drafts/schema-field-aliases.TIMESTAMP.jsonl
# 人工删除拒绝项，修正保留项，并填写 reviewed=true、reviewedAt
npm run aliases:review -- data/aliases/drafts/schema-field-aliases.TIMESTAMP.jsonl
npm run aliases:review -- data/aliases/drafts/schema-field-aliases.TIMESTAMP.jsonl --apply
npm run aliases:check
```

草稿目录默认被版本控制忽略。未审核记录会阻止合并；预览命令不会写盘，只有显式 `--apply` 才更新正式注册表。`ingest:schemas` 会覆盖当前清单拥有的同名文件并删除其中已失效的文件；`index:build` 会在索引失效时覆盖目标索引目录。执行这些写入命令前应先确认输入、目标目录和版本控制状态。

## 评估与验证

### 本地质量门禁

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval:check
npm run build
```

`npm test` 使用 Node.js 内置测试运行器和 `tsx` 加载器，自动发现全部 `*.test.ts` 并按文件串行执行。定向诊断时显式传入测试文件：

```bash
npm test -- src/retrieval/router.test.ts
```

这些命令不调用模型、embedding（向量嵌入）或 rerank（重排）。`npm run build` 使用 `next/font`，首次构建可能访问 Google Fonts。

### Eval（评估）调用与成本边界

| 命令 | 外部调用 | 主要写盘 | 用途与边界 |
|---|---|---|---|
| `npm run eval` / `npm run eval -- 5` | Voyage embedding（向量嵌入）与 rerank（重排）；index miss（索引未命中）时在内存中重建全量 corpus index（语料索引） | `data/eval/runs/`、`data/eval/traces/` | 默认运行 retrieval tuning suite（检索调优套件）；可选数字保留为 `k` |
| `npm run eval -- --holdout` / `npm run eval -- 5 --full` | 同上 | `data/eval/runs/`、`data/eval/traces/` | 显式运行 Holdout（留出集）或 full（完整集）检索评估 |
| `npm run eval:faith` | Voyage embedding/rerank（向量嵌入 / 重排）；DeepSeek 回答与 judge（裁判） | `data/eval/runs/`、`data/eval/traces/` | 默认运行 Grounded Answer tuning suite（有依据回答调优套件） |
| `npm run eval:faith -- --holdout` / `npm run eval:faith -- --full` | 同上 | `data/eval/runs/`、`data/eval/traces/` | 显式运行 Holdout（留出集）或 full（完整集）有依据回答评估 |
| `npm run eval:faith -- <N>` / `--policy` | 同上 | `data/eval/runs/`、`data/eval/traces/` | smoke/policy subset（冒烟 / 策略子集），固定排除 Holdout（留出集），只用于诊断且不可晋升 baseline（基线） |
| `npm run build:calibration` | 无 | 覆盖 `data/eval/judge-calibration.jsonl` | 从已完成的非 smoke faith runs/traces（非冒烟忠实度运行 / 轨迹）与人工标签生成 judge calibration snapshot（裁判校准快照）；拒绝 Holdout（留出集）轨迹 |
| `npm run eval:judge` | DeepSeek judge（裁判），默认每个 case（用例）计划 5 票 | `data/eval/runs/`、`data/eval/traces/` | 完整 calibration eval（校准评估）；先执行 `build:calibration` |
| `npm run eval:gen` / `npm run eval:fix` | DeepSeek generation/fix/repair（生成 / 修复 / 再修复）请求 | `data/eval/runs/`、`data/eval/traces/` | 默认运行 tuning suite（调优套件）；repair（再修复）会增加请求轮次 |
| `npm run eval:gen -- --holdout` / `npm run eval:gen -- --full`；`npm run eval:fix -- --holdout` / `npm run eval:fix -- --full` | 同上 | `data/eval/runs/`、`data/eval/traces/` | 显式运行各自的 Holdout（留出集）或 full（完整集）评估 |
| `npm run eval:compare -- <runId>` | 无 | 无 | 本地读取 run（运行记录）与同 kind baseline（同类型基线），不修改 artifact（产物） |
| `npm run eval:promote -- <runId>` | 无 | `data/eval/baselines/<kind>.json` | 人工审核后显式晋升；不会由 eval（评估）或 compare（对比）自动执行 |
| `npm run badcases:faith -- <runId> [--write]` | 无 | 默认不写；`--write` 覆盖 `data/eval/bad-cases.jsonl` | 预览或合并 faith bad cases（忠实度问题用例），写入前校验证据链；Holdout（留出集）轨迹不生成回灌候选 |

调用外部服务的命令会产生实际 API（应用程序接口）请求和费用。runner（运行器）会在执行前打印 case count（用例数量），judge/repair（裁判 / 修复）的实际尝试次数保存在 trace（轨迹）；当前尚未贯通统一 usage/cost（用量 / 成本）统计，因此执行真实 eval（评估）前应按用例数量、票数和最大修复轮次估算调用量。

retrieval、faith、generation、fix（检索、忠实度、生成、修复）统一默认选择 `tuning`，即 development + regression（开发用例 + 回归用例）。`--holdout` 只运行留出用例；`--full` 保持提交顺序运行全部用例，只应在调优冻结后执行，并且只有 `scope='full'` 的已完成运行可进入 baseline（基线）审核。

这些参数只改变选择集，不会切换为 dry run（试运行）：retrieval/faith/generation/fix（检索 / 忠实度 / 生成 / 修复）的 `--holdout` 和 `--full` 仍会按上表调用真实外部服务并产生费用。`npm run eval:check` 只做本地契约与分布校验，不调用模型。

当前提交数据由 `npm run eval:check` 核对：Retrieval（检索）83 条、Grounded Answer（有依据回答）88 条、Generation（生成）27 条、Fix（修复）9 条。Grounded Answer 包含 83 条检索引用、2 条错误解释和 3 条独立拒答；四类主评估各有 1 条 Holdout（留出集）。当前 case origin（用例来源）仍全部为 `human`，`schema_generated` 和 `bad_case` 暂无样本，不为填满分桶造题。错误解释的自动门禁覆盖真实校验输入、检索依据和 Faithfulness（忠实度），尚未完整自动判定 correctness（正确性）；首次 `--full` 运行必须人工审核对应 trace（轨迹）的完整性和修复方向。

### 实验诊断命令

| 命令 | 外部调用 | 写盘与边界 |
|---|---|---|
| `npm run aliases:ab [-- --all]` | Voyage query embedding/rerank（查询向量嵌入 / 重排）；index miss（索引未命中）时还会在内存中嵌入全量语料 | 不写 bad case（问题用例）或 baseline（基线）；默认只消费 target gate（目标门禁）通过的非 Holdout（非留出）用例，`--all` 比较 tuning suite（调优套件） |
| `npm run voyage:ab` | Voyage query embedding/rerank（查询向量嵌入 / 重排） | 不写文件；要求 `data/index` 与 `data/index-ab` 已分别存在兼容索引，只用于模型对照诊断 |

这两个命令属于实验诊断，不生成正式 `EvalRun`，其输出不能用于 baseline（基线）晋升。维护者级生命周期和保留依据见 `scripts/README.md`。

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

promote（晋升）只接受 completed（已完成）、完整 scope（运行范围）、当前 metric registry（指标注册表）、required metric（必需指标）非 null、trace selection（轨迹选择）完整且 harness error（评估框架错误）为 0 的 run（运行记录）。retrieval/faith/generation/fix（检索、忠实度、生成、修复）必须显式为 `full`；`tuning` 和 `holdout` 均被拒绝。judge（裁判）必须匹配当前完整 calibration snapshot（校准快照）。baseline（基线）是可移植 snapshot（快照），不保存 run/trace（运行 / 轨迹）路径或工作区绝对路径。

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
- 除 `npm test` 外，TypeScript npm 脚本通过 `tsx` CLI（命令行界面）启动；部分沙箱环境可能会拦截其 IPC pipe（进程间通信管道）创建。

## 环境变量

```bash
DEEPSEEK_API_KEY=...
VOYAGE_API_KEY=...
```

当前模型接入:

- 回答/生成:`Anthropic SDK` 接 DeepSeek Anthropic 兼容端点
- embedding / rerank:Voyage AI

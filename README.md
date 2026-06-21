# K8s YAML Authoring Copilot

面向 Kubernetes YAML 编写场景的 AI 辅助工具。当前阶段不做泛化 K8s 运维助手,重点解决用户在编辑器里写 YAML 时的四类任务:

- 解释字段和当前配置
- 检查并修复 YAML
- 根据自然语言生成资源 YAML
- 给出可追溯的答案依据

完整训练方案见 `docs/AI应用开发训练方案-K8s-YAML-Copilot.md`;后续 agent 执行约束见 `AGENTS.md`。

## 当前能力

| 能力 | 入口 | 状态 |
|------|------|------|
| 编辑器内 YAML 编写 | `npm run dev` | ✅ |
| 检查与修复 | Web `/api/check`、`/api/fix`;CLI `npm run check` | ✅ |
| 生成资源 YAML | Web `/api/generate`;CLI `npm run gen` | ✅ |
| 上下文化问答 | Web `/api/ask` | ✅ |
| 答案依据展示 | SSE `sources` + 前端“答案依据” | ✅ |
| 检索评估 | `npm run eval` | ✅ |
| 生成忠实度评估 | `npm run eval:faith` | ✅ |
| schema ingestion 骨架 | `npm run ingest:schemas` | ✅ |

## Web 使用

```bash
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY 和 VOYAGE_API_KEY
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
data/schemas/*.json 或 data/schemas/generated/*.json
        ↓
src/knowledge/schemas.ts
        ↓
src/knowledge/schema-corpus.ts
        ↓
src/retrieval/retrieve.ts + router.ts + rerank.ts
        ↓
src/server/pipeline.ts
        ↓
app/api/{ask,check,fix,generate}
        ↓
app/ Monaco Web UI
```

关键设计:

- schema 是字段事实层,同时服务问答语料和 YAML 校验。
- 问答返回 SSE:先发送 `sources`,再发送答案 `delta`。
- 检索会结合用户问题、当前资源、光标字段、选中文本和校验错误。
- 生成和修复通过 agentic loop 执行“生成/修复 → schema 校验 → 再修正”。

## Schema Ingestion

不要靠手动 import 扩展资源覆盖。项目支持把外部 schema 标准化生成到:

```text
data/schemas/generated/
```

当该目录没有 generated JSON 时,系统会回退到 `data/schemas/*.json` 中的 fixture。

示例:

```bash
# 从已有 schema 目录生成标准化 SchemaDoc
npm run ingest:schemas -- --source dir --input data/schemas --out data/schemas/generated

# 从 CRD YAML 生成 SchemaDoc
npm run ingest:schemas -- --source crd --input examples/my-crd.yaml

# 从 Kubernetes OpenAPI JSON 生成内置资源 SchemaDoc
npm run ingest:schemas -- --source kubernetes --input openapi.json

# 从集群 OpenAPI 导出的 JSON 生成 SchemaDoc
npm run ingest:schemas -- --source cluster --input openapi.json
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

## 评估与验证

```bash
# TypeScript
npx tsc --noEmit

# 构建
npm run build

# 纯函数校验单测
npm test

# 检索评估
npm run eval

# 生成忠实度评估
npm run eval:faith
```

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

## 下一步

P0 已开始落地,后续优先级:

1. 继续强化“答案依据”与低置信拒答。
2. 增加主流内置资源的离线 OpenAPI ingestion。
3. 将官方文档和示例模板作为 schema 之外的知识层接入。
4. 建立 query 日志、反馈回灌和评估集增长机制。

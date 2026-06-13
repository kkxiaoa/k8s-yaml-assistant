# CLAUDE.md · K8s YAML 智能助手

独立的、生产级定位的 AI 应用:懂集群所有资源/CRD、活在编辑器里、答案可控可审计的 K8s 配置助手。
能力:**问答(RAG)/ 校验 / 生成**。产品全貌见 `docs/产品设计-K8s智能助手.md`。

## 命令

| 命令 | 作用 |
|------|------|
| `npm run ask -- "<问题>"` | RAG 问答(CLI,流式) |
| `npm run check -- <file.yaml>` | 校验 StorageClass(Tool Use) |
| `npm run gen -- "<需求>"` | 生成 YAML + 自检修正闭环 |
| `npm run eval` | 检索评估:Recall@k / MRR(① 无过滤 / ② oracle / ③ auto路由 / ④ rerank) |
| `npm run eval:faith` | 生成评估:Faithfulness(LLM-as-judge,异构 pro 裁判) |
| `npm test` | `validateStorageClass` 纯函数单测 |
| `npm run dev` | Next.js Web(Monaco 编辑器 + RAG 问答 + 校验) |

## 目录结构(分层)

```
src/
  knowledge/    schema-corpus.ts(结构化切片) corpus.ts(CORPUS)
  retrieval/    embeddings.ts retrieve.ts router.ts rerank.ts
  validation/   validate.ts validate.test.ts
  server/       pipeline.ts(服务端管线,供 Web 复用)
  cli/          ask.ts check.ts gen.ts
  eval/         eval.ts(检索) faithfulness.ts(生成) eval-set.ts
app/            Next.js Web(page.tsx + Monaco)+ api/ask|check
data/schemas/   真实 K8s OpenAPI schema(知识源)
```

数据流:`data/schemas/*.json → knowledge/schema-corpus(schema→chunk)→ knowledge/corpus
→ retrieval/retrieve(向量+余弦)+ router(软路由)+ rerank(精排)→ server/pipeline → CLI / Web`

## 设计基因:三大支柱(意图不可预知 → 押注这三个)

1. **评估**:检索 Recall@k/MRR + 生成 Faithfulness,是一切优化的标尺 + 回归门禁。
2. **反馈回路**(规划):线上 👍/👎 + 查询日志 → 回灌 eval 标注集。
3. **自适应检索**:rerank / 软加权 / 动态 k —— 不赌"预测意图/完美路由"。
支撑手段:结构化切片(schema 驱动)、自检(生成→校验→修正 + 运行时 schema 核验)。

## 关键约定

- **TS 严格模式**(`noUncheckedIndexedAccess` 等);改代码后跑 `npx tsc --noEmit -p tsconfig.json`。
- **模型**:用 Anthropic SDK 接 **DeepSeek 兼容端点**(`baseURL: https://api.deepseek.com/anthropic`)。
  传 `claude-sonnet-4-6` → 映射 deepseek-v4-flash;`claude-opus-4-8` → deepseek-v4-pro。换回真 Claude 只改 baseURL + key。
- **embedding / rerank** 用 Voyage(DeepSeek 无 embedding 接口)。
- **知识库 schema 驱动**:加一个资源/CRD = 往 `data/schemas/` 丢一个 `{resource, apiVersion, schema}` JSON + `src/knowledge/schema-corpus.ts` 的 `DOCS` 加一行。**不要手写 chunk。**
- **测量驱动**:改了切片/检索/路由/模型,**必须重跑 `npm run eval`** 对比指标,用数字决定好坏,别凭感觉。

## Gotchas

- `.env` 含真实 API key,已 gitignore,**绝不提交**;`.env.example` 是模板。
- Voyage 免费档限流 3 RPM:`eval` 的 rerank 逐条调 13 次,撞限流就等一分钟或绑卡(仍在免费额度内)。
- LLM-as-judge 有 ~5-10% 噪声:Faithfulness 数字异常时**先验证裁判判得对不对**,别急着改模型(教训见 `docs/RAG-复盘-03`)。
- DeepSeek 兼容端点**不支持** `cache_control`、图片、结构化输出;只用文本 + tool use。

## 复盘文档(面试素材 + 决策依据)

- `docs/RAG-复盘-01`:检索原理 + 切片 + 定位故障层决策树
- `docs/RAG-复盘-02`:检索硬化(元数据过滤/路由/软加权/rerank),全程评估驱动
- `docs/RAG-复盘-03`:生成层评估 + "修尺子"(发现并修复评估工具自身缺陷)

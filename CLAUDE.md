# CLAUDE.md · K8s YAML Copilot 训练场

当前项目不是在做完整 K8s AI 产品,而是用 K8s YAML Copilot 场景训练 AI 应用开发能力。
训练重点:**RAG 问答 / YAML 校验 / Generate-Fix 生成修复 / Eval / Trace / Feedback**。
主线文档见 `docs/AI应用开发训练方案-K8s-YAML-Copilot.md` 和 `docs/AI应用开发能力训练实现方案.md`。

## 命令

| 命令                           | 作用                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `npm run ask -- "<问题>"`      | RAG 问答(CLI,流式)                                                    |
| `npm run check -- <file.yaml>` | 校验任意资源(schema 驱动,Tool Use)                                    |
| `npm run gen -- "<需求>"`      | 生成 YAML + 自检修正闭环                                              |
| `npm run eval`                 | 检索评估:Recall@k / MRR(当前 eval set 仍需扩展,不能代表全量 88k 语料) |
| `npm run eval:faith`           | 生成评估:Faithfulness(LLM-as-judge,异构 pro 裁判)                     |
| `npm test`                     | `validateResource` 纯函数单测                                         |
| `npm run dev`                  | Next.js Web(Monaco 编辑器 + RAG 问答 + 校验)                          |

## 目录结构(分层)

```
src/             领域/后端层(框架无关,用 @/ 别名访问)
  knowledge/     schemas.ts(共享加载) schema-corpus.ts(结构化切片) corpus.ts
  retrieval/     embeddings.ts retrieve.ts router.ts rerank.ts
  validation/    validate.ts(validateResource) validate.test.ts
  server/        pipeline.ts(服务端管线,供 Web 复用)
  cli/           ask.ts check.ts gen.ts
  eval/          eval.ts(检索) faithfulness.ts(生成) eval-set.ts
app/             Next.js 前端(分层)
  layout/page/globals  路由 + 全局
  api/           route handlers(/api/ask 流式, /api/check)
  ui/            UI 层:展示组件(ValidatePanel/AskPanel/StatusBar)+ styles.ts
  lib/           前端逻辑/工具(yaml.ts:detectResource/buildMarkers)
data/schemas/    generated registry + curated 白名单(知识源)
```

路径别名:`@/* → src/*`(`app/api` 用 `@/server/pipeline` 访问后端,避免 `../../../`)。

数据流:`data/schemas/generated/{resources,definitions} + data/schemas/curated.json
→ knowledge/schemas(本地 ref registry + curated 加载)
→ knowledge/schema-corpus(schema→chunk)→ knowledge/corpus
→ retrieval/retrieve(向量+余弦)+ router(软路由)+ rerank(精排)→ server/pipeline → CLI / Web`

## 设计基因:三大支柱(意图不可预知 → 押注这三个)

1. **评估**:检索 Recall@k/MRR + 生成 Faithfulness,是一切优化的标尺 + 回归门禁。
2. **反馈回路**:先用离线 `bad-cases.jsonl` 回灌 eval,后续再做 UI 反馈。
3. **自适应检索**:rerank / 软加权 / 动态 k —— 不赌"预测意图/完美路由"。
   支撑手段:结构化切片(schema 驱动)、自检(生成→校验→修正 + 运行时 schema 核验)。

## 关键约定

- 使用中文输出。
- **禁止玩具思维落盘(最高优先)**:落盘的东西必须是当前阶段的**真实工程形态**,不得为了快速跑通而沉淀简化/占位/硬编码版本 —— 例如手写少字段 schema 覆盖真实 ingestion 产物、storage-only 的 fallback 资源集、`CORPUS.slice(0, N)` 截断语料、单资源特判。临时方案必须**显式标注边界并征得同意**,不能悄悄变成既成事实。发现历史玩具残留(如 `FIXTURE_SCHEMA_DOCS` 覆盖层、`FALLBACK_RESOURCES`/`chunksForResource` 硬过滤、旧 `validateStorageClass`/`submit_storageclass` 注释)应**清退**,不得在其上继续叠加。
  - **落盘前过三闸(2026-07 复盘,反复踩过)**:① **反碎片** —— 能复用/扩展已有(eval-set / getClient / pipeline / 共享模块)就别另造平行物;是在修真问题还是造脚手架?② **反玩具** —— "跑绿"证明了什么?评估类**高分先怀疑题太简单/送分**(手写送分题、dense-only 审计这类,绿了也没意义);校准/eval 的输入要来自**真实 pipeline**,别手写。③ **难就说难** —— 真活难/模糊时不发"长得像"的简单替身,要么做难的、要么停下问。另:**别从带 `main()` 的 runner 文件 import**(会触发跑批+花额度),共享代码放无副作用模块。
- **TS 严格模式**(`noUncheckedIndexedAccess` 等);改代码后跑 `npx tsc --noEmit -p tsconfig.json`。
- **模型**:用 Anthropic SDK 接 **DeepSeek 兼容端点**(`baseURL: https://api.deepseek.com/anthropic`)。
  传 `claude-sonnet-4-6` → 映射 deepseek-v4-flash;`claude-opus-4-8` → deepseek-v4-pro。换回真 Claude 只改 baseURL + key。
- **embedding / rerank** 用 Voyage(DeepSeek 无 embedding 接口)。
- **前端分层(Next.js 最佳实践)**:`app/` 只放路由(page/layout/route);**`app/ui/` = UI 层**(展示组件,纯展示、状态与副作用都在 `page.tsx` 这个薄组合根里);`app/lib/` = 前端逻辑/工具。跨层访问后端用 `@/` 别名(`@/server/pipeline`),不写 `../../../`。新建展示组件放 `app/ui/`,新建前端纯逻辑放 `app/lib/`。**与 `/api/*` 的通信封装在 `app/lib/api.ts`,组件/page 不直接 `fetch`**(page 只做状态编排)。
- **前端栈**:Tailwind v4(`@theme` token + `app/globals.css`)+ IBM Plex Mono/Sans(next/font),蓝图 dev-console 风格;资源感知(从 YAML 解析 kind/apiVersion)+ Monaco 内联报错标记(path→行)。UI 用 `frontend-design` 技能。
- **知识库 schema 驱动**:资源/CRD 应通过 ingestion pipeline 进入 `data/schemas/generated/{resources,definitions}`,不要靠手工 import 或 `data/schemas/*.json` fixture 扩覆盖。`resources` 存资源入口,`definitions` 存 OpenAPI `$ref` registry,运行时本地解析引用。
- **单一检索路径(eval == serving)**:CLI / Web / eval 共用同一段 `retrieve`(**全量软加权,无 `chunksForResource` 硬过滤**)+ 同一份索引。语料经 `data/schemas/curated.json` 白名单收敛(~20-40 个核心 kind),不全量遍历 `generated/*`。改检索时**别把硬过滤分支引回来**(违背支柱③"不赌完美路由")。理由与依赖链见实现方案 §4.1 / §4.3。
- **测量驱动**:改了切片/检索/路由/模型,必须与 baseline 对比。当前需要优先补 `eval:compare` 和 `data/eval/baseline.json`,不能只看单次指标。持久化索引必须在"语料收敛 + 检索路径合一"之后做(顺序见 §4.3),否则把分裂索引烤进磁盘。

- **注释与文档精简**:注释只解释"为什么/非显然意图",不复述代码,不写对话上下文(决策过程、方案对比、"这轮/之前/收回"、历史演变——那些进 commit / PR)。文档少写铺垫,提示用简短 tips。长对话易积累上下文注释、污染阅读与模型,发现即精简为合理注释或删除。

## Gotchas

- `.env` 含真实 API key,已 gitignore,**绝不提交**;`.env.example` 是模板。
- Voyage 免费档限流 3 RPM:`eval` 的 rerank 逐条调 13 次,撞限流就等一分钟或绑卡(仍在免费额度内)。
- LLM-as-judge 有 ~5-10% 噪声:Faithfulness 数字异常时**先验证裁判判得对不对**,别急着改模型(教训见 `docs/RAG-复盘-03`)。
- DeepSeek 兼容端点**不支持** `cache_control`、图片、结构化输出;只用文本 + tool use。

## 复盘文档(面试素材 + 决策依据)

- `docs/RAG-复盘-01`:检索原理 + 切片 + 定位故障层决策树
- `docs/RAG-复盘-02`:检索硬化(元数据过滤/路由/软加权/rerank),全程评估驱动
- `docs/RAG-复盘-03`:生成层评估 + "修尺子"(发现并修复评估工具自身缺陷)

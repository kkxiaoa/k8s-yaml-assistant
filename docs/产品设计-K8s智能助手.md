# 产品设计 · K8s YAML 智能助手

> 定位:**独立的、生产级定位的 AI 应用作品**(非平台耦合)。
> 一句话:**懂集群里所有资源/CRD、活在编辑器里、答案可控可审计的 K8s 配置助手。**

---

## 1. 它要解决什么

K8s 用户写 YAML 时三个真实痛点:
1. **字段记不住**:某资源有哪些字段、枚举取什么、哪个必填、默认值是啥 —— 要翻文档。
2. **配错难发现**:写错枚举/缺必填,往往等 `kubectl apply` 才报错,甚至上线才炸。
3. **从零写很慢**:照着需求拼一个合法资源,得反复查、试。

对应三个能力:**问答(查字段)/ 校验(找错)/ 生成(按需求出 YAML)**。

## 2. 为什么不是"又一个粘贴框 + ChatGPT"

雏形阶段是"粘贴 YAML → 校验 + 问答",但那是 demo 形态。真正的生产价值在三个升级:

| 维度 | 玩具形态 | 生产形态 |
|------|---------|---------|
| **知识库** | 手写几段文档 | **真实 CRD OpenAPI schema 自动生成**(覆盖所有字段、永远最新、零人工维护) |
| **校验** | 手写一种资源的规则 | **schema 驱动**(同一份 schema 通用校验任意资源) |
| **形态** | 用户粘贴 | **嵌入编辑器,感知"当前正在编辑哪个资源/字段"** |

> 灵感来源:平台 `yaml-sidebar` 组件已用 CRD OpenAPI schema + ConsoleYAMLSample 示例 + 编辑器集成。
> 本项目保持独立(Next.js,不耦合 Angular 平台),但把"schema 当知识库 + 活在编辑器"这套思路做成 AI 助手。

## 3. 设计基因:贯穿三大支柱

核心信念:**用户意图不可预知,只能先验估计 + 持续学习。** 所以工程上押注这三个,而不是赌"完美预测意图 / 完美切片":

### ① 评估(Evaluation)—— 一切优化的标尺 + 回归门禁
- 双层评估:**检索层 Recall@k / MRR**(`npm run eval`)+ **生成层 Faithfulness**(`npm run eval:faith`)。
- 每次改切片/检索/模型都重跑,用数字决定做不做、先做哪个。
- 已踩过的坑(见复盘 02/03):满分=eval 没咬住要加难;指标掉了先怀疑尺子;LLM-as-judge 自己也会错,要验证裁判。

### ② 反馈回路(Feedback loop)—— 把评估集喂"活"
- Web 答案加 👍/👎 + 记录 `query / 命中 chunk / 是否解决`。
- 定期挖"没命中 / 差评 / 拒答"的 query → **回灌成新 eval 用例 + 调切片/路由**。
- 离线标尺(①)+ 线上喂养(②)咬合,标注集从固定几条变成被生产持续喂养的活物。

### ③ 自适应检索(Adaptive retrieval)—— 不赌预测,直接读真实相关性
- **rerank**(cross-encoder 读 query+doc 真实相关性)、**软加权路由**(命中资源加分但不删,误路由也不丢答案)、动态 k、(未来)hybrid。
- 实证:关键词路由在"PVC 扩容(其实是 StorageClass 字段)"翻车 → 改 rerank 一锤定音(MRR → 1.0)。

> **支撑手段**(服务三支柱,但不是押注对象):
> - **结构化切片**:schema 驱动 = 按字段切 + 注入 资源/路径/类型/枚举/required 元数据,把语料质量做到最好。
> - **自检**:生成自检(生成→校验→修正,已有)+ 运行时拿 schema 核验答案字段(防幻觉)。

## 4. 当前架构

```
data/schemas/*.json                真实 K8s OpenAPI schema(知识源,可换集群导出的 CRD)
 └ src/knowledge/schema-corpus.ts   结构化切片:schema → chunk(一字段一段,带元数据)
    └ src/knowledge/corpus.ts        CORPUS
       └ src/retrieval/retrieve.ts    向量检索(内存 + 余弦)
          ├ src/retrieval/router.ts   关键词软路由(命中资源加分,不硬删)
          └ src/retrieval/rerank.ts   Voyage cross-encoder 精排
             └ src/server/pipeline.ts 服务端管线(检索+生成+校验,供 Web 复用)

目录:src/{knowledge, retrieval, validation, server, cli, eval} 分层;app/ = Next.js Web。
入口:CLI = src/cli/{ask,check,gen};Web = app/(Next.js)+ Monaco + /api/{ask 流式, check}
模型 : Anthropic SDK 接 DeepSeek 兼容端点(便宜;换回真 Claude 只改 baseURL)
评估 : Voyage embedding + rerank;DeepSeek 生成 + 异构 pro 裁判
```

## 5. 价值升级路线

| 阶段 | 内容 | 状态 |
|------|------|------|
| **Phase A** | schema 驱动知识库(真实 OpenAPI schema 自动生成 chunk) | ✅ 已完成(29 chunk,eval 100%/1.0) |
| **Phase B** | schema 驱动校验(按 type/enum/required 通用校验任意资源) | 下一步 |
| **Phase C** | 编辑器上下文感知(解析当前 apiVersion/kind,scope 检索/校验)+ Monaco 内联报错标记 | 规划 |
| **Phase D** | agentic 动作("修掉这个错 / 按需求生成"内联)+ 运行时自检 | 规划 |
| **Phase E** | 反馈回路(👍/👎 + 查询日志 → 回灌 eval),贯穿,可提前埋点 | 规划 |

## 6. 简历叙事(为什么这个项目有分量)

- **不是调包**:有检索层 + 生成层**双指标**,每个优化都用数字驱动(Recall@k/MRR/Faithfulness)。
- **会修尺子**:发现并修复了评估工具自身的缺陷(harness bug、裁判误判、Faithfulness 定义边界)。
- **懂工程权衡**:路由翻车 → 软加权 → rerank,用数据决定每一步;知道 ②/路由是成本手段、④rerank 是质量手段。
- **生产视角**:知识库由 schema 驱动、零人工维护,可直接接集群 CRD;设计押注"评估+反馈+自适应",而非赌完美。

---

> 配套复盘:`RAG-复盘-01`(检索原理+切片+定位故障层决策树)、`RAG-复盘-02`(检索硬化,评估驱动)、`RAG-复盘-03`(生成层评估+修尺子)。

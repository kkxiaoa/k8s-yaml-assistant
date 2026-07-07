# 检索优化(技术债 A)设计:跨语言字段召回 + 多源容量竞争

- 日期：2026-07-07
- 状态：设计已确认，待转实施计划
- 主线：技术债 A(检索优化轮)，承接 Stage 6

## 1. 背景与目标

Stage 6 完结后 serving Recall@3 = 89.5%(81 可答)，`bad-cases.jsonl` 沉淀 **10 条 retrieval miss** + 多源 **top-k 容量竞争**。本轮目标:解跨语言字段 miss + 多源容量竞争。

**关键发现(证伪 BM25 Hybrid)**:chunk text 构成是「中文包装 + 英文 description/字段名」——
```
PersistentVolumeClaim 的字段 spec.volumeMode:volumeMode defines what type of volume... "Block" means...
```
而 bad-case 的 query 是中文概念("裸块""延迟绑定""存储大小""镜像")，**在 chunk 里根本不存在**。所以经典 BM25/词面 Hybrid 在此场景无效:它能匹配的资源名(Deployment/PVC 英文)`router.inferResource` 已覆盖;真正漏的字段级概念是中→英跨语言，词面对不上。**BM25 暂缓。**

## 2. 范围(单变量隔离 + 条件触发)

- **A1**: top-k 容量竞争(`CONTEXT_K` 3→5)。
- **A2**: voyage-4 embedding A/B。
- **A3**: schema-aware query expansion(条件触发，A2 不够才做)。

**非目标**:
- BM25 / RRF —— 跨语言证伪，暂缓，除非后续 bad-case 明确是**同语言**关键词失召回。
- 手写散装词典("裸块→volumeMode")—— 反玩具红线，A3 用 schema 派生而非手写。

## 3. 证据(bad-case 抽样)

10 条均 `retrieval_miss`，字段级、跨语言:
- "PVC 怎么申请**存储大小**?" → `resources.requests`
- "怎么把卷设成**裸块设备**?" → `volumeMode`
- "怎么让卷**延迟到 Pod 调度后再绑定**?" → `volumeBindingMode`
- "Deployment 里容器**镜像**写在哪个路径?" → `image`

top-k 竞争:`policy.storageclass.allowVolumeExpansion` 挤掉 schema `StorageClass::allowVolumeExpansion`;冲突 case 讲 schema 层但没召回对应 schema chunk → `faithful=false`。

## 4. A1: top-k 容量竞争(k 3→5)

**先厘清代码里的三个 k——它们是分开的,别只改一个**:
- **检索 eval 的 k**:`npm run eval -- 5` 传参,控制 Recall@k 统计;
- **faith 的 `CONTEXT_K`**(`src/eval/faithfulness-eval.ts`):只控 faith 的 context size;
- **serving 的 k**:`retrieveContext(question, k=3)` 默认值(线上 Ask 走这条)。

A1 验证与落地:
- **验证(双指标)**:① 检索 eval 分别跑 `k=3` 和 `k=5`(Recall@3 vs @5,多源容量竞争解没解);② 把 faith 的 `CONTEXT_K` 从 3 改 5,看冲突 case 的 `faithful=false`(如 `conflict-latest` 讲 schema 层没依据)能否因 top-5 转 true。
- **单变量**:只改 k,不动 embedding/检索算法。
- **牵动 faith**:`CONTEXT_K` 升 5 后 faith 的 `fullRecall` 归因 + 97.4% baseline(建在 top-3)不再可比,**faith baseline 随之重建**。
- **落地口径必须三处一致**:若决定产品侧也用 5,**必须同时改 `retrieveContext` 默认 k**(或 API 调用侧传 k=5)——否则会出现"只改 faith 不改线上 Ask"或"只改 eval 不改 faith"的口径分裂。
- 成本:低(不重建索引,eval 跑一次)。

## 5. A2: voyage-4 embedding A/B

- **变量边界**:只改变 **embedding model 与对应索引**,不改变 retrieve/rerank/prompt/context 组装逻辑(检索算法不动)。为支持 A/B,模型/索引的**选择机制**需要改(见下)——这不算改 pipeline。
- **隔离,不覆盖正式索引**(当前 `EMBEDDING_MODEL` 硬编码 voyage-3、`data/index` 单目录;直接改跑 `index:build` 会覆盖默认索引,归因和回滚都麻烦):
  - 新增环境变量(如 `VOYAGE_EMBEDDING_MODEL=voyage-4`),**默认仍 voyage-3**;
  - A/B 用**隔离索引目录**(如 `data/index-ab/voyage-4`)或专门脚本**内存构建**,不动正式 `data/index`;
  - **query embedding 必须和被测 document index 用同一个 embedding model**,否则 Recall/MRR 不公平。
- **A/B 方法**:voyage-4 全量嵌一次(~7min)进隔离索引,对 10 miss + policy conflict(~12 case)统计 Recall/MRR vs voyage-3 baseline。"小样本"是**指标范围**(只统计这 12 case),不是嵌入范围(仍全量嵌,否则候选池不公平)。
- 若明显改善:升级默认 embedding(env 切 voyage-4)+ 重建正式 `data/index`。
- 成本:中(voyage-4 全量嵌 ~7min + eval)。

## 6. A3: schema-aware query expansion(条件触发)

- **触发**:A2 对跨语言 miss 无明显提升才做。
- **不手写散装词典**。基于 `resourceHint`，从该资源的字段 path/title/description 生成候选字段术语，把 query 扩成「原问题 + 资源 + 候选字段术语」。例:`怎么把卷设成裸块设备?` → 追加 `volumeMode Block Filesystem`。
- 支撑:LLM 小模型 or 离线 alias index。
- 设计细化留到 A2 结果出来后(现在不展开)。
- **不回 BM25。**

## 7. 决策门槛(用户定,本 spec 的核心)

```
A1 (k=5):
  · 明显解决多源冲突 faith 但 retrieval miss 仍在 → 保留 CONTEXT_K=5,继续 A2。

A2 (voyage-4):
  · 对跨语言 miss 明显提升 → 升级默认 embedding + 重建正式 index。
  · 无明显提升        → 进入 A3(schema-aware expansion / alias index),不回 BM25。
```

每一步只改一个变量、看指标再决定下一步,收益归因干净。

## 8. 变量隔离 + eval 对比

- baseline:当前 serving Recall@3 = 89.5%(**不 promote**——语料/eval-set 已随 Stage 6 变，仅作本轮对比基准)。
- A1:Recall@3 vs @5 + faith conflict case 的 faithful 翻转。
- A2:voyage-4 vs voyage-3 的 Recall/MRR(12 case)。
- A3:expansion 前后 Recall。

**「明显」的判据**:小样本(~12 case)**不设硬阈值**(防过拟合)，取定性观察——目标 bad-case 是否从 miss 转 hit、conflict case 的 `faithful` 是否翻转，而非纠结整体 Recall 的小数点。

## 9. 约束

- **measure-driven**:每步 vs baseline，证明净改善才 promote/升级默认。
- **反玩具**:不散装词典;A3 的 expansion 从真实 schema 字段派生。
- **复用现有 retrieve/eval**:不造平行检索路径(searchCorpusTraced 单一路径)。
- **Voyage 3 RPM 限流**:全量 eval / 索引重建耗时(~7min+)，A2 的重嵌与全量 eval 需后台跑。

# 项目上下文交接文档

> 这份文档把「前端转型 AI」系列对话里定下的所有决策固化下来，
> 让在本目录新起的 Claude Code session 能无缝接上全部上下文。
> 原始对话存档见同目录 `conversation-archive.jsonl`。

---

## 1. 这个项目是什么

**K8s YAML / CRD 智能助手** —— 用自然语言**生成 / 校验 / 解释** Kubernetes 资源配置。

- **定位**：作者「前端 → AI 应用开发」转型的**简历级作品**，也是边学边做的实战载体。
- **差异化**：蹭满作者已有优势（Monaco 编辑器、CRD 动态表单、8 年 K8s ToB 经验），做出领域深度，区别于"通用 ChatGPT 套壳"。
- **一次补两个短板**：React/Next（栈短板）+ Node 服务端（服务端短板）。

## 2. 作者背景（决定技术选型的关键）

- 8 年前端，长期 Angular + Nx Monorepo + Module Federation，深耕 ToB 容器云（K8s）存储/网络/虚拟化。
- 已重度使用 Claude Code / Codex 做 AI 驱动迁移、0→1 交付（有 migration-skills 工程化经验）。
- 精通 TypeScript；Python 不熟。转型目标明确：**前端 + AI 应用开发**（不是算法/模型训练方向）。

## 3. 已敲定的关键决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 语言 | **TypeScript / Node** | 零语言成本，先补"服务端 + AI 接入"，对接 Next.js |
| demo 与项目关系 | **同一个项目，分迭代**（不是两个项目） | demo 直接用 K8s 语料起步 = 项目第 0 版，无废代码 |
| 学习方式 | **边做边补**，项目牵引 | 资深工程师，API Fundamentals 融进 demo 学；Tool Use 等做"校验"时再补 |
| 不碰的方向 | 模型微调 / RLHF / vLLM 部署 / GraphRAG | 算法/MLOps 领域，应用开发用不上，ROI 低 |
| 模型 | `claude-opus-4-8`（最新 Opus，adaptive thinking） | 见 claude-api skill |

## 4. 迭代路线

```
迭代0(当前):RAG 跑通 = 给一段 K8s 字段文档,能问答  ← 即将开始
迭代1:加"校验"功能(此时上 Tool Use)
迭代2:加"自然语言生成 YAML"
迭代3:埋评估指标、做 Advanced RAG 优化
```

## 5. 目标架构（MVP）

```
用户输入(自然语言 / 一段 YAML)
   └─ Next.js 前端：Monaco 编辑器 + 流式展示
        └─ Node BFF：
             · 系统提示：角色 + 代码规范（常驻，prompt caching）
             · RAG：检索 K8s 字段规则（按需，向量库）
             · 调 Claude TS SDK + tool use
```

**关键认知（常驻 vs 按需）**：
- **常驻**（系统提示 / 每次全量）：角色、TS 代码规范、`ValidationError` 接口 → 适合系统提示
- **按需**（RAG 检索）：K8s 各资源字段规则 schema（量大）→ 进向量库

## 6. 即将开始的第一步

**最小 RAG demo 代码骨架（TS）**：Claude TS SDK 流式 + 本地 embedding 检索 + K8s 文档语料。
- 跑通它 = 同时摸到 RAG 四个点：切片 / 向量库 / 检索 / 流式。
- 顺手学会 API Fundamentals（SDK 调用就在骨架第一段）。
- 写代码前已调 `claude-api` skill 确认：模型 `claude-opus-4-8`、`thinking:{type:"adaptive"}`、流式用 `client.messages.stream()`、系统提示 + 检索上下文用 prompt caching。

## 7. 学习方法论：4D 框架

| D | 中文 | 本质 |
|---|------|------|
| Delegation | 委派 | 什么交给 AI、什么自己做 |
| Description | 描述 | 把需求讲清(背景/任务/规则三段式) |
| Discernment | 辨别 | 评估 AI 输出对不对、好不好 |
| Diligence | 尽责 | 负责任地用、透明、担责 |

转型核心：技能从"手会做"上移到"会判断 + 会指挥 AI"。借助 AI 完成算技能——前提是**能 own 它**（讲得清原理、能改、能调、能担责）。

## 8. 关键链接

- **Notion 项目主页**：https://app.notion.com/p/37a7fcc7225281b2ad40d1a1148b4c79
- **Notion 课程追踪库**（权威版本，含全部真实课程链接 + 4D 映射）：在上面主页内
- **Anthropic 课程**：https://anthropic.skilljar.com/ （Claude 101 已完成 5/14）
- **Cookbook（RAG 配方）**：https://github.com/anthropics/anthropic-cookbook
- **anthropics/courses（Prompt/Tool use/评估）**：https://github.com/anthropics/courses

## 9. 转型四大短板（项目要针对性补）

1. 停留在调 API → 项目里碰真问题（切片/召回/Agent 编排），记进复盘
2. 业务工程协同弱 → 作者主场（8 年 ToB），加"工程约束设计"章节（成本/隐私/裁剪）
3. 项目没指标 → 从第一天埋指标桩（见 Notion 库指标埋点）
4. 场景设计弱 → 走全链路框架：需求→数据→架构→指标→迭代

---

_下一步：在本目录 `cd ~/workspace/k8s-yaml-assistant` 起新 session，让我给出迭代 0 的 RAG demo 代码骨架。_

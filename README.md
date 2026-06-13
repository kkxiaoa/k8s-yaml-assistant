# K8s YAML 智能助手

实战项目,按迭代推进。当前能力:

| 命令 | 能力 | 迭代 |
|------|------|------|
| `npm run ask -- "<问题>"` | RAG 问答:检索 K8s 字段文档并作答 | 迭代0 ✅ |
| `npm run check -- <file.yaml>` | 校验 StorageClass(Tool Use:模型主动调用校验工具) | 迭代1 ✅ |
| `npm run gen -- "<需求>"` | 自然语言生成 YAML + 自检修正闭环(生成→校验→修正) | 迭代2 ✅ |
| `npm test` | `validateStorageClass` 纯函数单测 | 迭代1 ✅ |

## RAG 问答(ask)的四要素

| 要素 | 代码位置 |
|------|---------|
| 切片(语料分块) | `src/corpus.ts` |
| 向量库(内存) | `src/retrieve.ts` → `buildIndex()` |
| 检索(余弦相似度) | `src/retrieve.ts` → `retrieve()` |
| 流式作答 | `src/ask.ts` → `client.messages.stream()` |

| 要素 | 代码位置 |
|------|---------|
| 切片(语料分块) | `src/corpus.ts` |
| 向量库(内存) | `src/retrieve.ts` → `buildIndex()` |
| 检索(余弦相似度) | `src/retrieve.ts` → `retrieve()` |
| 流式作答 | `src/ask.ts` → `client.messages.stream()` |

## 技术选型(迭代 0)

- 纯 Node CLI(TypeScript,用 `tsx` 直接跑,无构建步骤)
- 内存向量 + 余弦相似度(语料就几段,不引向量库)
- 远程 embedding:Voyage AI
- 作答:**Anthropic SDK 接 DeepSeek** 的 Anthropic 兼容端点(`api.deepseek.com/anthropic`),便宜;
  模型传 `claude-sonnet-4-6`(DeepSeek 映射到 deepseek-v4-flash)。以后换回真 Claude 只改 baseURL + key。

## 运行

```bash
cd k8s-yaml-assistant
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY 和 VOYAGE_API_KEY

# RAG 问答
npm run ask -- "reclaimPolicy 能填哪些值?默认是什么?"
npm run ask -- "怎么允许 PVC 扩容?"

# 校验(Tool Use):模型会主动调用 validate_storageclass 工具
npm run check -- examples/storageclass-invalid.yaml   # 4 个错,逐条解释+修复建议
npm run check -- examples/storageclass-valid.yaml     # 校验通过

# 生成 + 自检修正闭环
npm run gen -- "用 AWS EBS CSI、保留策略、延迟绑定、允许扩容的 StorageClass,名字 prod-ssd"

# 单测(纯函数,无需 key)
npm test
```

## 验收标准(迭代 0 完成 = 以下都成立)

1. 问 StorageClass 字段问题,**检索命中的是 StorageClass 相关片段**(不是被 PVC/快照干扰项带偏)。
2. 回答**只依据检索到的文档**,枚举值列全(如 reclaimPolicy = Delete/Retain)。
3. 问语料里没有的内容,助手明确说"没有相关信息",**不编造**。
4. 输出是**流式**的(逐字出现,不是憋到最后一次性蹦出)。

## 迭代 1 验收(Tool Use)

- `npm test` 8 项全过
- `npm run check -- examples/storageclass-invalid.yaml`:日志出现 `[tool] validate_storageclass → 4 个问题`,
  模型逐条解释 4 个错(apiVersion / name / provisioner / reclaimPolicy)并给修复建议
- `validateStorageClass` 是**纯函数**,`ValidationError = { path, message }`,path 未来直接接 Monaco 定位高亮

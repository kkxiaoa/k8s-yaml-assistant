# Faithfulness Bad-case 回灌设计

## 1. 背景

当前检索评估已经把 serving 未命中自动写入
`data/eval/bad-cases.jsonl`，旧记录来自 retrieval eval，按失败层区分为
`retrieval_miss` 与 `rerank_miss`。Faithfulness 评估则只产出：

- `data/eval/faith/<runId>.jsonl`：逐条回答、检索结果、judge
  verdict 和 outcome。
- `data/eval/runs/<runId>.json`：汇总指标和模型配置。

因此，`hallucination`、`refused_wrong`、`judge_failed` 等真实失败虽可
在临时 trace 中诊断，却没有进入持久 bad-case 闭环。Faith trace 和 run
目录均被 gitignore，不能作为长期问题台账。

本轮目标是把已存在的 faith 诊断结果确定性转换为可审核、可去重、可关联、
可持续复测的 bad case。它不修改 Ask、检索、生成或 judge 行为。

## 2. 本轮范围

### 2.1 包含

- 从指定 faith run 生成 bad-case 候选。
- 默认只预览，显式 `--write` 才写入。
- 按失败层和失败类型独立管理 issue。
- 将 generation issue 与已有 retrieval issue 关联。
- `bad-cases.jsonl` 只保留 canonical issue ID。
- 保留人工维护的状态、严重度、备注和 eval 关联。
- 增加本地、无网络的分类、幂等、合并和 CLI 测试。

### 2.2 不包含

- 不自动修改 prompt、retrieval 或 generation。
- 不从 faith top-k 猜测 coarse retrieval 和 rerank 的具体责任。
- 不自动推断 `knowledge_missing`。
- 不自动关闭、重开或调整人工 triage 状态。
- 不新增重复 eval case。
- 不建设数据库、UI feedback 或完整 Stage 7 在线反馈系统。
- 不做 Claim-level Grounding。

## 3. 方案选择

采用确定性转换器，不引入候选文件：

```bash
npm run badcases:faith -- <runId>
npm run badcases:faith -- <runId> --write
```

第一条命令只输出候选和合并计划；第二条命令在相同输入上执行持久化。
候选由 faith trace 和 run 元数据确定性重算，避免新增
`data/eval/candidates` 临时状态。

不采用以下方案：

- 每次 `eval:faith` 自动写入：smoke run、模型抖动或未校准 judge
  会直接污染长期数据。
- 候选文件再 promote：当前规模下增加了不必要的中间状态和清理成本。
- 完整反馈服务：超出本轮离线闭环目标。

## 4. 架构与数据流

```text
data/eval/faith/<runId>.jsonl
data/eval/runs/<runId>.json
                |
                v
readFaithBadCaseInput()
  - 校验文件存在
  - 校验 run.id / kind
  - 校验 run 的 evalSetHash 与 trace 选择集一致
  - 新 run 额外校验 evalSetVersionHash 与当前 EVAL_SET 一致
  - 校验 trace case 是当前 EVAL_SET 的一致子集
                |
                v
buildFaithBadCaseCandidates() 纯函数
  - outcome 分类
  - canonical issue ID
  - retrieval issue 关联
  - create/recur/skip/warning 决策
                |
                v
previewFaithBadCases()
  - 默认只打印，不写文件
                |
                v  --write
mergeBadCaseIssues()
  - 内存完成全量校验和合并
  - 一次覆盖 bad-cases.jsonl
```

建议组件边界：

- `src/eval/bad-cases.ts`
  - BadCase schema、canonical ID、读取、校验和合并。
  - 不依赖 CLI 参数，不读取 faith run。
- `src/eval/faith-bad-cases.ts`
  - Faith outcome 到候选 issue 的纯转换逻辑。
  - 不直接写文件，不调用模型或检索。
- `scripts/faith-bad-cases.ts`
  - 解析 `runId` / `--write`，读取输入、输出 preview、触发持久化。
- `src/eval/faith-bad-cases.test.ts`
  - outcome 矩阵、关联、幂等、状态保护和历史输入测试。

## 5. Run 与 Trace 输入

转换器必须同时读取：

```text
data/eval/faith/<runId>.jsonl
data/eval/runs/<runId>.json
```

输入校验：

1. 两个文件都必须存在。
2. run 的 `id` 必须等于参数 `runId`。
3. `runKind(run)` 必须为 `faith`。
4. run 的 `evalSetHash` 必须等于 trace 中实际评估 case 的
   `computeEvalSetHash(trace cases)`，用于确认 run 元数据和 trace 文件一致。
5. 同一 trace 文件中 eval case ID 不得重复。
6. trace 的每个 eval case 必须是当前 `EVAL_SET` 的子集；历史 trace
   使用 ID、question 和 expected chunks 共同校验同 ID case，不能只凭 ID
   静默接受已发生语义变化的 case。
7. 新 run 必须额外写入 `evalSetVersionHash=computeEvalSetHash(EVAL_SET)`；
   存在该字段时必须等于当前全量 `EVAL_SET` hash。历史 run 不含该字段时，
   只要逐 case 对齐通过，就允许继续分析，并在 preview 中提示 legacy run
   缺少全量版本闸。

任一校验失败时整批失败，不产生部分写入。

注意：当前历史 faith run 的 `evalSetHash` 是选中子集 hash；`--policy` 和
`--smoke` 的 trace 只包含选中子集。后续通过新增 `evalSetVersionHash`
保存全量版本 hash，避免把“选择集一致性”和“全量 eval-set 版本闸”混成
一个字段。

后续 faith run 在 `EvalRun` 中增加：

```ts
interface FaithRunSelection {
  scope: 'full' | 'policy' | 'smoke';
  caseIds: string[];
}

interface EvalRun {
  // existing fields...
  evalSetVersionHash?: string;
  judgeModel?: string;
  faithSelection?: FaithRunSelection;
}
```

历史 run 不含 `faithSelection` 时，为兼容现有产物，允许从 run ID 的
`-policy` / `-smoke` 后缀推断 scope；无后缀视为 full。新 run 不再依赖
文件名推断。

## 6. BadCase Issue 模型

### 6.1 Issue 粒度

一个 bad case 表示一个独立失败问题，而不是一个问题文本。同一个 eval case
可以同时存在 retrieval 和 generation 两条 issue，并分别 triage、修复和
关闭。

canonical ID：

```text
sha1(evalCaseId + "\n" + failure.layer + "\n" + failure.type)
  .slice(0, 12)
```

ID 不包含 question 和 expected source IDs，避免文案或标注演进导致同一问题
产生新身份。

### 6.2 新增字段

```ts
interface BadCaseOrigin {
  evalCaseId: string;
  source: 'retrieval_eval' | 'faith_eval';
  firstSeenAt: string;
  lastSeenAt: string;
  firstSeenRunId?: string;
  lastSeenRunId?: string;
  observedRunIds: string[];
  occurrenceCount: number;
  scope?: 'full' | 'policy' | 'smoke';
  models?: {
    embedding?: string;
    rerank?: string;
    answer?: string;
    judge?: string;
  };
}

interface BadCase {
  // existing fields...
  origin: BadCaseOrigin;
  relatedBadCaseIds?: string[];
}
```

`actual` 继续承担最近一次可复现快照，并扩展结构化评估信息：

```ts
interface BadCaseActual {
  answer?: string;
  yaml?: string;
  sourceIds?: string[];
  traceId?: string;
  diagnostics?: Array<{ stage: string; message: string }>;
  evaluation?: {
    runId: string;
    scope: 'full' | 'policy' | 'smoke';
    outcome: FaithOutcome;
    unsupportedClaims: string[];
    judgeReason?: string;
  };
}
```

bad case 会持久化 answer、source IDs、unsupported claims、judge reason 和
模型配置。即使被 gitignore 的原 run/trace 被清理，问题仍保留足够的复盘
证据。

### 6.3 重复出现与人工字段保护

同一个 issue 在新 run 再次出现时：

- `observedRunIds` 追加新 run ID。
- `occurrenceCount` 增加。
- 更新 `lastSeenAt`、`lastSeenRunId`、模型配置和 `actual` 最新快照。
- 不覆盖 `failure.note`、`severity` 和 `status`。

同一个 run 重复 `--write` 时，因 `observedRunIds` 已包含 run ID，结果为
`already_imported`，不得增加次数或改写文件。

## 7. Bad Case Canonical 数据要求

`bad-cases.jsonl` 不再兼容旧 ID：

```text
sha1(taskType + question + expected source IDs)
```

唯一合法身份是：

```text
origin.evalCaseId + failure.layer + failure.type
```

要求：

1. 每条 bad case 必须有 `origin.evalCaseId`。
2. `id` 必须等于 `canonicalBadCaseId(origin.evalCaseId, layer, type)`。
3. `origin.source` 标明来源：`retrieval_eval` 或 `faith_eval`。
4. rerank 质量问题使用 `rerank + rerank_miss`，不写成 `rerank + retrieval_miss`。
5. 读文件时发现缺 `origin` 或 ID 不匹配应直接失败，不做静默迁移。
6. 同一 canonical ID 重复出现时只做合并：保留人工状态，更新最新观测。

`retrievalMiss()` 后续必须接收 `evalCaseId`，确保新记录直接使用 canonical
ID。若 eval case 缺少 ID，不允许退回 question-based ID。

## 8. Outcome 到 Issue 的映射

Faith outcome 是一条 faith eval 结果的诊断；回灌操作是转换器对
`bad-cases.jsonl` 的处理。

| Faith outcome | 诊断含义 | 回灌操作 |
|---|---|---|
| `faithful_hit` | 检索完整，回答忠实 | skip |
| `faithful_miss` | 检索不完整，回答未编造 | 不新增 generation issue；报告已有 retrieval issue |
| `hallucination` | 检索完整，回答仍有无依据主张 | 创建/更新 `generation + hallucination` |
| `dual_cause` | 检索不完整，回答也有无依据主张 | 创建/更新 `generation + hallucination`，关联 retrieval issue |
| `refused_correctly` | 不可答问题正确拒答 | skip |
| `refused_wrong` | 不可答问题仍编造答案 | 创建/更新 `generation + refusal_error` |
| `judge_failed` | judge 未返回有效判定 | 创建/更新 `judge + judge_error` |
| `error` | 网络或程序异常 | skip，显示运行异常 |

`knowledge_missing` 不能仅由 `fullRecall` 和 judge verdict 自动推断，只允许
后续人工 triage 标注。

## 9. Retrieval Issue 关联

Faith converter 不创建 retrieval bad case。

原因是现有 `FaithTrace` 只保存生成上下文 top-k，不能证明正确 chunk 是未进
coarse candidate，还是被 rerank/top-k 容量挤出。强行创建会伪造失败层归因。

处理规则：

- `dual_cause`：按同一 `evalCaseId` 查找 canonical
  `retrieval + retrieval_miss` issue。
  - 找到：generation issue 的 `relatedBadCaseIds` 加入 retrieval issue ID。
  - 找不到：保留 generation issue，同时 preview 输出
    `missing_retrieval_issue` warning，提示先运行 retrieval eval。
- `faithful_miss`：
  - 找到 retrieval issue：输出 `link_only`，不创建 generation issue。
  - 找不到：输出 `missing_retrieval_issue` warning，不创建任何 issue。

关联为 generation 到 retrieval 的单向引用，避免为了展示关系自动修改另一条
人工维护记录。两条 issue 的 status 始终独立。

## 10. Preview 与写入语义

preview 至少输出：

```text
run: <runId>  scope: policy  cases: 9

action             eval case                    issue
create             policy-conflict-latest       generation/hallucination
link_only          policy-conflict-privileged   retrieval/retrieval_miss
skip               policy-deploy-limits         faithful_hit

unsupported:
- policy-conflict-latest: ...

summary:
create=1 recur=0 already_imported=0 link_only=1 skip=7 warning=0
```

动作含义：

- `create`：新 issue。
- `recur`：已有 issue 在新 run 再次出现。
- `already_imported`：同一 run 已写入。
- `link_only`：没有生成问题，只命中已有 retrieval issue。
- `resolved_in_run`：选中 run 内已通过，但历史 issue 仍存在。
- `skip`：正常 outcome 或运行 error。
- `warning`：缺少关联 issue 等不阻断 generation issue 写入的问题。
- `error` outcome 虽不写入 bad case，也必须在 preview 中单独列出，至少展示
  eval case 和错误摘要。若同一 case 在多个 run 反复 error，后续可作为
  harness/runtime 诊断处理。

`--write` 只处理 `create` 和 `recur`。preview 中若存在输入校验错误，则禁止
写入；普通 warning 不阻断写入。

写入流程必须先在内存完成所有校验、候选构建和合并，再一次性覆盖
`bad-cases.jsonl`，避免部分写入。

## 11. Eval 关联与状态

Faith eval 直接消费 `EVAL_SET`，所以 faith bad case 创建时已经有对应 eval
case。不能再复制一条 `source='bad_case'` 的相同问题。

新 issue：

- `origin.evalCaseId=trace.id`。
- `status='new'`，表示仍待人工归因和修复。

后续 run 中 issue 对应 case 通过时：

- preview 显示 `resolved_in_run`。
- 不自动改为 `fixed`，因为单次模型/judge 结果可能有随机性。

已人工标记 `fixed` 的 issue 再次失败时：

- preview 显示 `recur`，并额外标注该 issue 当前为 `fixed`。
- `--write` 记录新观察。
- 不自动把 status 改回 `new`，由人工根据重复运行结果决定是否重开。

本轮完成的是“已有 eval failure 的持久问题台账”，不宣称扩大 eval 覆盖。
来自真实用户反馈的新问题转成新 eval case，属于后续完整 Stage 7。

## 12. 测试与验收

### 12.1 单元测试

- 8 种 FaithOutcome 的映射矩阵。
- canonical ID 对 question 和 expected source 变化保持稳定。
- 同 eval case 的 retrieval/generation issue ID 不同。
- `dual_cause` 正确关联 retrieval issue。
- 缺少 retrieval issue 时返回 warning，不伪造 retrieval 根因。
- 同一 run 重复导入为 `already_imported`。
- 新 run 再现时 occurrence count 增加。
- recurrence 更新最新证据，但保留人工 status、severity 和 note。
- 非 faith run、run ID 不匹配、选择集 evalSetHash 不匹配、重复 trace ID
  均整批失败。
- policy/smoke 子集 trace 的 `evalSetHash` 按选择集校验；新 run 还必须校验
  `evalSetVersionHash` 与当前全量 `EVAL_SET` 一致。
- 历史 run 缺少 `evalSetVersionHash` 时不失败，但 preview 必须提示 legacy
  run 缺少全量版本闸。
- preview 不修改 bad-cases 文件。

### 12.2 Canonical repository 测试

- 当前 `bad-cases.jsonl` 每条记录均有 `origin.evalCaseId`。
- 当前 `bad-cases.jsonl` 每条记录的 `id` 均等于 canonical ID。
- 同一 canonical ID 重复合并时保留人工 status/note。
- 合并后更新最新 actual 和 origin 观测信息。
- `retrievalMiss()` 对同一 eval case 生成相同 canonical ID。

### 12.3 真实历史 Run 验证

使用：

```text
2026-07-09T07-09-12-222Z-policy
```

预期：

- `policy-conflict-latest`：
  `create generation/hallucination`。
- `policy-conflict-privileged`：
  `link_only retrieval/retrieval_miss`。
- 其余 7 条：
  `skip`。
- preview 后 `git diff` 不包含 bad-cases 变化。
- 第一次 `--write` 新增 1 条 generation issue。
- 第二次对同一 run 执行 `--write` 为幂等，不增加记录和 occurrence count。

### 12.4 工程验证

```bash
npx tsx src/eval/faith-bad-cases.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
git diff --check
```

所有测试不得调用模型、embedding、rerank 或网络。

## 13. 实施边界

实施计划应拆成独立 Task，并在每个 Task 后停下 review：

1. BadCase canonical schema 与 repository 测试。
2. Faith candidate 纯转换器和 outcome/关联测试。
3. Run selection 元数据和 CLI preview。
4. `--write` 幂等合并与真实历史 run 验证。
5. 全量回归和文档对齐。

未经用户 review 不提交 commit，不自动进入下一 Task。

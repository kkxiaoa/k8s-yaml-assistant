# 检索优化(债 A):A1 top-k 容量 + A2 voyage-4 A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 measure-driven 的单变量实验解 Stage 6 遗留的两类检索问题——A1(top-k 容量竞争,k 3→5)与 A2(voyage-4 embedding 是否改善跨语言字段召回),每步只改一个变量、看指标再决定下一步。

**Architecture:** A1 只调 k(三处分开:检索 eval / faith `CONTEXT_K` / serving),验证后按决策门槛决定是否采纳。A2 把硬编码的 `EMBEDDING_MODEL` / `INDEX_DIR` 改成可切换,用隔离索引目录跑 voyage-3 vs voyage-4 的 A/B,不覆盖正式 `data/index`。

**Tech Stack:** TypeScript(严格模式)、Voyage embedding/rerank、tsx、node 自定义 `check()` 测试 runner。

**Spec:** `docs/superpowers/specs/2026-07-07-retrieval-optimization-design.md`

**Baseline:** 当前 serving Recall@3 = 89.5%(不 promote,仅作本轮对比基准)。

---

## File Structure

**A1 修改:**
- `src/eval/faithfulness-eval.ts` — `CONTEXT_K` 3→5(faith context size)
- `src/server/pipeline.ts` — `retrieveContext` 默认 k(仅在 A1 采纳时改)

**A2 修改:**
- `src/retrieval/embeddings.ts` — `EMBEDDING_MODEL` 读 env;`embed()` 加可选 `model` 参数
- `src/retrieval/index-store.ts` — `INDEX_DIR` 读 env;`readIndex`/`writeIndex` 加可选 `dir` 参数
- `scripts/index-build.ts` — 传 env 的 model/dir(隔离索引构建)
- `package.json` — 加 `voyage:ab` script

**A2 新建:**
- `src/retrieval/embeddings.test.ts` — env/参数切换单测
- `scripts/voyage-ab.ts` — voyage-3 vs voyage-4 A/B(12 case Recall/MRR)

---

## Task 1 (A1): top-k 容量竞争验证与条件采纳

这是 measure-driven 实验:先跑对比,再按决策门槛决定是否采纳。**不是无脑改 k=5**。

**Files:**
- Modify: `src/eval/faithfulness-eval.ts`
- Modify(条件): `src/server/pipeline.ts`

- [ ] **Step 1: 记录 baseline(检索 k=3)**

Run: `npm run eval 2>&1 | tail -12`
Expected: serving Recall@3 ≈ 89.5%。记下 serving 行的 Recall/MRR。这是 A1 对照基线。(撞 Voyage 3RPM,~25min,后台跑:`npm run eval > /tmp/a1-k3.log 2>&1 &` 然后读 log。)

- [ ] **Step 2: 跑检索 k=5,对比容量竞争是否缓解**

Run: `npm run eval -- 5 2>&1 | tail -12`
Expected: 输出 serving Recall@5 / MRR@5。**重点看 top-k 竞争 case**——"怎么允许 PVC 扩容?"(期望 `StorageClass::allowVolumeExpansion`,k=3 时被 `policy.storageclass.allowVolumeExpansion` 挤掉)在 k=5 是否命中。对比 Recall@3 vs @5 的差。(同样后台跑。)

- [ ] **Step 3: faith 的 CONTEXT_K 3→5**

`src/eval/faithfulness-eval.ts` 里 `const CONTEXT_K = 3;` 改为:

```ts
/** 上下文取 rerank 后 top-N。A1 实验:3→5 验证多源冲突 case 能否同时拿到 policy + schema 依据。 */
const CONTEXT_K = 5;
```

- [ ] **Step 4: 跑 faith,看冲突 case 的 faithful 能否翻转**

Run(后台,~30min): `npm run eval:faith > /tmp/a1-faith-k5.log 2>&1 &` — 完成后读 log。
Expected: **重点看 `policy-conflict-latest` / `policy-conflict-nodeport`**——k=3 时它们 `faithful=false`(讲 schema 层却没召回对应 schema chunk);k=5 让 policy + schema chunk 都进 context 后,`faithful` 能否转 true。记录翻转的 case 数。

- [ ] **Step 5: 按决策门槛决策(spec §7)**

判据(定性,不设硬阈值):
- **若** k=5 让冲突 case faithful 明显翻转(≥1 条 false→true)且 Recall@5 不低于 @3 → **采纳 k=5**:
  - `src/server/pipeline.ts` 的 `retrieveContext(question, k = 3, ...)` 默认值改 5(三处口径一致:eval 已支持传参、faith 已改、serving 跟上);
  - faith baseline 需重建(top-3 的 97.4% 不再可比)——跑 `npm run eval:faith` 后 `npm run eval:promote -- <faith run 路径>`(kind=faith)。
- **否则**(faith 无翻转 / Recall 掉) → **回滚**:`CONTEXT_K` 改回 3,记录"k=5 无收益"结论,直接进 Task 2(A2)。

- [ ] **Step 6: Commit(仅采纳时)**

给用户 review 后:

```bash
# 采纳 k=5:
git add src/eval/faithfulness-eval.ts src/server/pipeline.ts data/eval/baseline.faith.json
git commit -m "perf(debt-a): A1 top-k 3→5 缓解多源容量竞争,faith baseline 重建"
# 或回滚:
git add src/eval/faithfulness-eval.ts
git commit -m "chore(debt-a): A1 记录 k=5 无收益,CONTEXT_K 保持 3"
```

> ⚠ 不擅自 commit——Step 5 的结论和 Step 6 的 commit 都要先给用户看数据、批准后再落。

---

## Task 2 (A2 基建): embedding model 与索引目录可切换

把两个硬编码 const 改成可切换,为 A/B 铺路。**默认行为不变**(仍 voyage-3 + `data/index`),现有 eval/serving 零影响。TDD。

**Files:**
- Modify: `src/retrieval/embeddings.ts`
- Modify: `src/retrieval/index-store.ts`
- Modify: `scripts/index-build.ts`
- Create: `src/retrieval/embeddings.test.ts`
- Modify: `package.json`(挂 embeddings.test)

- [ ] **Step 1: 写 embeddings 可切换的失败测试(embeddings.test.ts)**

用现有 `check()` runner(参照 `src/validation/validate.test.ts` 的写法)。断言:

```ts
// 默认 EMBEDDING_MODEL 是 voyage-3;env VOYAGE_EMBEDDING_MODEL 覆盖它
import { resolveEmbeddingModel } from './embeddings';
check('默认 embedding model 是 voyage-3', () => {
  delete process.env.VOYAGE_EMBEDDING_MODEL;
  assert.equal(resolveEmbeddingModel(), 'voyage-3');
});
check('env VOYAGE_EMBEDDING_MODEL 覆盖默认', () => {
  process.env.VOYAGE_EMBEDDING_MODEL = 'voyage-4';
  assert.equal(resolveEmbeddingModel(), 'voyage-4');
  delete process.env.VOYAGE_EMBEDDING_MODEL;
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx src/retrieval/embeddings.test.ts`
Expected: FAIL(`resolveEmbeddingModel` 未导出)

- [ ] **Step 3: embeddings.ts 支持 env + model 参数**

`src/retrieval/embeddings.ts` 顶部改:

```ts
/** 解析当前 embedding 模型:env VOYAGE_EMBEDDING_MODEL 优先,默认 voyage-3。 */
export function resolveEmbeddingModel(): string {
  return process.env.VOYAGE_EMBEDDING_MODEL ?? 'voyage-3';
}

/** 当前 embedding 模型名(默认路径用)。索引 indexHash 依赖它:换模型即让旧索引失效。 */
export const EMBEDDING_MODEL = resolveEmbeddingModel();
```

`embed` 加可选 `model` 参数(默认走 `resolveEmbeddingModel()`,A/B 脚本可显式传):

```ts
export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
  model: string = resolveEmbeddingModel(),
): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error('VOYAGE_API_KEY 未设置。复制 .env.example 为 .env 并填入,或 export VOYAGE_API_KEY=...');
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: batch, model, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as VoyageResponse;
    out.push(...json.data.map((d) => d.embedding));
  }
  return out;
}
```

删掉旧的 `const MODEL = EMBEDDING_MODEL;`(不再用)。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx src/retrieval/embeddings.test.ts`
Expected: PASS(2 项)

- [ ] **Step 5: index-store 的目录可切换**

`src/retrieval/index-store.ts` 把 4 个 path const 改为按 env 解析,并给 read/write 加可选 `dir` 参数:

```ts
/** 索引目录:env INDEX_DIR 优先,默认 data/index。A/B 用隔离目录(如 data/index-ab)。 */
export function resolveIndexDir(): string {
  return process.env.INDEX_DIR ?? join(process.cwd(), 'data', 'index');
}
export const INDEX_DIR = resolveIndexDir();
```

`writeIndex(index, embeddingModel, dir = resolveIndexDir())` 和 `readIndex(dir = resolveIndexDir())` 加 `dir` 参数,函数体里 `MANIFEST_PATH`/`CHUNKS_PATH`/`EMBEDDINGS_PATH` 改成基于传入 `dir` 的局部变量:

```ts
export function writeIndex(
  index: IndexedChunk[],
  embeddingModel: string,
  dir: string = resolveIndexDir(),
): IndexManifest {
  const manifestPath = join(dir, 'manifest.json');
  const chunksPath = join(dir, 'chunks.jsonl');
  const embeddingsPath = join(dir, 'embeddings.f32');
  // ...原逻辑,mkdirSync(dir,...) + 三个写盘改用局部 path
}

export function readIndex(
  dir: string = resolveIndexDir(),
): { manifest: IndexManifest; chunks: IndexedChunk[] } | null {
  const manifestPath = join(dir, 'manifest.json');
  const chunksPath = join(dir, 'chunks.jsonl');
  const embeddingsPath = join(dir, 'embeddings.f32');
  if (!existsSync(manifestPath) || !existsSync(chunksPath) || !existsSync(embeddingsPath)) return null;
  // ...原逻辑,读盘改用局部 path
}
```

删掉模块级的 `MANIFEST_PATH`/`CHUNKS_PATH`/`EMBEDDINGS_PATH` const(改为函数内局部)。

- [ ] **Step 6: index-build 传 env 的 model/dir**

`scripts/index-build.ts` 用 `resolveEmbeddingModel()` 作嵌入 model、`resolveIndexDir()` 作写盘目录、`writeIndex(index, resolveEmbeddingModel(), resolveIndexDir())`。这样 `VOYAGE_EMBEDDING_MODEL=voyage-4 INDEX_DIR=data/index-ab npm run index:build` 会把 voyage-4 索引写进隔离目录。读 `scripts/index-build.ts` 现有写盘调用,把 model/dir 换成上面两个 resolve 函数。

- [ ] **Step 7: 挂测试 + tsc + 全量 test + 默认行为冒烟**

先把 `embeddings.test.ts` 追加到 `package.json` 的 `test` 脚本。然后:
Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: 全绿(含 embeddings 2 项)。

Run: `npx tsx -e "import {EMBEDDING_MODEL} from './src/retrieval/embeddings'; import {INDEX_DIR} from './src/retrieval/index-store'; console.log(EMBEDDING_MODEL, INDEX_DIR)"`
Expected: `voyage-3 .../data/index`(默认没变)。

- [ ] **Step 8: Commit**

给用户 review 后:

```bash
git add src/retrieval/embeddings.ts src/retrieval/embeddings.test.ts src/retrieval/index-store.ts scripts/index-build.ts package.json
git commit -m "feat(debt-a): embedding model + 索引目录可 env 切换(为 voyage-4 A/B 铺路,默认不变)"
```

---

## Task 3 (A2 A/B): voyage-4 隔离索引 + A/B 对比 + 决策

**Files:**
- Create: `scripts/voyage-ab.ts`
- Modify: `package.json`(加 `voyage:ab`)

- [ ] **Step 1: 构建 voyage-4 隔离索引(后台,~7min)**

Run(后台,撞 3RPM 限流):
```bash
VOYAGE_EMBEDDING_MODEL=voyage-4 INDEX_DIR=data/index-ab npm run index:build > /tmp/voyage4-build.log 2>&1 &
```
完成后验证隔离目录:`ls data/index-ab/`(应有 manifest.json / chunks.jsonl / embeddings.f32),`manifest.json` 的 `embeddingModel` 应是 `voyage-4`、`count` 8127。**正式 `data/index` 不受影响**(仍 voyage-3)。

- [ ] **Step 2: 写 voyage-ab.ts(12 case A/B)**

12 个 case = 10 条 retrieval miss + 2 条 policy conflict。脚本对每 case 走 dense(cosine)+ rerank,分别用 voyage-3 索引(`data/index`)和 voyage-4 索引(`data/index-ab`)算 Recall@3,并列输出对比。

```ts
// A2 voyage-3 vs voyage-4 A/B。对 12 个 bad-case 统计 Recall@3。
// 前置:先 VOYAGE_EMBEDDING_MODEL=voyage-4 INDEX_DIR=data/index-ab npm run index:build 建好隔离索引。
// 用法:npm run voyage:ab

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embed } from '../src/retrieval/embeddings';
import { readIndex } from '../src/retrieval/index-store';
import { rerank } from '../src/retrieval/rerank';
import { inferResource, RESOURCE_BOOST } from '../src/retrieval/router';
import { EVAL_SET } from '../src/eval/eval-set';

interface ABCase { question: string; expectedChunkIds: string[]; label: string; }

// A/B 用例 = 真实沉淀的 retrieval miss(从 bad-cases.jsonl 动态读,不臆造 id)
// + 2 条检索已命中的 policy conflict 作对照。
function loadABCases(): ABCase[] {
  const bad: ABCase[] = readFileSync(join(process.cwd(), 'data', 'eval', 'bad-cases.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as {
      id: string; input: { question: string }; expected: { sourceIds: string[] }; failure: { type: string };
    })
    .filter((o) => o.failure?.type === 'retrieval_miss')
    .map((o) => ({ question: o.input.question, expectedChunkIds: o.expected.sourceIds, label: o.id }));
  const conflict: ABCase[] = EVAL_SET
    .filter((c) => c.id === 'policy-conflict-latest' || c.id === 'policy-conflict-nodeport')
    .map((c) => ({ question: c.question, expectedChunkIds: c.expectedChunkIds, label: c.id }));
  return [...bad, ...conflict];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0, bi = b[i] ?? 0;
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

async function recallForModel(dir: string, model: string): Promise<{ recall: number; hitIds: string[] }> {
  const idx = readIndex(dir);
  if (!idx) throw new Error(`索引缺失:${dir}(先建好隔离索引)`);
  const cases = loadABCases();
  const qEmb = await embed(cases.map((c) => c.question), 'query', model);

  let recallSum = 0;
  const hitIds: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const ec = cases[i]!;
    const routed = inferResource(ec.question);
    // dense 软加权粗召回(与 serving 同口径:cosine + resource boost),取 coarse 候选送 rerank
    const scored = idx.chunks.map((c) => ({
      chunk: c,
      score: cosine(qEmb[i]!, c.embedding) + (routed && c.resource === routed ? RESOURCE_BOOST : 0),
    })).sort((a, b) => b.score - a.score).slice(0, 10);
    const rr = await rerank(ec.question, scored.map((s) => s.chunk.text), scored.length);
    const top3 = rr.slice(0, 3).map((r) => scored[r.index]!.chunk.id);
    const found = ec.expectedChunkIds.filter((id) => top3.includes(id));
    const recall = found.length / ec.expectedChunkIds.length;
    recallSum += recall;
    if (recall === 1) hitIds.push(ec.label);
    console.error(`  [${model}] ${recall === 1 ? '✓' : '✗'} ${ec.label}`);
  }
  return { recall: recallSum / cases.length, hitIds };
}

async function main(): Promise<void> {
  console.error('=== voyage-3 (data/index) ===');
  const v3 = await recallForModel(join(process.cwd(), 'data', 'index'), 'voyage-3');
  console.error('\n=== voyage-4 (data/index-ab) ===');
  const v4 = await recallForModel(join(process.cwd(), 'data', 'index-ab'), 'voyage-4');
  console.error('\n━━━━━━ A/B 汇总(12 case Recall@3) ━━━━━━');
  console.error(`voyage-3: ${(v3.recall * 100).toFixed(1)}%  命中: ${v3.hitIds.join(',') || '无'}`);
  console.error(`voyage-4: ${(v4.recall * 100).toFixed(1)}%  命中: ${v4.hitIds.join(',') || '无'}`);
  const gained = v4.hitIds.filter((id) => !v3.hitIds.includes(id));
  const lost = v3.hitIds.filter((id) => !v4.hitIds.includes(id));
  console.error(`voyage-4 新命中: ${gained.join(',') || '无'}  |  回退: ${lost.join(',') || '无'}`);
}

main().catch((e: unknown) => { console.error('错误:', e instanceof Error ? e.message : String(e)); process.exit(1); });
```

> 注:A/B 用例从 `bad-cases.jsonl` 的 `retrieval_miss` 动态读(真实沉淀、不臆造 id)+ 2 条 policy conflict eval-set case 作对照。bad-cases 数量变化时 A/B case 数随之变,属预期;`expected.sourceIds` 即该 case 的正确 chunk id。

- [ ] **Step 3: 挂 package.json script**

`package.json` scripts 加:`"voyage:ab": "tsx scripts/voyage-ab.ts"`。

- [ ] **Step 4: 跑 A/B**

Run(后台,~3min:24 次 rerank 撞限流): `npm run voyage:ab > /tmp/voyage-ab.log 2>&1 &` — 完成读 log。
Expected: 并列 voyage-3 vs voyage-4 的 12 case Recall@3 + 新命中/回退清单。

- [ ] **Step 5: tsc + Commit(脚本本身)**

Run: `npx tsc --noEmit -p tsconfig.json && npm test`(全绿)。给用户 review 后:
```bash
git add scripts/voyage-ab.ts package.json
git commit -m "feat(debt-a): voyage-3/voyage-4 A/B 脚本(12 bad-case Recall@3 对比)"
```

- [ ] **Step 6: 按决策门槛决策(spec §7)**

判据(定性):看 voyage-4 对那批跨语言 miss(裸块/延迟绑定/存储大小/镜像)是否**新命中**、有无回退。
- **voyage-4 明显提升**(新命中 ≥ 数条、几乎无回退)→ **升级默认 embedding**:`.env` 设 `VOYAGE_EMBEDDING_MODEL=voyage-4` + 重建正式 `data/index`(`npm run index:build`)+ 重跑 `npm run eval` 确认 serving Recall 净升 + promote baseline。这是独立收尾,给用户 review 后做。
- **无明显提升** → 记录结论,voyage-4 不升级,**进入 A3**(schema-aware query expansion,另出计划)。不回 BM25。

> A/B 用完的 `data/index-ab` 是临时产物,决策后可删(`rm -rf data/index-ab`);它已被 `data/index*` gitignore 覆盖(确认 `.gitignore` 含 `data/index`——若只精确匹配 `data/index/`,补一条 `data/index-ab/`)。

---

## 落地后状态

- A1:k=3→5 的多源容量竞争有没有解、faith 冲突 case 有没有改善,有数据结论 + 采纳/回滚决定。
- A2:voyage-4 对跨语言字段 miss 有没有用,有 12 case A/B 数据 + 升级/进 A3 决定。
- 全程单变量隔离,每步收益归因干净;正式 `data/index` 与默认 voyage-3 在 A/B 期间不受污染。

## 已知后续(不在本 plan)

- A3:schema-aware query expansion(仅当 A2 无提升才做,待 A2 结果另出计划)。
- top-k 竞争若 A1 用 k=5 仍未根治,per-source 保底名额是后续选项。

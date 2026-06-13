// 生成层评估:Faithfulness(忠实度 / 防幻觉)。Q4 的另一半。
// 流程:问题 → 检索(向量+软路由+rerank)→ 生成回答 → LLM 裁判判断回答是否"只说了文档支持的事"。
//
// 用法: npm run eval:faith
//
// 指标:
//   Faithfulness 率 —— 回答忠实(无幻觉)的比例。
//   拒答正确率     —— 语料里没有的问题,模型是否正确拒答(而非编造)。

import { config } from 'dotenv';
config({ override: true });
import Anthropic from '@anthropic-ai/sdk';
import { buildIndex, retrieve } from '../retrieval/retrieve';
import { inferResource } from '../retrieval/router';
import { rerank, COARSE_N } from '../retrieval/rerank';

const MODEL = 'claude-sonnet-4-6'; // 被测(生成):DeepSeek 映射 deepseek-v4-flash
const JUDGE_MODEL = 'claude-opus-4-8'; // 裁判:DeepSeek 映射 deepseek-v4-pro,更强 + 异构,减少"自己评自己"的偏袒

const ANSWER_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手。基于给定的 <docs> 片段回答问题。
规则:
- 只依据 <docs> 作答,不要编造文档里没有的字段、取值或步骤。
- 若片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 简洁准确,涉及枚举值时列全。用中文回答。`;

// 裁判提示:严格核查"回答的每个事实主张是否被文档支持"。
const JUDGE_SYSTEM = `你是严格的事实核查裁判。判断【回答】有没有编造【文档】里没有的具体事实。
判定规则:
- faithful=false 当且仅当:回答陈述了文档中找不到依据的**具体事实**(字段名、取值、默认值、步骤等)。
- faithful=true:回答只用了文档里有的事实;或回答是"文档中没有相关信息""无法回答"之类的**拒答**。
- 重要:"没有相关信息""文档未说明"这类话**本身不是需要核查的事实主张**。不要因为文档里碰巧包含别的字段,就判这种拒答为不忠实。判定的唯一关注点是:回答有没有**编造文档外的具体事实**。
- 忠实 ≠ 正确:回答即使在现实中是对的,只要文档没写,也算 faithful=false。
- 示例性数值不算编造:对文档已说明"用户可设置/可调大"的参数,回答给出明显是举例的占位数值(例如把"调大"举例成从 10Gi 改到 20Gi),属于合理示例,faithful=true。只有当回答把文档没有的内容当成**确定的字段名/枚举值/默认值/行为**来陈述时,才算 faithful=false。
只输出 JSON,不要代码围栏、不要任何额外文字:
{"faithful": true 或 false, "unsupported": ["文档不支持的具体主张,没有则空数组"], "reason": "一句话理由"}`;

interface FaithCase {
  question: string;
  /** true=语料能答;false=语料没有(应拒答,编造即幻觉) */
  answerable: boolean;
}

const FAITH_SET: FaithCase[] = [
  { question: 'reclaimPolicy 能填哪些值?默认是什么?', answerable: true },
  { question: 'Recycle 是 StorageClass 合法的回收策略吗?', answerable: true }, // 语料明说不支持
  { question: '怎么允许 PVC 扩容?', answerable: true },
  { question: 'volumeBindingMode 有哪些取值?', answerable: true },
  { question: '怎么把一个 StorageClass 设为集群默认?', answerable: false }, // default-class 注解,语料没有
  { question: 'PVC 能跨命名空间绑定别的命名空间的 PV 吗?', answerable: false }, // 语料没有
  // —— 诱导性用例:文档刚好没覆盖那一点,模型容易从训练知识补(忠实 ≠ 正确)——
  { question: 'allowVolumeExpansion 的默认值是什么?', answerable: false }, // 文档说了作用,没说默认值(现实是 false)
  { question: 'volumeBindingMode 不指定时默认用哪个?', answerable: false }, // 文档列了取值,没说默认(现实是 Immediate)
  { question: 'reclaimPolicy 默认是 Retain,对吗?', answerable: true }, // 假前提:文档说默认 Delete,应纠正而非附和
];

interface Verdict {
  faithful: boolean;
  unsupported: string[];
  reason: string;
}

/** 从可能带 ```json 围栏的文本里抠出 JSON 并解析。解析不出返回 null(=判定失败,不等于不忠实)。 */
function parseJson(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Verdict>;
    return {
      faithful: Boolean(o.faithful),
      unsupported: Array.isArray(o.unsupported) ? o.unsupported : [],
      reason: typeof o.reason === 'string' ? o.reason : '',
    };
  } catch {
    return null;
  }
}

async function textOf(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}

/** 调裁判;空/无法解析时重试一次,仍失败返回 null(=判定失败,不算幻觉)。 */
async function judge(
  client: Anthropic,
  context: string,
  answer: string,
): Promise<Verdict | null> {
  const user = `【文档】\n${context}\n\n【回答】\n${answer}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await textOf(client, JUDGE_MODEL, JUDGE_SYSTEM, user);
    const v = parseJson(raw);
    if (v) return v;
  }
  return null;
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  console.error(
    `Faithfulness 评估(${FAITH_SET.length} 条:生成→裁判,逐条调用,稍候)\n`,
  );
  const index = await buildIndex();

  let faithfulCount = 0;
  let judgedCount = 0; // 成功判定的条数(分母,排除判定失败)
  let judgeFailed = 0; // 裁判两次都没给出有效 JSON
  let answerableTotal = 0;
  let refusedCorrectly = 0; // 不可答的里,正确拒答的数量

  for (const fc of FAITH_SET) {
    // 检索(完整流水线:软路由 + rerank)
    const routed = inferResource(fc.question);
    const coarse = await retrieve(
      fc.question,
      index,
      COARSE_N,
      routed ?? undefined,
    );
    const rr = await rerank(
      fc.question,
      coarse.map((h) => h.chunk.text),
      3,
    );
    const hits = rr.map((r) => coarse[r.index]!.chunk);
    const context = hits.map((c) => `## ${c.title}\n${c.text}`).join('\n\n');

    // 生成
    const answer = await textOf(
      client,
      MODEL,
      ANSWER_SYSTEM,
      `参考以下文档回答。\n\n<docs>\n${context}\n</docs>\n\n问题:${fc.question}`,
    );
    // 裁判(更强的 JUDGE_MODEL,失败重试,仍失败=判定失败,不算幻觉)
    const v = await judge(client, context, answer);
    const tag = fc.answerable ? '[可答]' : '[应拒答]';
    const ans = answer.replace(/\s+/g, ' ').slice(0, 90);

    if (v === null) {
      judgeFailed++;
      console.error(
        `⚠ 判定失败(裁判两次未给有效 JSON) ${tag} | ${fc.question}`,
      );
      console.error(`   回答: ${ans}...`);
      continue;
    }

    judgedCount++;
    if (v.faithful) faithfulCount++;
    if (!fc.answerable) {
      answerableTotal++;
      if (v.faithful) refusedCorrectly++; // 不可答 + 忠实(没编造)= 正确拒答
    }

    console.error(
      `${v.faithful ? '✓ 忠实' : '✗ 幻觉'} ${tag} | ${fc.question}`,
    );
    console.error(`   回答: ${ans}...`);
    if (!v.faithful)
      console.error(`   未支持: ${v.unsupported.join(' / ')}  (${v.reason})`);
  }

  console.error('\n━━━━━━ 汇总 ━━━━━━');
  console.error(
    `Faithfulness 率 = ${judgedCount ? ((faithfulCount / judgedCount) * 100).toFixed(1) : '—'}%  (${faithfulCount}/${judgedCount} 已判定)`,
  );
  console.error(
    `拒答正确率(应拒答的)= ${answerableTotal ? ((refusedCorrectly / answerableTotal) * 100).toFixed(1) : '—'}%  (${refusedCorrectly}/${answerableTotal})`,
  );
  console.error(
    `判定失败(裁判未给有效 JSON,已重试)= ${judgeFailed} 条(不计入 Faithfulness)`,
  );
  console.error(
    `\n注:被测=${MODEL}(flash),裁判=${JUDGE_MODEL}(pro)——异构 + 更强裁判,降低自评偏袒。`,
  );
  console.error(
    '提醒:Faithfulness 衡量的是"忠于文档",不是"事实正确"。模型答出文档外的正确事实,也算不忠实。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

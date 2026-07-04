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
import { buildIndex, retrieve } from '../retrieval/retrieve';
import { inferResource } from '../retrieval/router';
import { rerank, COARSE_N } from '../retrieval/rerank';
import { getClient } from '../server/pipeline';
import { judge, JUDGE_MODEL } from './judge';
import { MODEL, generateAnswer } from './answer';

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

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();

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
    const answer = await generateAnswer(client, context, fc.question);
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

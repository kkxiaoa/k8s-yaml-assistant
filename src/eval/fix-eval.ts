// §6 fix 评估。对每条坏 YAML 跑 fixResource,量:修复成功 / 平均轮数 /
// kind 是否被改掉 / 意图保留(关键字段值是否仍在)。走 DeepSeek。
// 用法:npm run eval:fix

import { config } from 'dotenv';
config({ override: true });
import { getClient } from '../server/pipeline';
import { fixResource } from '../server/agent';
import { validateYamlDocuments } from '../validation/validate';
import { FIX_CASES } from './fix-cases';
import { docsOf, valuePreserved } from './generation-metrics';

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const n = FIX_CASES.length;
  console.error(`fix 评估(${n} 条坏 YAML,逐条调 DeepSeek,稍候…)\n`);

  let fixed = 0;
  let roundsSum = 0;
  let kindKept = 0;
  let intentKept = 0; // 全部 mustPreserve 保留的用例数
  let preserveHitSum = 0; // 保留项覆盖均值(合法者)

  for (const c of FIX_CASES) {
    // 先验坏 YAML 拿错误(fixResource 需要错误列表);若不报错说明用例设计有误
    const errs = validateYamlDocuments(c.brokenYaml).errors;
    if (errs.length === 0) {
      console.error(`⚠ ${c.id}:brokenYaml 没有校验错,用例无效`);
      continue;
    }

    const r = await fixResource(client, c.brokenYaml, errs);
    const valid = r.yaml !== null && validateYamlDocuments(r.yaml).errors.length === 0;
    const docs = valid ? docsOf(r.yaml!) : [];
    const kinds = docs.map((d) => d.kind);
    const kindOk = valid && kinds.includes(c.expectedKind);
    const preserved = c.mustPreserve.filter((p) =>
      valuePreserved(docs, p.path, p.value),
    );
    const allPreserved = valid && preserved.length === c.mustPreserve.length;

    if (valid) fixed++;
    roundsSum += r.rounds;
    if (kindOk) kindKept++;
    if (allPreserved) intentKept++;
    if (valid) preserveHitSum += preserved.length / c.mustPreserve.length;

    const mark = valid ? (kindOk && allPreserved ? '✓' : '△') : '✗';
    console.error(
      `${mark} ${c.id.padEnd(24)} [${c.defect}] 轮${r.rounds} kind=${kindOk ? 'ok' : (kinds.join(',') || '无') + '≠' + c.expectedKind} 保留=${preserved.length}/${c.mustPreserve.length}${valid ? '' : '  未修成合法 YAML'}`,
    );
  }

  const pct = (x: number, d = n) => `${((x / d) * 100).toFixed(1)}%`;
  console.error('\n━━━━━━ fix 评估 汇总 ━━━━━━');
  console.error(`修复成功率           : ${pct(fixed)}  (${fixed}/${n})`);
  console.error(`平均修复轮数         : ${(roundsSum / n).toFixed(2)}`);
  console.error(`kind 保持率(未改类型): ${fixed ? pct(kindKept, fixed) : '0%'}`);
  console.error(`意图完整保留率       : ${fixed ? pct(intentKept, fixed) : '0%'}`);
  console.error(`关键值保留覆盖(均值) : ${fixed ? pct(preserveHitSum, fixed) : '0%'}`);
  console.error(
    '\n说明:△=修成合法但改了 kind 或丢了关键字段;轮数=0 说明模型一次就把错改对。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

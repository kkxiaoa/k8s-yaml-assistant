// §6 生成评估。对每条用例跑生成引擎,量:修复成功 / 平均轮数 / 首发即对 /
// kind 匹配 / 必备路径覆盖 / 跨资源一致性。会花 DeepSeek 额度(每条一次 generate + 若干修复)。
// 纯度量函数在 ./generation-metrics(无副作用);本文件才有 main。
// 用法:npm run eval:gen

import { config } from 'dotenv';
config({ override: true });
import { getClient } from '../server/pipeline';
import { generateResource } from '../server/agent';
import { validateYamlDocuments } from '../validation/validate';
import { GENERATION_CASES } from './generation-cases';
import { CHECKS, docsOf, hasPath } from './generation-metrics';

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY 未设置');
    process.exit(1);
  }
  const client = getClient();
  const n = GENERATION_CASES.length;
  console.error(`生成评估(${n} 条用例,逐条调 DeepSeek,稍候…)\n`);

  let converged = 0;
  let firstTry = 0;
  let roundsSum = 0;
  let kindOk = 0;
  let pathCovSum = 0;
  let consTotal = 0; // 带一致性检查的用例数
  let consPass = 0; // 一致性全通过的用例数

  for (const c of GENERATION_CASES) {
    const r = await generateResource(client, { requirement: c.requirement });
    const ok = r.yaml !== null;
    const valid = ok && validateYamlDocuments(r.yaml!).errors.length === 0;
    const docs = ok ? docsOf(r.yaml!) : [];
    const kinds = docs.map((d) => d.kind).filter((k): k is string => !!k);
    const kindsMatch = c.expectedKinds.every((k) => kinds.includes(k));
    const pathsHit = c.mustHavePaths.filter((p) =>
      docs.some((d) => hasPath(d, p.split('.'))),
    );
    const pathCov = c.mustHavePaths.length
      ? pathsHit.length / c.mustHavePaths.length
      : 1;

    // 一致性(仅带 consistencyChecks 的用例)
    let consStr = '';
    let consAllPass = true;
    if (c.consistencyChecks?.length) {
      consTotal++;
      const results = c.consistencyChecks.map((k) => ({
        k,
        pass: valid && CHECKS[k](docs),
      }));
      consAllPass = results.every((x) => x.pass);
      if (consAllPass) consPass++;
      consStr =
        ' 一致性=' +
        results
          .map((x) => `${x.k.split('_')[0]}:${x.pass ? '✓' : '✗'}`)
          .join(' ');
    }

    if (valid) converged++;
    if (valid && r.rounds === 0) firstTry++;
    roundsSum += r.rounds;
    if (valid && kindsMatch) kindOk++;
    if (valid) pathCovSum += pathCov;

    const contentOk = kindsMatch && pathCov === 1 && consAllPass;
    const mark = valid ? (contentOk ? '✓' : '△') : '✗';
    console.error(
      `${mark} ${c.id.padEnd(24)} 轮${r.rounds} kind=${kindsMatch ? 'ok' : kinds.join(',') || '无'} 路径=${pathsHit.length}/${c.mustHavePaths.length}${consStr}${valid ? '' : '  未产出合法 YAML'}`,
    );
  }

  const pct = (x: number, d = n) => `${((x / d) * 100).toFixed(1)}%`;
  console.error('\n━━━━━━ 生成评估 汇总 ━━━━━━');
  console.error(
    `修复成功率(产出合法 YAML) : ${pct(converged)}  (${converged}/${n})`,
  );
  console.error(`首发即对率(0 轮修复)      : ${pct(firstTry)}`);
  console.error(`平均修复轮数               : ${(roundsSum / n).toFixed(2)}`);
  console.error(
    `kind 匹配率(合法者中)     : ${converged ? pct(kindOk, converged) : '0%'}`,
  );
  console.error(
    `必备路径覆盖(合法者均值)  : ${converged ? pct(pathCovSum, converged) : '0%'}`,
  );
  console.error(
    `跨资源一致性通过率         : ${consTotal ? pct(consPass, consTotal) : 'N/A'}  (${consPass}/${consTotal})`,
  );
  console.error(
    '\n说明:agent 只返回合法或 null,故"parse/校验通过"等价修复成功率;kind/路径/一致性是内容正确性,△=合法但内容不全或不一致。',
  );
}

main().catch((e: unknown) => {
  console.error('错误:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

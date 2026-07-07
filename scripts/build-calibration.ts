// 构造 judge calibration set(§7.2)。样本来自真实 faith 明细快照(真实 context + 真实答案),
// 人工 label 独立判定,按 faithfulness 严格定义(只忠于文档,不看现实正确)。
// 用法: npm run build:calibration —— 从最新全量 faith 明细取样,写 data/eval/judge-calibration.jsonl。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from '../src/knowledge/corpus';
import { FAITH_DIR, type FaithTrace } from '../src/eval/faith-store';
import { formatSources } from '../src/retrieval/sources';

interface Label {
  id: string;
  category:
    | 'faithful'
    | 'correct_refusal'
    | 'unsupported_default'
    | 'example_gray'
    | 'hallucinated'
    | 'policy_distinction'
    | 'policy_conflict';
  /** 人工独立判定:answer 是否只用了 context 里的事实(忠于文档) */
  faithful: boolean;
  /** policy 新维度:只填写该 case 应校准的维度;未填写的维度不计入 policy 一致率。 */
  policy?: {
    distinguished?: boolean;
    conflictExplained?: boolean;
    misstatedAsOfficial?: boolean;
  };
  note: string;
}

// 人工 label(独立判定,基于固化的 context+answer;不照抄 judge)
const LABELS: Label[] = [
  // faithful —— 忠于文档
  { id: 'pod-image', category: 'faithful', faithful: true, note: '照文档列 containers/initContainers.image' },
  { id: 'svc-type', category: 'faithful', faithful: true, note: '四个枚举值照文档' },
  { id: 'deploy-replicas', category: 'faithful', faithful: true, note: 'replicas 字段 + 默认 1,照文档' },
  { id: 'sc-reclaimpolicy', category: 'faithful', faithful: true, note: '枚举 Delete/Recycle/Retain + 默认 Delete,文档全有' },
  { id: 'quota-hard', category: 'faithful', faithful: true, note: '此 answer 干净复述 hard 字段作用,未举资源名' },
  { id: 'pdb-minavailable', category: 'faithful', faithful: true, note: '此 answer 只述 minAvailable 作用 + 100% 例,未编绝对数字' },
  { id: 'rolebinding-roleref', category: 'faithful', faithful: true, note: 'kind=Role / name / 当前命名空间,均 roleRef chunk 有据' },
  // correct_refusal —— 语料外正确拒答
  { id: 'refusal-prometheus-retention', category: 'correct_refusal', faithful: true, note: '语料外,正确拒答' },
  { id: 'refusal-nonexistent-field', category: 'correct_refusal', faithful: true, note: '虚构字段,正确拒答' },
  // hallucinated —— 确凿真幻觉
  { id: 'svc-nodeport', category: 'hallucinated', faithful: false, note: '"0<x<65536" 串了 containerPort;nodePort chunk 只说 in-range' },
  { id: 'pod-imagepullpolicy', category: 'hallucinated', faithful: false, note: '把"不可更新"扩大到 volumes.image(该 chunk 无此限制)=过度推广编造(初判偏宽,校准修正)' },
  // policy_distinction —— 纯 policy 问询:只校准是否区分官方事实与组织策略、是否误称官方强制。
  {
    id: 'policy-deploy-limits',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: false, misstatedAsOfficial: false },
    note: '答案正确标注资源限制为组织策略,并用 schema chunk 支撑字段层事实',
  },
  {
    id: 'policy-pod-privileged',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: true, misstatedAsOfficial: false },
    note: '问题虽是 policy 问询,答案实际同时说明 schema boolean/default 与 policy forbidden,且未误称官方强制',
  },
  {
    id: 'policy-sc-reclaim',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: false, misstatedAsOfficial: false },
    note: '纯 policy 问询,回答应标组织策略且不说成 K8s 官方强制',
  },
  {
    id: 'policy-secret-plaintext',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: true, misstatedAsOfficial: false },
    note: '答案同时说明 Secret data schema/base64 层与平台 discouraged 策略层,且未误称官方强制',
  },
  {
    id: 'policy-crb-admin',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: false, misstatedAsOfficial: false },
    note: '纯 policy 问询,回答应标组织策略且不说成 K8s 官方强制',
  },
  {
    id: 'policy-ingress-tls',
    category: 'policy_distinction',
    faithful: true,
    policy: { distinguished: true, conflictExplained: false, misstatedAsOfficial: false },
    note: '答案正确标注 Ingress TLS 为生产环境组织策略,并用 schema chunk 支撑字段层事实',
  },
  // policy_conflict —— schema/policy 冲突:校准是否同时表达字段校验层与组织策略层。
  {
    id: 'policy-conflict-latest',
    category: 'policy_conflict',
    faithful: false,
    policy: { distinguished: true, conflictExplained: true, misstatedAsOfficial: false },
    note: '答案应分层表达 image 字段类型校验与 latest tag 组织禁用;当前样本 schema 依据缺失导致忠实度=false',
  },
  {
    id: 'policy-conflict-nodeport',
    category: 'policy_conflict',
    faithful: true,
    policy: { distinguished: true, conflictExplained: true, misstatedAsOfficial: false },
    note: '答案用 Service::spec.type 支撑 NodePort schema 取值,并用 policy chunk 表达生产禁用',
  },
  {
    id: 'policy-conflict-privileged',
    category: 'policy_conflict',
    faithful: true,
    note: '当前样本未检索到 policy context,回答应只答 schema 层并说明未检索到组织规范;policy detail 不校准',
  },
];

const CALIBRATION_PATH = join(process.cwd(), 'data', 'eval', 'judge-calibration.jsonl');

function faithFilesNewestFirst(): string[] {
  return readdirSync(FAITH_DIR)
    .filter((f) => f.endsWith('.jsonl') && !f.includes('smoke'))
    .sort()
    .reverse();
}

function readTraceFile(file: string): FaithTrace[] {
  return readFileSync(join(FAITH_DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FaithTrace);
}

function latestTraceById(id: string): FaithTrace | null {
  for (const file of faithFilesNewestFirst()) {
    const found = readTraceFile(file).find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

/** 由 topIds 重建喂给生成的 context 文本(与 faithfulness.ts 同格式)。 */
function rebuildContext(topIds: string[]): string {
  const chunks = topIds
    .map((id) => CORPUS.find((cc) => cc.id === id))
    .filter((x): x is (typeof CORPUS)[number] => x !== undefined);
  return formatSources(chunks).context;
}

function main(): void {
  const files = faithFilesNewestFirst();
  if (files.length === 0) {
    throw new Error('无 faith 明细,先跑 npm run eval:faith');
  }
  const out = LABELS.map((l) => {
    const t = latestTraceById(l.id);
    if (!t) throw new Error(`明细缺样本 ${l.id}`);
    return {
      id: l.id,
      category: l.category,
      question: t.question,
      context: rebuildContext(t.retrieval.topIds),
      answer: t.answer,
      human: {
        faithful: l.faithful,
        ...(l.policy ? { policy: l.policy } : {}),
        note: l.note,
      },
    };
  });
  writeFileSync(CALIBRATION_PATH, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.error(`已写 ${out.length} 条 → ${CALIBRATION_PATH}`);
  const f = out.filter((o) => o.human.faithful).length;
  console.error(`人工 label:忠实 ${f} / 不忠 ${out.length - f}`);
  const policyDims = out.reduce(
    (n, o) => n + Object.keys(o.human.policy ?? {}).length,
    0,
  );
  console.error(`policy 人工维度标注: ${policyDims} 个`);
}

main();

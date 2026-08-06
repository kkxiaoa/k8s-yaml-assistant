import type {
  SourceAuthority,
  SourceType,
} from '../knowledge/chunk';

export interface SourcePolicy {
  label: string;
  factDomain: string;
  promptRole: string;
}

export const SOURCE_TYPES = [
  'schema',
  'policy',
  'docs',
  'example',
] as const satisfies readonly SourceType[];

const SOURCE_POLICIES: Record<SourceType, SourcePolicy> = {
  schema: {
    label: 'Schema',
    factDomain: '字段结构事实',
    promptRole: '说明字段是否合法、类型、枚举和 required 等结构事实。',
  },
  policy: {
    label: 'Policy',
    factDomain: '规则与约束',
    promptRole: '说明来源声明的推荐、禁止和约束，不替代 Kubernetes schema。',
  },
  docs: {
    label: '文档',
    factDomain: '概念与行为说明',
    promptRole: '解释来源文档明确说明的行为语义、使用条件和注意事项。',
  },
  example: {
    label: '示例',
    factDomain: '配置样例',
    promptRole: '辅助生成或修复，不能替代 schema 合法性判断。',
  },
};

const AUTHORITY_LABELS: Record<SourceAuthority, string> = {
  kubernetes_official: 'Kubernetes 官方',
  cluster_api: '当前集群 API',
  extension_provider: '扩展提供方',
  organization: '组织',
  curated: '人工精选',
};

export function sourcePolicy(sourceType: SourceType): SourcePolicy {
  return SOURCE_POLICIES[sourceType];
}

export function sourceLabel(sourceType: SourceType): string {
  return sourcePolicy(sourceType).label;
}

export function sourceAuthorityLabel(authority: SourceAuthority): string {
  return AUTHORITY_LABELS[authority];
}

const SOURCE_GUIDANCE = SOURCE_TYPES.map((sourceType) => {
  const policy = sourcePolicy(sourceType);
  return `[${sourceType}][${policy.label}] ${policy.factDomain}：${policy.promptRole}`;
}).join('；');

export const CONFLICT_RULES = `- 来源分工:${SOURCE_GUIDANCE}
- Authority 以来源标签为准：Kubernetes 官方、当前集群 API、扩展提供方、组织、人工精选是不同权威边界；不得把当前集群 API 或扩展提供方 schema 表达为 Kubernetes 官方事实。
- 冲突表达:当 schema 允许但 policy 禁止/不推荐时,同时说明两层；每一层结论都必须分别由对应来源直接支持,不得从相邻字段、问题措辞或常识补出 schema 允许性、策略执行方式或运行后果。不要笼统说成"schema 合法"。
- 完整性:问题涉及"能不能/是否允许/推荐吗/生产可用吗",必须同时检查 schema 与 policy 来源;若未检索到 policy 来源,只答 schema 层事实并说明"未检索到组织规范"。
- 红线:不得把 policy 说成 K8s 官方强制;policy 一律标"组织策略/平台规范",强度由级别(required/forbidden/recommended/discouraged)表达。`;

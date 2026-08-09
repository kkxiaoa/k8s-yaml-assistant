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
    promptRole: '字段合法性、类型、枚举和 required',
  },
  policy: {
    label: 'Policy',
    factDomain: '规则与约束',
    promptRole: '来源声明的推荐、禁止和约束，不替代 schema',
  },
  docs: {
    label: '文档',
    factDomain: '概念与行为说明',
    promptRole: '来源明确说明的行为、使用条件和注意事项',
  },
  example: {
    label: '示例',
    factDomain: '配置样例',
    promptRole: '配置参考，不证明 schema 合法性',
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
- 来源与冲突:来源标签决定权威边界,不得把当前集群 API、扩展提供方或 policy 表达为 Kubernetes 官方事实。问题涉及能否、是否允许、推荐或生产可用时,分别检查已检索的 schema 与 policy;冲突时分别说明且每层结论都要有对应来源,未检索到 policy 时只答 schema 事实并说明“未检索到组织规范”。policy 标为“组织策略/平台规范”,强度沿用来源级别。`;

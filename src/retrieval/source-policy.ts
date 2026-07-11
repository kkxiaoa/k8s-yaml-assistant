import type { SourceType, TrustLevel } from '../knowledge/chunk';

export interface SourcePolicy {
  label: string;
  trustLevel: TrustLevel;
  promptRole: string;
}

export const SOURCE_TYPES = ['schema', 'policy', 'docs', 'example'] as const satisfies readonly SourceType[];

const SOURCE_POLICIES: Record<SourceType, SourcePolicy> = {
  schema: {
    label: 'K8s schema',
    trustLevel: 'k8s-official',
    promptRole: '官方字段事实:字段是否合法、类型、枚举、required 等结构事实。',
  },
  policy: {
    label: '组织策略',
    trustLevel: 'org-policy',
    promptRole: '组织或平台规范:推荐、禁止或约束怎么配置,不是 K8s 官方强制。',
  },
  docs: {
    label: '官方文档',
    trustLevel: 'k8s-docs',
    promptRole: '官方概念说明:解释行为语义、使用条件和注意事项。',
  },
  example: {
    label: '示例',
    trustLevel: 'example',
    promptRole: '示例配置:辅助生成或修复,不能替代 schema 合法性判断。',
  },
};

export function sourcePolicy(sourceType: SourceType): SourcePolicy {
  return SOURCE_POLICIES[sourceType];
}

export function sourceLabel(sourceType: SourceType): string {
  return sourcePolicy(sourceType).label;
}

export function sourceTrustLevel(sourceType: SourceType): TrustLevel {
  return sourcePolicy(sourceType).trustLevel;
}

export const CONFLICT_RULES = `- 来源分工:标 [schema][K8s schema] 的是官方事实(字段是否合法/能填什么);标 [policy][组织策略] 的是平台组织规范(推荐/禁止怎么配),不是 K8s 官方强制;标 [docs][官方文档] 的是官方概念和行为说明;标 [example][示例] 的是配置样例,不能替代 schema 合法性判断。
- 冲突表达:当 schema 允许但 policy 禁止/不推荐时,同时说明两层。措辞严谨,例如:"image 字段在 K8s schema 层面允许填字符串,nginx:latest 能通过字段类型校验;但平台 policy 禁止 latest tag。"不要笼统说成"schema 合法"。
- 完整性:问题涉及"能不能/是否允许/推荐吗/生产可用吗",必须同时检查 schema 与 policy 来源;若未检索到 policy 来源,只答 schema 层事实并说明"未检索到组织规范"。
- 红线:不得把 policy 说成 K8s 官方强制;policy 一律标"组织策略/平台规范",强度由级别(required/forbidden/recommended/discouraged)表达。`;

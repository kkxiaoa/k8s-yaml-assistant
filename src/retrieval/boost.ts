// policy 检索加权:policy chunk 与 query resource 相关时轻加权,保证进 top-k。
// 只在 resource 匹配时加(policy 问题常无 cursorPath);path 命中再叠加增强。
// 不基于 query 文本出现"必须/禁止"就全局抬 policy——否则问字段事实时 policy 抢占 schema。

import type { Chunk } from '../knowledge/corpus';
import { POLICY_RELATED_BOOST } from './router';

const POLICY_PATH_BONUS = 0.03;

// boostPath 约定已归一化(小写):path 归一化收在 denseSearch 一处,避免重复 lowercase。
export function policyBoost(
  chunk: Chunk,
  boostResource?: string,
  boostPath?: string,
  boostApiVersion?: string,
): number {
  if (chunk.sourceType !== 'policy') return 0;
  if (!boostResource) return 0;
  const matchingTargets = chunk.targets.filter(
    (target) =>
      target.kind === boostResource &&
      (!boostApiVersion ||
        !target.apiVersion ||
        target.apiVersion === boostApiVersion),
  );
  if (matchingTargets.length === 0) return 0;
  const pathHit =
    boostPath &&
    matchingTargets.some((target) =>
      target.path?.toLowerCase().endsWith(boostPath),
    );
  return POLICY_RELATED_BOOST + (pathHit ? POLICY_PATH_BONUS : 0);
}

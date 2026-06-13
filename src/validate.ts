// 迭代1:StorageClass 静态校验(纯函数,无副作用、不抛异常、不依赖网络)。
// 设计意图:这是助手"校验"能力的内核;后面会被注册成 tool 供模型调用(check.ts),
// 也能直接接进 Monaco 编辑器做前端实时校验(path 字段就是给编辑器定位用的)。

export interface ValidationError {
  /** 出错字段路径,如 'spec.provisioner';给 Monaco 编辑器定位高亮用 */
  path: string;
  /** 人类可读的错误说明 */
  message: string;
}

/** DNS-1123 子域名/标签规范:小写字母数字与连字符,首尾必须是字母数字,长度 ≤ 253 */
function isDns1123(name: string): boolean {
  return name.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);
}

/**
 * 校验一个(已由 YAML 解析成对象的)StorageClass。
 * @param parsed js-yaml 解析后的对象(unknown,内部做类型守卫)
 * @returns 错误数组;空数组表示校验通过
 */
export function validateStorageClass(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [{ path: '', message: 'YAML 内容为空或不是一个对象' }];
  }
  const obj = parsed as Record<string, unknown>;

  // 1. apiVersion / kind
  if (obj.apiVersion !== 'storage.k8s.io/v1') {
    errors.push({
      path: 'apiVersion',
      message: `apiVersion 必须为 "storage.k8s.io/v1",当前为 ${JSON.stringify(obj.apiVersion)}`,
    });
  }
  if (obj.kind !== 'StorageClass') {
    errors.push({
      path: 'kind',
      message: `kind 必须为 "StorageClass",当前为 ${JSON.stringify(obj.kind)}`,
    });
  }

  // 2. metadata.name 必填 + DNS-1123
  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : {};
  const name = metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    errors.push({ path: 'metadata.name', message: 'metadata.name 必填' });
  } else if (!isDns1123(name)) {
    errors.push({
      path: 'metadata.name',
      message: `metadata.name "${name}" 不符合 DNS-1123 规范(只能小写字母、数字、连字符,且首尾为字母数字)`,
    });
  }

  // 3. provisioner 必填
  if (typeof obj.provisioner !== 'string' || obj.provisioner.length === 0) {
    errors.push({ path: 'provisioner', message: 'provisioner 必填,不能为空' });
  }

  // 4. reclaimPolicy 枚举(可选字段)
  if (
    obj.reclaimPolicy !== undefined &&
    obj.reclaimPolicy !== 'Delete' &&
    obj.reclaimPolicy !== 'Retain'
  ) {
    errors.push({
      path: 'reclaimPolicy',
      message: `reclaimPolicy 只能是 "Delete" 或 "Retain",当前为 ${JSON.stringify(obj.reclaimPolicy)}`,
    });
  }

  // 5. volumeBindingMode 枚举(可选字段)
  if (
    obj.volumeBindingMode !== undefined &&
    obj.volumeBindingMode !== 'Immediate' &&
    obj.volumeBindingMode !== 'WaitForFirstConsumer'
  ) {
    errors.push({
      path: 'volumeBindingMode',
      message: `volumeBindingMode 只能是 "Immediate" 或 "WaitForFirstConsumer",当前为 ${JSON.stringify(obj.volumeBindingMode)}`,
    });
  }

  return errors;
}

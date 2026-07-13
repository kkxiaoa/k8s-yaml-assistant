// Phase B:schema 驱动的通用校验(纯函数,无副作用、不抛异常、不依赖网络)。
// 从 YAML 的 kind 自动选 schema,按 OpenAPI 的 type / enum / required / 未知字段 校验**任意**资源。
// 同一份 data/schemas/ 既当问答知识库(schema-corpus)又当校验规则。
// path 字段给 Monaco 编辑器定位高亮用。

import { loadAll } from 'js-yaml';
import {
  getSchemaForKind,
  resolveSchemaNode,
  type SchemaNode,
} from '../knowledge/schemas';

export const VALIDATION_LOGIC_REVISION = 'schema-validator-v1';

export interface ValidationError {
  /** 出错字段路径,如 'spec.accessModes';给编辑器定位用 */
  path: string;
  /** 人类可读的错误说明 */
  message: string;
}

/** DNS-1123:小写字母数字与连字符,首尾为字母数字,长度 ≤ 253 */
function isDns1123(name: string): boolean {
  return name.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);
}

// 所有 K8s 对象共有、但 schema 里不一定展开的顶层字段,不当"未知字段"报。
const TOP_LEVEL_BUILTINS = new Set(['apiVersion', 'kind', 'metadata']);

function jsTypeName(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function typeMatches(schemaType: string | undefined, value: unknown): boolean {
  if (!schemaType) return true;
  switch (schemaType) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'number':
      return typeof value === 'number';
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

const enumStr = (vals: unknown[]): string =>
  vals.map((v) => JSON.stringify(v)).join(' , ');

function validateNode(
  value: unknown,
  node: SchemaNode,
  path: string,
  topLevel: boolean,
  errors: ValidationError[],
): void {
  const resolved = resolveSchemaNode(node);
  // 1. 类型
  if (!typeMatches(resolved.type, value)) {
    errors.push({
      path,
      message: `类型应为 ${resolved.type}, 当前为 ${jsTypeName(value)}`,
    });
    return; // 类型都不对,不再往下查
  }
  // 2. 标量枚举
  if (resolved.enum && !resolved.enum.includes(value as never)) {
    errors.push({
      path,
      message: `只能是 ${enumStr(resolved.enum)}, 当前为 ${JSON.stringify(value)}`,
    });
  }
  // 3. 数组:逐元素按 items schema 递归校验(类型/枚举/对象字段)。
  //    覆盖对象数组(如 spec.containers 里的 imagePullPolicy 枚举、image 类型),
  //    也覆盖标量数组枚举(如 accessModes)——都交给 validateNode 递归。
  if (resolved.type === 'array' && Array.isArray(value) && resolved.items) {
    const itemSchema = resolved.items;
    value.forEach((item, i) => {
      validateNode(item, itemSchema, `${path}[${i}]`, false, errors);
    });
  }
  // 4. 对象:required + 逐字段 + map(additionalProperties)+ 未知字段
  // map 类型(selector/labels/data 等)靠 additionalProperties 约束值,没有 properties——
  // 之前只看 properties 会整段跳过、放行任意值(如 selector.app 填数组)。
  const additional = resolved.additionalProperties;
  const addlSchema =
    additional && typeof additional === 'object'
      ? (additional as SchemaNode)
      : null;
  const allowsExtra = additional === true || addlSchema !== null;
  if (
    (resolved.properties || addlSchema) &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    for (const req of resolved.required ?? []) {
      const v = obj[req];
      if (v === undefined || v === null || v === '') {
        errors.push({
          path: path ? `${path}.${req}` : req,
          message: `${req} 必填`,
        });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      const childSchema = resolved.properties?.[key];
      if (childSchema) {
        validateNode(child, childSchema, childPath, false, errors);
      } else if (addlSchema) {
        // map 值按 additionalProperties 校验;键是用户自定义,不算未知字段
        validateNode(child, addlSchema, childPath, false, errors);
      } else if (!allowsExtra && !(topLevel && TOP_LEVEL_BUILTINS.has(key))) {
        errors.push({
          path: childPath,
          message: `未知字段 "${key}"(schema 中未定义)`,
        });
      }
    }
  }
}

/**
 * schema 驱动校验任意资源。
 * @param parsed js-yaml 解析后的对象
 * @returns 错误数组;空数组表示通过
 */
export function validateResource(parsed: unknown): ValidationError[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [{ path: '', message: 'YAML 内容为空或不是一个对象' }];
  }
  const obj = parsed as Record<string, unknown>;

  const kind = typeof obj.kind === 'string' ? obj.kind : undefined;
  if (!kind) {
    return [{ path: 'kind', message: 'kind 缺失,无法确定资源类型' }];
  }

  const doc = getSchemaForKind(kind);
  if (!doc) {
    return [
      {
        path: 'kind',
        message: `未收录 "${kind}" 的 schema, 无法校验(请通过 ingest 生成到 data/schemas/generated 并加入 curated.json)`,
      },
    ];
  }

  const errors: ValidationError[] = [];

  // apiVersion 一致性
  if (typeof obj.apiVersion === 'string' && obj.apiVersion !== doc.apiVersion) {
    errors.push({
      path: 'apiVersion',
      message: `${kind} 的 apiVersion 应为 "${doc.apiVersion}", 当前为 ${JSON.stringify(obj.apiVersion)}`,
    });
  }

  // metadata.name 是核心资源身份字段,即使 schema 未完整声明也要显式校验。
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
      message: `metadata.name "${name}" 不符合 DNS-1123 规范`,
    });
  }

  // schema 驱动校验主体
  validateNode(obj, doc.schema, '', true, errors);

  return errors;
}

export interface YamlValidation {
  /** true=YAML 语法解析失败(与 schema 校验失败区分,供生成引擎标记 parse/validate 阶段) */
  parseFailed: boolean;
  errors: ValidationError[];
}

/**
 * 解析(多文档 `---`)+ 逐文档 schema 校验。check 路由与生成引擎共用同一份,
 * 避免"单文档 load vs 多文档 loadAll"两套不一致实现。多文档时错误加 `[doc i]` 前缀。
 */
export function validateYamlDocuments(yamlText: string): YamlValidation {
  let docs: unknown[];
  try {
    docs = (loadAll(yamlText) as unknown[]).filter((d) => d != null);
  } catch (e) {
    return {
      parseFailed: true,
      errors: [
        {
          path: '',
          message:
            'YAML 解析失败: ' + (e instanceof Error ? e.message : String(e)),
        },
      ],
    };
  }
  if (docs.length === 0) {
    return { parseFailed: true, errors: [{ path: '', message: 'YAML 为空' }] };
  }
  const errors: ValidationError[] = [];
  docs.forEach((doc, i) => {
    const prefix = docs.length > 1 ? `[doc ${i}] ` : '';
    for (const e of validateResource(doc)) {
      errors.push({ path: e.path, message: prefix + e.message });
    }
  });
  return { parseFailed: false, errors };
}

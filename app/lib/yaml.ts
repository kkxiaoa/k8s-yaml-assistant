// 编辑器相关的纯逻辑(无 JSX):资源识别 + 校验错误 → Monaco 标记。
import type { OnMount } from '@monaco-editor/react';
import { loadAll } from 'js-yaml';

export type EditorT = Parameters<OnMount>[0];
export type MonacoT = Parameters<OnMount>[1];

export interface VErr {
  path: string;
  message: string;
}

/** 轻量 YAML path 推断:按缩进栈定位光标所在字段,优先覆盖常见 K8s YAML。 */
export function inferPathAtLine(yaml: string, lineNumber: number | null | undefined): string | null {
  if (!lineNumber) return null;
  const stack: Array<{ indent: number; key: string }> = [];
  const lines = yaml.split('\n').slice(0, lineNumber);
  for (const line of lines) {
    const match = line.match(/^(\s*)(-\s*)?([A-Za-z0-9_.-]+)\s*:/);
    if (!match) continue;
    const indent = match[1]!.length + (match[2] ? 2 : 0);
    const key = match[3]!;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, key });
  }
  return stack.length ? stack.map((item) => item.key).join('.') : null;
}

/** 从编辑器里的 YAML 解析出资源(kind / apiVersion)。多文档时取首个,count 记资源总数。 */
export function detectResource(yaml: string): {
  kind: string | null;
  apiVersion: string | null;
  count: number;
} {
  try {
    const docs = (loadAll(yaml) as unknown[]).filter(
      (d): d is Record<string, unknown> =>
        d != null && typeof d === 'object' && !Array.isArray(d),
    );
    const first = docs[0];
    return {
      kind: typeof first?.kind === 'string' ? first.kind : null,
      apiVersion: typeof first?.apiVersion === 'string' ? first.apiVersion : null,
      count: docs.length,
    };
  } catch {
    /* 编辑中,解析失败忽略 */
  }
  return { kind: null, apiVersion: null, count: 0 };
}

/** 把校验错误的 path 映射成 Monaco 行内标记(红波浪线 + 悬浮提示)。 */
export function buildMarkers(
  yaml: string,
  errs: VErr[],
  monaco: MonacoT,
): Parameters<MonacoT['editor']['setModelMarkers']>[2] {
  const lines = yaml.split('\n');
  return errs
    .filter((e) => e.path)
    .map((e) => {
      const key = (e.path.split('.').pop() ?? '').replace(/\[\d+\]$/, '');
      let idx = key ? lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*:`).test(l)) : -1;
      if (idx < 0) idx = 0;
      const text = lines[idx] ?? '';
      return {
        severity: monaco.MarkerSeverity.Error,
        message: e.message,
        startLineNumber: idx + 1,
        startColumn: 1,
        endLineNumber: idx + 1,
        endColumn: Math.max(text.length, 1) + 1,
      };
    });
}

// 编辑器相关的纯逻辑(无 JSX):资源识别 + 校验错误 → Monaco 标记。
import type { OnMount } from '@monaco-editor/react';
import { load } from 'js-yaml';

export type EditorT = Parameters<OnMount>[0];
export type MonacoT = Parameters<OnMount>[1];

export interface VErr {
  path: string;
  message: string;
}

/** 从编辑器里的 YAML 解析出当前资源(kind / apiVersion)。 */
export function detectResource(yaml: string): { kind: string | null; apiVersion: string | null } {
  try {
    const o = load(yaml) as Record<string, unknown> | null;
    if (o && typeof o === 'object') {
      return {
        kind: typeof o.kind === 'string' ? o.kind : null,
        apiVersion: typeof o.apiVersion === 'string' ? o.apiVersion : null,
      };
    }
  } catch {
    /* 编辑中,解析失败忽略 */
  }
  return { kind: null, apiVersion: null };
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

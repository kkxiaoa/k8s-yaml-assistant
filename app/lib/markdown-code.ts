import hljs from 'highlight.js/lib/core';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('yaml', yaml);

const LANGUAGE_CLASS = /(?:^|\s)language-([A-Za-z0-9_+-]+)(?=\s|$)/u;

export interface MarkdownCodeLanguage {
  id: string | null;
  label: string;
  highlightedHtml: string | null;
}

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

function normalizeFencedCode(code: string): string {
  return code
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function fencedCodeBlocks(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  return [
    ...normalized.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)\n```(?=\n|$)/gu),
  ]
    .map((match) => normalizeFencedCode(match[1] ?? ''))
    .filter(Boolean);
}

export function markdownContainsFencedCode(
  markdown: string,
  code: string,
): boolean {
  const normalizedCode = normalizeFencedCode(code);
  return (
    normalizedCode.length > 0 &&
    fencedCodeBlocks(markdown).includes(normalizedCode)
  );
}

export function markdownRepeatsFencedCode(
  answer: string,
  source: string,
): boolean {
  const answerBlocks = new Set(fencedCodeBlocks(answer));
  return fencedCodeBlocks(source).some((block) => answerBlocks.has(block));
}

function normalizedLanguage(className?: string): string | null {
  const raw = LANGUAGE_CLASS.exec(className ?? '')?.[1]?.toLowerCase();
  if (raw === undefined) return null;
  return raw === 'yml' ? 'yaml' : raw;
}

export function markdownCodeLanguage(
  code: string,
  className?: string,
): MarkdownCodeLanguage {
  const id = normalizedLanguage(className);
  if (id === null) {
    return { id, label: 'TEXT', highlightedHtml: null };
  }
  if (id !== 'yaml') {
    return { id, label: id.toUpperCase(), highlightedHtml: null };
  }
  return {
    id,
    label: 'YAML',
    highlightedHtml: hljs.highlight(code, {
      language: id,
      ignoreIllegals: true,
    }).value,
  };
}

export async function writeCodeToClipboard(
  clipboard: ClipboardWriter | undefined,
  code: string,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
}

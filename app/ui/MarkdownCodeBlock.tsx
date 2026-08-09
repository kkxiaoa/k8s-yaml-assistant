'use client';

import { useEffect, useState } from 'react';
import {
  markdownCodeLanguage,
  writeCodeToClipboard,
} from '../lib/markdown-code';
import { Tooltip } from './Tooltip';

interface Props {
  className?: string;
  code: string;
  attribution?: {
    label: string;
    href?: string;
    title?: string;
  };
}

type CopyState = 'idle' | 'copied' | 'failed';

function CodeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m8 9-3 3 3 3" />
      <path d="m16 9 3 3-3 3" />
      <path d="m14 5-4 14" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function FailedIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    >
      <path d="m7 7 10 10" />
      <path d="M17 7 7 17" />
    </svg>
  );
}

export function MarkdownCodeBlock({ className, code, attribution }: Props) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const language = markdownCodeLanguage(code, className);

  useEffect(() => {
    setCopyState('idle');
  }, [code]);

  async function copy(): Promise<void> {
    const copied = await writeCodeToClipboard(navigator.clipboard, code);
    setCopyState(copied ? 'copied' : 'failed');
  }

  const copyLabel =
    copyState === 'copied'
      ? '已复制'
      : copyState === 'failed'
        ? '复制失败'
        : '复制';
  const copyTone =
    copyState === 'copied'
      ? 'text-ok'
      : copyState === 'failed'
        ? 'text-err'
        : 'text-fg/90';

  return (
    <div className="markdown-code my-3 w-full min-w-0 max-w-full rounded-xl border border-line/70 bg-surface shadow-sm">
      <div className="flex items-center justify-between px-4 pb-1 pt-3.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-2 text-[13px] font-semibold text-fg">
            <CodeIcon />
            <span>{language.label}</span>
          </span>
          {attribution && (
            <>
              <span aria-hidden="true" className="text-xs text-muted/60">
                ·
              </span>
              {attribution.href ? (
                <a
                  href={attribution.href}
                  target="_blank"
                  rel="noreferrer"
                  title={attribution.title}
                  className="truncate font-mono text-[10px] font-normal text-brand underline decoration-brand/35 underline-offset-2 hover:decoration-brand"
                >
                  {attribution.label} ↗
                </a>
              ) : (
                <span
                  title={attribution.title}
                  className="truncate font-mono text-[10px] font-normal text-muted"
                >
                  {attribution.label}
                </span>
              )}
            </>
          )}
        </span>
        <Tooltip
          content={copyLabel}
          align="end"
          className="shrink-0"
          describeChild
          placement="top"
        >
          <button
            type="button"
            className={`inline-flex size-8 items-center justify-center rounded-md transition hover:bg-white/10 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${copyTone}`}
            aria-label={`${copyLabel}代码`}
            onClick={copy}
          >
            {copyState === 'copied' ? (
              <CheckIcon />
            ) : copyState === 'failed' ? (
              <FailedIcon />
            ) : (
              <CopyIcon />
            )}
          </button>
        </Tooltip>
      </div>
      <span className="sr-only" aria-live="polite">
        {copyState === 'idle' ? '' : copyLabel}
      </span>
      <pre className="max-w-full overflow-x-auto px-4 pb-4 pt-2 font-mono text-xs leading-5 text-fg/90">
        {language.highlightedHtml === null ? (
          <code>{code}</code>
        ) : (
          <code
            className={`hljs language-${language.id}`}
            // Highlight.js escapes source text before adding token spans.
            dangerouslySetInnerHTML={{ __html: language.highlightedHtml }}
          />
        )}
      </pre>
    </div>
  );
}

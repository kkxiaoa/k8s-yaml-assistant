import { Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  LABEL,
  PRIMARY_BTN,
  SIDEBAR_PANEL,
  SIDEBAR_PANEL_HEADER,
  SIDEBAR_TEXTAREA,
} from "./styles";
import { Tooltip } from './Tooltip';
import { ResponseFeedback } from './ResponseFeedback';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import {
  markdownContainsFencedCode,
  markdownRepeatsFencedCode,
} from '../lib/markdown-code';
import type { AskMode, SourceHit } from "../lib/api";
import { sourceAuthorityLabel, sourceLabel } from "@/retrieval/source-policy";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function codeBlockChild(children: ReactNode): {
  className?: string;
  code: string;
} | null {
  const child = Children.toArray(children).find(isValidElement);
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) {
    return null;
  }
  const code = Children.toArray(child.props.children)
    .filter((value): value is string | number =>
      ['string', 'number'].includes(typeof value),
    )
    .join('')
    .replace(/\n$/u, '');
  return { className: child.props.className, code };
}

function citationBadgePlugin(
  hiddenCitations: ReadonlySet<number>,
  displayCitations: ReadonlyMap<number, number>,
) {
  return () => (tree: MarkdownNode): void => {
    function transform(node: MarkdownNode): void {
      if (
        !node.children ||
        node.type === 'code' ||
        node.type === 'inlineCode' ||
        node.type === 'strong'
      ) {
        return;
      }
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || child.value === undefined) {
          transform(child);
          return [child];
        }
        const parts = child.value.split(/(\[S\d+\])/g);
        if (parts.length === 1) return [child];
        const transformed: MarkdownNode[] = [];
        for (const part of parts.filter(Boolean)) {
          const citation = /^\[S(\d+)\]$/.exec(part);
          if (citation === null) {
            transformed.push({ type: 'text', value: part });
            continue;
          }
          const sourceNumber = Number(citation[1]);
          if (hiddenCitations.has(sourceNumber)) {
            const previous = transformed.at(-1);
            if (previous?.type === 'text' && previous.value !== undefined) {
              previous.value = previous.value.trimEnd();
            }
            continue;
          }
          const displayNumber = displayCitations.get(sourceNumber) ?? sourceNumber;
          transformed.push({
            type: 'strong',
            children: [{ type: 'text', value: `[S${displayNumber}]` }],
          });
        }
        return transformed;
      });
    }
    transform(tree);
  };
}

function MarkdownPre({
  children,
  attributedSources = [],
}: {
  children?: ReactNode;
  attributedSources?: readonly SourceHit[];
}) {
  const block = codeBlockChild(children);
  if (block === null) {
    return (
      <pre className="my-2 overflow-x-auto rounded border border-line bg-ink p-3 leading-relaxed">
        {children}
      </pre>
    );
  }
  const source = attributedSources.find((candidate) =>
    markdownContainsFencedCode(candidate.text, block.code),
  );
  const sourceUri = source?.provenance.sourceUri;
  return (
    <MarkdownCodeBlock
      className={block.className}
      code={block.code}
      attribution={
        source === undefined
          ? undefined
          : {
              label: `${sourceAuthorityLabel(source.provenance.authority)}示例`,
              ...(sourceUri?.startsWith('http') ? { href: sourceUri } : {}),
              title: source.title,
            }
      }
    />
  );
}

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-2 text-sm leading-relaxed text-fg">{children}</p>
  ),
  strong: ({ children }) => {
    if (typeof children === 'string' && /^\[S\d+\]$/.test(children)) {
      return (
        <span className="mx-0.5 inline-flex -translate-y-px rounded-sm border border-brand/35 bg-brand/10 px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-brand">
          {children}
        </span>
      );
    }
    return <strong className="font-semibold text-fg">{children}</strong>;
  },
  h1: ({ children }) => (
    <h3 className="mt-4 text-base font-semibold text-fg">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-4 text-sm font-semibold text-fg">{children}</h3>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 text-sm font-semibold text-fg">{children}</h3>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-sm text-fg/90">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-sm text-fg/90">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      className="break-all text-brand underline decoration-brand/40 underline-offset-2"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    if (className?.includes('language-')) {
      return (
        <code className={className}>{children}</code>
      );
    }
    return (
      <code className="rounded border border-line/60 bg-black/20 px-1 py-0.5 font-mono text-[0.9em] text-fg/85">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <MarkdownPre>{children}</MarkdownPre>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-brand/40 pl-3 text-sm text-fg/75">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg bg-ink/50">
      <table className="markdown-table min-w-full border-separate border-spacing-0 text-xs text-fg/85">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line/50 bg-white/[0.025] px-3 py-2 text-left font-semibold text-fg/90">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line/25 px-3 py-2 align-top leading-relaxed">
      {children}
    </td>
  ),
};

const sourceMarkdownComponents: Components = {
  ...markdownComponents,
  p: ({ children }) => (
    <p className="my-1 text-xs leading-relaxed text-fg/80">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-1 list-disc space-y-1 pl-4 text-xs text-fg/80">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal space-y-1 pl-4 text-xs text-fg/80">
      {children}
    </ol>
  ),
};

function MarkdownText({
  text,
  streaming,
  attributedSources,
  hiddenCitations,
  displayCitations,
}: {
  text: string;
  streaming: boolean;
  attributedSources: readonly SourceHit[];
  hiddenCitations: ReadonlySet<number>;
  displayCitations: ReadonlyMap<number, number>;
}) {
  const answerMarkdownComponents: Components = {
    ...markdownComponents,
    pre: ({ children }) => (
      <MarkdownPre attributedSources={attributedSources}>
        {children}
      </MarkdownPre>
    ),
  };
  return (
    <div className="min-w-0 break-words text-sm">
      <ReactMarkdown
        components={answerMarkdownComponents}
        remarkPlugins={[
          remarkGfm,
          citationBadgePlugin(hiddenCitations, displayCitations),
        ]}
        skipHtml
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="ml-0.5 animate-pulse text-brand">▌</span>}
    </div>
  );
}

interface Props {
  question: string;
  answer: string;
  sources: SourceHit[];
  feedbackRequestId: string | null;
  asking: boolean;
  disabled: boolean;
  loginRequired: boolean;
  actionHint?: string;
  canExplainField: boolean;
  canExplainError: boolean;
  onChange: (v: string) => void;
  onAsk: (mode?: AskMode, questionOverride?: string) => void;
}

export function AskPanel({
  question,
  answer,
  sources,
  feedbackRequestId,
  asking,
  disabled,
  loginRequired,
  actionHint,
  canExplainField,
  canExplainError,
  onChange,
  onAsk,
}: Props) {
  const citedNs = new Set(
    [...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])),
  );
  const cited = sources.filter(
    (source): source is SourceHit & { n: number } =>
      source.n !== undefined && citedNs.has(source.n),
  );
  const attributedExamples = cited.filter(
    (source) =>
      source.sourceType === 'example' &&
      markdownRepeatsFencedCode(answer, source.text),
  );
  const hiddenCitations = new Set(
    attributedExamples.map((source) => source.n),
  );
  const visibleCited = cited.filter(
    (source) => !hiddenCitations.has(source.n),
  );
  const displayCitations = new Map(
    visibleCited.map((source, index) => [source.n, index + 1]),
  );
  return (
    <>
      <div className={SIDEBAR_PANEL}>
        <div className={SIDEBAR_PANEL_HEADER}>
          <span className={LABEL}>解释当前配置</span>
        </div>
        <div className="px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-2">
            <Tooltip content={actionHint} align="start" describeChild>
              <button
                className="rounded border border-line px-2 py-1 font-mono text-[11px] text-fg/80 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => onAsk("explain_field", "解释当前字段")}
                disabled={disabled || !canExplainField}
              >
                解释当前字段
              </button>
            </Tooltip>
            <Tooltip content={actionHint} align="start" describeChild>
              <button
                className="rounded border border-line px-2 py-1 font-mono text-[11px] text-fg/80 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => onAsk("explain_error", "解释当前校验错误")}
                disabled={disabled || !canExplainError}
              >
                解释当前错误
              </button>
            </Tooltip>
          </div>
          <textarea
            id="ask-question"
            aria-label="关于当前 YAML 的问题"
            value={question}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            placeholder="输入关于当前 YAML 的问题…"
            className={`min-h-24 resize-y ${SIDEBAR_TEXTAREA}`}
          />
          <div className="mt-2">
            <Tooltip content={actionHint} align="start" describeChild>
              <button
                className={PRIMARY_BTN}
                onClick={() => onAsk("free")}
                disabled={disabled || !question.trim()}
              >
                {asking ? "分析中…" : loginRequired ? "登录后解释" : "解释"}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {(answer || cited.length > 0 || feedbackRequestId !== null) && (
        <div className="min-w-0 px-1 pb-1">
          {answer && (
            <MarkdownText
              text={answer}
              streaming={asking}
              attributedSources={attributedExamples}
              hiddenCitations={hiddenCitations}
              displayCitations={displayCitations}
            />
          )}
          {visibleCited.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className={LABEL}>答案依据</div>
              <ul className="mt-2 space-y-2">
                {visibleCited.map((source) => {
                  const target = source.targets[0];
                  const resource = target?.kind ?? "通用来源";
                  const path = target?.path;
                  return (
                    <li
                      key={source.id}
                      className="rounded border border-line bg-ink/50 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand">
                            S{displayCitations.get(source.n) ?? source.n}
                          </span>
                          <span className="min-w-0 break-all font-mono text-[11px] text-brand">
                            {resource}
                            {path ? ` · ${path}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase text-muted">
                          {sourceLabel(source.sourceType)} ·{" "}
                          {sourceAuthorityLabel(source.provenance.authority)}
                        </span>
                      </div>
                      {source.sourceType === "example" && (
                        <p className="mt-1.5 text-xs leading-relaxed text-fg/75">
                          {source.title}
                        </p>
                      )}
                      {source.sourceType === "example" ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-mono text-[10px] text-brand hover:underline">
                            查看来源示例
                          </summary>
                          <div className="mt-2 min-w-0 break-words">
                            <ReactMarkdown
                              components={sourceMarkdownComponents}
                              remarkPlugins={[remarkGfm]}
                              skipHtml
                            >
                              {source.text}
                            </ReactMarkdown>
                          </div>
                        </details>
                      ) : (
                        <div className="mt-1 min-w-0 break-words">
                          <ReactMarkdown
                            components={sourceMarkdownComponents}
                            remarkPlugins={[remarkGfm]}
                            skipHtml
                          >
                            {source.text}
                          </ReactMarkdown>
                        </div>
                      )}
                      {source.provenance.sourceUri?.startsWith("http") && (
                        <a
                          href={source.provenance.sourceUri}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 inline-block break-all font-mono text-[10px] text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                        >
                          {source.sourceType === "example"
                            ? "查看官方来源 ↗"
                            : "查看文档 ↗"}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <ResponseFeedback requestId={feedbackRequestId} route="ask" />
        </div>
      )}
    </>
  );
}

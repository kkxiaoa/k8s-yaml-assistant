import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LABEL, PRIMARY_BTN } from './styles';
import type { AskMode, SourceHit } from '../lib/api';

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-2 text-sm leading-relaxed text-fg">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-fg">{children}</strong>
  ),
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
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className={`font-mono text-xs text-fg/85 ${className ?? ''}`}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-ink px-1 py-0.5 font-mono text-[12px] text-brand">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded border border-line bg-ink p-3 leading-relaxed">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-brand/40 pl-3 text-sm text-fg/75">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs text-fg/85">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-ink px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
};

function MarkdownText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="mt-3 min-w-0 break-words text-sm">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
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
  asking: boolean;
  disabled: boolean;
  canExplainField: boolean;
  canExplainError: boolean;
  onChange: (v: string) => void;
  onAsk: (mode?: AskMode, questionOverride?: string) => void;
}

export function AskPanel({
  question,
  answer,
  sources,
  asking,
  disabled,
  canExplainField,
  canExplainError,
  onChange,
  onAsk,
}: Props) {
  // 引用驱动展示:只列答案 [S{n}] 真正引用到的来源,过滤掉未被采用的无关召回
  const citedNs = new Set(
    [...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])),
  );
  const cited = sources.filter((s) => s.n != null && citedNs.has(s.n));
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <span className={LABEL}>解释当前配置</span>
      </div>
      <div className="px-4 py-3">
        <div className="mb-2 flex flex-wrap gap-2">
          <button
            className="rounded border border-line px-2 py-1 font-mono text-[11px] text-fg/80 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onAsk('explain_field', '解释当前字段')}
            disabled={disabled || !canExplainField}
          >
            解释当前字段
          </button>
          <button
            className="rounded border border-line px-2 py-1 font-mono text-[11px] text-fg/80 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onAsk('explain_error', '解释当前校验错误')}
            disabled={disabled || !canExplainError}
          >
            解释当前错误
          </button>
        </div>
        <textarea
          value={question}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder="问一个关于当前配置的问题,例如某字段能填哪些值、怎么配某项"
          className="w-full resize-none rounded border border-line bg-ink px-3 py-2 text-sm text-fg outline-none transition focus:border-brand/50 placeholder:text-muted"
        />
        <button
          className={`mt-2 ${PRIMARY_BTN}`}
          onClick={() => onAsk('free')}
          disabled={disabled || !question.trim()}
        >
          {asking ? '分析中…' : '解释'}
        </button>
        {answer && <MarkdownText text={answer} streaming={asking} />}
        {cited.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className={LABEL}>答案依据</div>
            <ul className="mt-2 space-y-2">
              {cited.map((source, i) => (
                <li key={source.id} className="rounded border border-line bg-ink/50 px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand">
                        S{source.n ?? i + 1}
                      </span>
                      <span className="min-w-0 break-all font-mono text-[11px] text-brand">
                        {source.resource}{source.path ? ` · ${source.path}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] uppercase text-muted">
                      {source.sourceType}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-xs leading-relaxed text-fg/80">
                    {source.text}
                  </p>
                  {/* sourceUri 目前只有 schema 来源有(http);此判断是防未来非 URL 来源渲染成坏链接 */}
                  {source.sourceUri?.startsWith('http') && (
                    <a
                      href={source.sourceUri}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block break-all font-mono text-[10px] text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                    >
                      查看文档 ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

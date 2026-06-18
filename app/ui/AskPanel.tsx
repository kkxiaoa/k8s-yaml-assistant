import { LABEL, PRIMARY_BTN } from './styles';

interface Props {
  question: string;
  answer: string;
  asking: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
  onAsk: () => void;
}

export function AskPanel({
  question,
  answer,
  asking,
  disabled,
  onChange,
  onAsk,
}: Props) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <span className={LABEL}>RAG 问答</span>
      </div>
      <div className="px-4 py-3">
        <textarea
          value={question}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full resize-none rounded border border-line bg-ink px-3 py-2 text-sm text-fg outline-none transition focus:border-brand/50"
        />
        <button
          className={`mt-2 ${PRIMARY_BTN}`}
          onClick={onAsk}
          disabled={disabled || !question.trim()}
        >
          {asking ? '思考中…' : '问'}
        </button>
        {answer && (
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">
            {answer}
            {asking && (
              <span className="ml-0.5 animate-pulse text-brand">▌</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

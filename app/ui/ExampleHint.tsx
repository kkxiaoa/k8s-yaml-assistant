import { Tooltip } from './Tooltip';

interface Props {
  children: string;
  applyLabel: string;
  onApply: () => void;
}

export function ExampleHint({ children, applyLabel, onApply }: Props) {
  return (
    <div className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
      <p>
        <span className="mr-1 text-brand/75">示例：</span>
        {children}
        <Tooltip
          content="填入上方输入框"
          align="end"
          placement="top"
          describeChild
          className="ml-0.5 -translate-y-px align-middle"
        >
          <button
            type="button"
            onClick={onApply}
            aria-label={applyLabel}
            className="inline-flex size-5 items-center justify-center rounded text-muted/80 transition hover:bg-white/5 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M5 14v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </Tooltip>
      </p>
    </div>
  );
}

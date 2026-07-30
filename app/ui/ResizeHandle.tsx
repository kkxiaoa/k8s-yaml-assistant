interface Props {
  isResizing: boolean;
  onMouseDown: (event: React.MouseEvent) => void;
}

export function ResizeHandle({ isResizing, onMouseDown }: Props) {
  const dotClass = isResizing
    ? 'bg-brand'
    : 'bg-muted group-hover:bg-brand';

  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整宽度"
      className="group relative z-10 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
    >
      <div
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
          isResizing ? 'bg-brand/50' : 'bg-line group-hover:bg-brand/50'
        }`}
      />
      <div
        className={`relative flex h-9 w-3.5 items-center justify-center rounded-full border shadow-sm transition-colors ${
          isResizing
            ? 'border-brand/70 bg-surface'
            : 'border-line bg-surface-2 group-hover:border-brand/70 group-hover:bg-surface'
        }`}
      >
        <div className="flex flex-col gap-[3px]">
          <span
            className={`size-[3px] rounded-full transition-colors ${dotClass}`}
          />
          <span
            className={`size-[3px] rounded-full transition-colors ${dotClass}`}
          />
          <span
            className={`size-[3px] rounded-full transition-colors ${dotClass}`}
          />
        </div>
      </div>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-1/2 z-30 ml-3 -translate-y-1/2 whitespace-nowrap rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-fg opacity-0 shadow-lg transition group-hover:opacity-100"
      >
        拖拽调整宽度
      </span>
    </div>
  );
}

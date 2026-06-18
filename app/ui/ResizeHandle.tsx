/** 编辑器与侧栏之间的可拖拽分隔条:贯穿细线 + 居中突出的把手节点(竖排点),hover 高亮。 */
export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      title="拖拽调整宽度"
      className="group relative z-10 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
    >
      {/* 贯穿细线 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:bg-brand/50" />
      {/* 居中把手节点 */}
      <div className="relative flex h-9 w-3.5 items-center justify-center rounded-full border border-line bg-surface-2 shadow-sm transition-colors group-hover:border-brand/70 group-hover:bg-surface">
        <div className="flex flex-col gap-[3px]">
          <span className="size-[3px] rounded-full bg-muted transition-colors group-hover:bg-brand" />
          <span className="size-[3px] rounded-full bg-muted transition-colors group-hover:bg-brand" />
          <span className="size-[3px] rounded-full bg-muted transition-colors group-hover:bg-brand" />
        </div>
      </div>
    </div>
  );
}

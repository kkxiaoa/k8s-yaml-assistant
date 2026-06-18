import type { VErr } from '../lib/yaml';
import { LABEL } from './styles';

export function ValidatePanel({ errors }: { errors: VErr[] | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className={LABEL}>校验结果</span>
        {errors !== null &&
          (errors.length === 0 ? (
            <span className="font-mono text-[11px] text-ok">✓ PASS</span>
          ) : (
            <span className="font-mono text-[11px] text-err">✗ {errors.length} ERROR</span>
          ))}
      </div>
      <div className="px-4 py-3">
        {errors === null ? (
          <p className="text-xs leading-relaxed text-muted">
            点「校验」检查当前资源 —— schema 驱动,任意资源通用,错误会在左侧编辑器内联标红。
          </p>
        ) : errors.length === 0 ? (
          <p className="text-sm text-ok">✓ 没有发现问题,符合 schema。</p>
        ) : (
          <ul className="space-y-2">
            {errors.map((e, i) => (
              <li key={i} className="rounded border border-err/20 bg-err/[0.06] px-3 py-2">
                <code className="font-mono text-[11px] text-warn">{e.path || '(根)'}</code>
                <p className="mt-0.5 text-xs leading-relaxed text-fg/80">{e.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

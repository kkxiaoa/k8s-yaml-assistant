import type { VErr } from '../lib/yaml';
import { LABEL, PRIMARY_BTN } from './styles';

interface Props {
  errors: VErr[] | null;
  onFix?: () => void;
  fixing?: boolean;
  fixDisabled?: boolean;
  fixLoginRequired?: boolean;
  fixActionHint?: string;
}

export function ValidatePanel({
  errors,
  onFix,
  fixing,
  fixDisabled,
  fixLoginRequired = false,
  fixActionHint,
}: Props) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className={LABEL}>检查与修复</span>
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
            点「检查」分析当前资源 —— schema 驱动,任意资源通用,错误会在左侧编辑器内联标红。
          </p>
        ) : errors.length === 0 ? (
          <p className="text-sm text-ok">✓ 没有发现问题,符合 schema。</p>
        ) : (
          <>
            <ul className="space-y-2">
              {errors.map((e, i) => (
                <li key={i} className="rounded border border-l-2 border-err/30 border-l-err bg-err/10 px-3 py-2">
                  <code className="font-mono text-[11px] text-warn">{e.path || '(根)'}</code>
                  <p className="mt-0.5 text-xs leading-relaxed text-fg/80">{e.message}</p>
                </li>
              ))}
            </ul>
            {onFix && (
              <span
                className="mt-3 inline-block"
                title={fixActionHint}
              >
                <button
                  className={PRIMARY_BTN}
                  onClick={onFix}
                  disabled={fixDisabled}
                >
                  {fixing
                    ? '修复中…(自检)'
                    : fixLoginRequired
                      ? '登录后修复当前问题'
                      : '修复当前问题'}
                </button>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

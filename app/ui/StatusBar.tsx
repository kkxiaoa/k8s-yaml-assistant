import type { VErr } from '../lib/yaml';

interface Props {
  kind: string | null;
  apiVersion: string | null;
  errors: VErr[] | null;
}

export function StatusBar({ kind, apiVersion, errors }: Props) {
  return (
    <footer className="flex items-center gap-5 border-t border-line bg-surface/50 px-4 py-1.5 font-mono text-[11px] text-muted">
      <span>
        kind: <span className="text-fg">{kind ?? '—'}</span>
      </span>
      <span>
        apiVersion: <span className="text-fg">{apiVersion ?? '—'}</span>
      </span>
      <span className={errors === null ? '' : errors.length === 0 ? 'text-ok' : 'text-err'}>
        {errors === null ? 'not validated' : errors.length === 0 ? '0 errors' : `${errors.length} errors`}
      </span>
      <span className="ml-auto">schema 知识库:5 资源 · 29 字段</span>
    </footer>
  );
}

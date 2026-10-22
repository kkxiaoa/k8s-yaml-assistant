import type { VErr } from '../lib/yaml';

interface Props {
  kind: string | null;
  apiVersion: string | null;
  count: number;
  errors: VErr[] | null;
}

export function StatusBar({ kind, apiVersion, count, errors }: Props) {
  const multipleResources = count > 1;
  const checkStatus =
    errors === null
      ? '暂无本地检查结果'
      : errors.length === 0
        ? '本地检查通过'
        : `本地检查：${errors.length} 个问题`;

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line bg-surface/50 px-4 py-1.5 font-mono text-[11px] text-muted">
      <span>
        {multipleResources ? '资源数' : 'kind'}:{' '}
        <span className="text-fg">
          {multipleResources ? count : (kind ?? '—')}
        </span>
      </span>
      {multipleResources && (
        <span>
          首个资源: <span className="text-fg">{kind ?? '—'}</span>
        </span>
      )}
      <span>
        {multipleResources ? '首个 apiVersion' : 'apiVersion'}:{' '}
        <span className="text-fg">{apiVersion ?? '—'}</span>
      </span>
      <span
        className={
          errors === null ? '' : errors.length === 0 ? 'text-ok' : 'text-err'
        }
      >
        {checkStatus}
      </span>
      <span>schema 知识库:动态加载</span>
      <nav
        aria-label="站点导航与备案"
        className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1.5"
      >
        <a
          href="https://incident.kubesmith.cloud/"
          className="hover:text-fg focus-visible:text-fg"
        >
          Incident Agent
        </a>
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-fg focus-visible:text-fg"
        >
          豫ICP备2026051618号-1
        </a>
      </nav>
    </footer>
  );
}

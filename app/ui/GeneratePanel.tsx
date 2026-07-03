'use client';

import { useState } from 'react';
import { LABEL, PRIMARY_BTN } from './styles';

interface Props {
  busy: boolean;
  onGenerate: (requirement: string) => void;
}

export function GeneratePanel({ busy, onGenerate }: Props) {
  const [req, setReq] = useState('');
  return (
      <div className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <span className={LABEL}>生成资源</span>
      </div>
      <div className="px-4 py-3">
        <textarea
          value={req}
          onChange={(e) => setReq(e.target.value)}
          rows={5}
          placeholder="描述要生成的资源,例如:名为 web 的 Deployment,3 副本,镜像 nginx:1.27,容器端口 80,并配一个 ClusterIP Service 暴露 80"
          className="min-h-[7rem] w-full resize-y rounded border border-line bg-ink px-3 py-2 text-sm leading-relaxed text-fg outline-none transition focus:border-brand/50 placeholder:text-muted"
        />
        <button className={`mt-2 ${PRIMARY_BTN}`} onClick={() => onGenerate(req)} disabled={busy || !req.trim()}>
          {busy ? '生成中…(自检)' : '生成到编辑器'}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { LABEL, PRIMARY_BTN } from './styles';

interface Props {
  busy: boolean;
  onGenerate: (requirement: string) => void;
}

export function GeneratePanel({ busy, onGenerate }: Props) {
  const [req, setReq] = useState(
    '用 AWS EBS CSI、保留策略、延迟绑定、允许扩容的 StorageClass,名字 prod-ssd',
  );
  return (
      <div className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <span className={LABEL}>生成资源</span>
      </div>
      <div className="px-4 py-3">
        <textarea
          value={req}
          onChange={(e) => setReq(e.target.value)}
          rows={2}
          className="w-full resize-none rounded border border-line bg-ink px-3 py-2 text-sm text-fg outline-none transition focus:border-brand/50"
        />
        <button className={`mt-2 ${PRIMARY_BTN}`} onClick={() => onGenerate(req)} disabled={busy || !req.trim()}>
          {busy ? '生成中…(自检)' : '生成到编辑器'}
        </button>
      </div>
    </div>
  );
}

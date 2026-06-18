'use client';

import { useState } from 'react';
import Editor from '@monaco-editor/react';

const DEFAULT_YAML = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`;

interface VErr {
  path: string;
  message: string;
}

const card: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 12,
};
const btn: React.CSSProperties = {
  background: '#238636',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '6px 14px',
};

export default function Home() {
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [errors, setErrors] = useState<VErr[] | null>(null);
  const [question, setQuestion] = useState(
    'reclaimPolicy 能填哪些值?默认是什么?',
  );
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setErrors(null);
    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      });
      const data = (await res.json()) as { errors: VErr[] };
      setErrors(data.errors);
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    setBusy(true);
    setAnswer('');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        setAnswer((a) => a + dec.decode(value));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{ padding: '12px 20px', borderBottom: '1px solid #30363d' }}
      >
        <strong>K8s YAML 智能助手</strong>
        <span style={{ color: '#8b949e', marginLeft: 12, fontSize: 13 }}>
          Monaco 编辑 · RAG 问答 · 校验(向量→软路由→rerank)
        </span>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 左:Monaco YAML 编辑器 */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #30363d',
          }}
        >
          <div style={{ padding: 8 }}>
            <button style={btn} onClick={check} disabled={busy}>
              校验 StorageClass
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor
              height="100%"
              defaultLanguage="yaml"
              theme="vs-dark"
              value={yaml}
              onChange={(v) => setYaml(v ?? '')}
              options={{ minimap: { enabled: false }, fontSize: 13 }}
            />
          </div>
        </div>

        {/* 右:校验结果 + 问答 */}
        <div
          style={{
            width: 460,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            overflow: 'auto',
          }}
        >
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>校验结果</div>
            {errors === null ? (
              <div style={{ color: '#8b949e', fontSize: 13 }}>
                点上方「校验」检查这段 YAML
              </div>
            ) : errors.length === 0 ? (
              <div style={{ color: '#3fb950' }}>✓ 校验通过,没有发现问题</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {errors.map((e, i) => (
                  <li
                    key={i}
                    style={{ color: '#f85149', marginBottom: 4, fontSize: 13 }}
                  >
                    <code style={{ color: '#d29922' }}>{e.path || '(根)'}</code>
                    :{e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>RAG 问答</div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              style={{
                width: '100%',
                background: '#0d1117',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: 6,
                padding: 8,
                resize: 'vertical',
              }}
            />
            <button
              style={{ ...btn, marginTop: 8 }}
              onClick={ask}
              disabled={busy || !question.trim()}
            >
              {busy ? '思考中…' : '问'}
            </button>
            {answer && (
              <div
                style={{
                  marginTop: 12,
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.6,
                  fontSize: 14,
                }}
              >
                {answer}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

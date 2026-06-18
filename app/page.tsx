'use client';

import { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { detectResource, buildMarkers, type VErr, type EditorT, type MonacoT } from './lib/yaml';
import { LABEL, PRIMARY_BTN } from './ui/styles';
import { ValidatePanel } from './ui/ValidatePanel';
import { AskPanel } from './ui/AskPanel';
import { StatusBar } from './ui/StatusBar';
import { ResizeHandle } from './ui/ResizeHandle';
import { useResizable } from './lib/use-resizable';
import { checkYaml, askStream } from './lib/api';

const DEFAULT_YAML = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`;

export default function Home() {
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [errors, setErrors] = useState<VErr[] | null>(null);
  const [question, setQuestion] = useState('reclaimPolicy 能填哪些值?默认是什么?');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'check' | 'ask' | null>(null);
  const editorRef = useRef<EditorT | null>(null);
  const monacoRef = useRef<MonacoT | null>(null);
  const { width, onResizeStart } = useResizable(440, 320, 760);

  const { kind, apiVersion } = detectResource(yaml);

  function setMarkers(errs: VErr[]) {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (monaco && model) monaco.editor.setModelMarkers(model, 'k8s', errs ? buildMarkers(yaml, errs, monaco) : []);
  }

  async function check() {
    setBusy('check');
    setErrors(null);
    try {
      const errs = await checkYaml(yaml);
      setErrors(errs);
      setMarkers(errs);
    } finally {
      setBusy(null);
    }
  }

  async function ask() {
    setBusy('ask');
    setAnswer('');
    try {
      await askStream(question, (t) => setAnswer((a) => a + t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-surface/50 px-5 py-3 backdrop-blur">
        <span className="text-brand">◆</span>
        <span className="font-mono text-sm font-semibold tracking-tight text-fg">
          k8s<span className="text-muted">.</span>assistant
        </span>
        <span className={LABEL}>schema-driven · RAG · validate</span>
        {kind && (
          <span className="ml-auto rounded border border-brand/30 bg-brand/10 px-2.5 py-1 font-mono text-[11px] text-brand">
            {kind}
          </span>
        )}
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2">
            <button className={PRIMARY_BTN} onClick={check} disabled={busy !== null}>
              {busy === 'check' ? '校验中…' : `校验 ${kind ?? '资源'}`}
            </button>
            <span className="font-mono text-[11px] text-muted">{apiVersion ?? '—'}</span>
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              defaultLanguage="yaml"
              theme="vs-dark"
              value={yaml}
              onChange={(v) => {
                setYaml(v ?? '');
                setMarkers([]); // 编辑即清除旧标记
              }}
              onMount={(ed, m) => {
                editorRef.current = ed;
                monacoRef.current = m;
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: 'var(--font-plex-mono)',
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'none',
              }}
            />
          </div>
        </section>

        <ResizeHandle onMouseDown={onResizeStart} />

        <aside
          style={{ width }}
          className="flex shrink-0 flex-col gap-4 overflow-auto p-4"
        >
          <ValidatePanel errors={errors} />
          <AskPanel
            question={question}
            answer={answer}
            asking={busy === 'ask'}
            disabled={busy !== null}
            onChange={setQuestion}
            onAsk={ask}
          />
        </aside>
      </main>

      <StatusBar kind={kind} apiVersion={apiVersion} errors={errors} />
    </div>
  );
}

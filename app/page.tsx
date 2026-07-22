'use client';

import { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  detectResource,
  buildMarkers,
  inferPathAtLine,
  type VErr,
  type EditorT,
  type MonacoT,
} from './lib/yaml';
import { LABEL, PRIMARY_BTN } from './ui/styles';
import { GeneratePanel } from './ui/GeneratePanel';
import { ValidatePanel } from './ui/ValidatePanel';
import { AskPanel } from './ui/AskPanel';
import { StatusBar } from './ui/StatusBar';
import { ResizeHandle } from './ui/ResizeHandle';
import { useResizable } from './lib/use-resizable';
import {
  checkYaml,
  askStream,
  generateYaml,
  fixYaml,
  type AskMode,
  type SourceHit,
} from './lib/api';

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
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<SourceHit[]>([]);
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'ask' | 'gen' | 'fix' | null>(
    null,
  );
  const editorRef = useRef<EditorT | null>(null);
  const monacoRef = useRef<MonacoT | null>(null);
  const { width, onResizeStart } = useResizable(560, 380, 960);

  const { kind, apiVersion, count } = detectResource(yaml);

  function setMarkers(errs: VErr[]) {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (monaco && model)
      monaco.editor.setModelMarkers(
        model,
        'k8s',
        errs ? buildMarkers(yaml, errs, monaco) : [],
      );
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

  function getSelectedText(): string {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    if (!selection || !model || selection.isEmpty()) return '';
    return model.getValueInRange(selection);
  }

  function getCursorPath(): string | null {
    return inferPathAtLine(yaml, editorRef.current?.getPosition()?.lineNumber);
  }

  async function ask(mode: AskMode = 'free', questionOverride?: string) {
    const q = (questionOverride ?? question).trim();

    if (!q) return;
    if (questionOverride) setQuestion(questionOverride);

    const selectedText = getSelectedText();
    const cursorPathHint =
      mode === 'explain_field' || selectedText ? getCursorPath() : null;

    setBusy('ask');
    setAnswer('');
    setSources([]);

    try {
      await askStream(
        q,
        mode,
        {
          yaml,
          kind,
          apiVersion,
          selectedText,
          cursorPath: cursorPathHint,
          errors: errors ?? [],
        },
        {
          onSources: setSources,
          onDelta: (t) => setAnswer((a) => a + t),
        },
      );
    } finally {
      setBusy(null);
    }
  }

  // Phase D:agentic 动作 —— 生成 / 修复都把结果灌回编辑器
  function loadYaml(y: string | null) {
    if (!y) return;
    setYaml(y);
    setErrors(null);
    setMarkers([]);
  }

  async function generate(requirement: string) {
    setBusy('gen');
    try {
      const { yaml: y } = await generateYaml(requirement);
      loadYaml(y);
    } finally {
      setBusy(null);
    }
  }

  async function fix() {
    if (!errors || errors.length === 0) return;
    setBusy('fix');
    try {
      const { yaml: y } = await fixYaml(yaml, errors);
      loadYaml(y);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-surface/50 px-5 py-3 backdrop-blur">
        <span className="text-brand">◆</span>
        <span className="font-mono text-sm font-semibold tracking-tight text-fg">
          k8s<span className="text-muted">.</span>yaml copilot
        </span>
        <span className={LABEL}>YAML 编写 · Schema 校验 · 答案可追溯</span>
        {kind && (
          <span className="ml-auto rounded border border-brand/30 bg-brand/10 px-2.5 py-1 font-mono text-[11px] text-brand">
            {kind}
            {count > 1 ? ` +${count - 1}` : ''}
          </span>
        )}
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2">
            <button
              className={PRIMARY_BTN}
              onClick={check}
              disabled={busy !== null}
            >
              {busy === 'check'
                ? '检查中…'
                : count > 1
                  ? `检查 ${count} 个资源`
                  : `检查 ${kind ?? '资源'}`}
            </button>
            <span className="font-mono text-[11px] text-muted">
              {apiVersion ?? '—'}
            </span>
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
                setCursorPath(
                  inferPathAtLine(
                    v ?? '',
                    editorRef.current?.getPosition()?.lineNumber,
                  ),
                );
              }}
              onMount={(ed, m) => {
                editorRef.current = ed;
                monacoRef.current = m;
                setCursorPath(
                  inferPathAtLine(yaml, ed.getPosition()?.lineNumber),
                );
                ed.onDidChangeCursorPosition((e) => {
                  setCursorPath(
                    inferPathAtLine(ed.getValue(), e.position.lineNumber),
                  );
                });
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
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
          <GeneratePanel busy={busy === 'gen'} onGenerate={generate} />
          <ValidatePanel errors={errors} onFix={fix} fixing={busy === 'fix'} />
          <AskPanel
            question={question}
            answer={answer}
            sources={sources}
            asking={busy === 'ask'}
            disabled={busy !== null}
            canExplainField={Boolean(cursorPath)}
            canExplainError={Boolean(errors?.length)}
            onChange={setQuestion}
            onAsk={ask}
          />
        </aside>
      </main>

      <StatusBar kind={kind} apiVersion={apiVersion} errors={errors} />
    </div>
  );
}

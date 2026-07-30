'use client';

import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  detectResource,
  buildMarkers,
  inferPathAtLine,
  type VErr,
  type EditorT,
  type MonacoT,
} from './lib/yaml';
import { PRIMARY_BTN } from './ui/styles';
import { AppHeader } from './ui/AppHeader';
import { GeneratePanel } from './ui/GeneratePanel';
import { ValidatePanel } from './ui/ValidatePanel';
import { AskPanel } from './ui/AskPanel';
import { StatusBar } from './ui/StatusBar';
import { ResizeHandle } from './ui/ResizeHandle';
import { useResizable } from './lib/use-resizable';
import { useExperience } from './lib/use-experience';
import {
  ApiRequestError,
  apiErrorMessage,
  checkYaml,
  askStream,
  generateYaml,
  fixYaml,
  getGithubSignInUrl,
  type AskMode,
  type SourceHit,
} from './lib/api';
import { APPLICATION_BASE_PATH } from '@/shared/application-path.mjs';
import { type ModelRoute } from '@/server/experience-control';

const DEFAULT_YAML = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`;

const DRAFT_KEY = 'k8s-yaml-assistant-login-draft';
const DRAFT_MAX_AGE_MS = 10 * 60_000;

interface LoginDraft {
  version: 2;
  savedAt: number;
  yaml: string;
  question: string;
  requirement: string;
  pendingAction: ModelRoute | null;
}

function modelLockMessage(reason: string | null): string {
  return reason === null
    ? '正在确认登录和体验状态…'
    : apiErrorMessage(reason);
}

export default function Home() {
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [errors, setErrors] = useState<VErr[] | null>(null);
  const [question, setQuestion] = useState('');
  const [requirement, setRequirement] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<SourceHit[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [restoredAction, setRestoredAction] = useState<ModelRoute | null>(
    null,
  );
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'ask' | 'gen' | 'fix' | null>(
    null,
  );
  const editorRef = useRef<EditorT | null>(null);
  const monacoRef = useRef<MonacoT | null>(null);
  const { width, isResizing, onResizeStart } = useResizable(560, 380, 960);
  const { experience, errorCode: experienceError, refresh } = useExperience();

  const { kind, apiVersion, count } = detectResource(yaml);
  function modelReason(route: ModelRoute): string | null {
    return experienceError ?? experience?.model[route].reason ?? null;
  }

  function loginRequiredFor(route: ModelRoute): boolean {
    return (
      experience?.authenticated === false &&
      experience.quota?.kind === 'anonymous_trial' &&
      experience.model[route].reason === 'quota_exhausted'
    );
  }

  function modelActionDisabled(route: ModelRoute): boolean {
    if (busy !== null || experience === null || experienceError !== null) {
      return true;
    }
    if (loginRequiredFor(route)) return false;
    return experience.model[route].reason !== null;
  }

  function modelActionHint(route: ModelRoute): string | undefined {
    if (loginRequiredFor(route)) {
      return '匿名体验额度不足，登录后获得独立每日额度';
    }
    if (
      experience?.quota?.kind === 'daily' &&
      experience.model[route].reason === 'quota_exhausted'
    ) {
      return '今日点数不足以执行此操作';
    }
    if (
      experience === null ||
      experienceError !== null ||
      experience.model[route].reason !== null
    ) {
      return modelLockMessage(modelReason(route));
    }
    return undefined;
  }

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(DRAFT_KEY);
      window.sessionStorage.removeItem(DRAFT_KEY);
      if (raw === null) return;
      const draft = JSON.parse(raw) as Partial<LoginDraft>;
      if (
        draft.version !== 2 ||
        typeof draft.savedAt !== 'number' ||
        Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS ||
        typeof draft.yaml !== 'string' ||
        typeof draft.question !== 'string' ||
        typeof draft.requirement !== 'string' ||
        !(
          draft.pendingAction === null ||
          draft.pendingAction === 'ask' ||
          draft.pendingAction === 'generate' ||
          draft.pendingAction === 'fix'
        )
      ) {
        return;
      }
      setYaml(draft.yaml);
      setQuestion(draft.question);
      setRequirement(draft.requirement);
      setRestoredAction(draft.pendingAction);
    } catch {
      if (raw !== null) window.sessionStorage.removeItem(DRAFT_KEY);
    }
  }, []);

  async function beginLogin(
    pendingAction: ModelRoute | null = null,
    override?: { question?: string; requirement?: string },
  ): Promise<void> {
    const draft: LoginDraft = {
      version: 2,
      savedAt: Date.now(),
      yaml,
      question: override?.question ?? question,
      requirement: override?.requirement ?? requirement,
      pendingAction,
    };
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Login remains available when current-tab storage is unavailable.
    }
    try {
      window.location.assign(await getGithubSignInUrl(APPLICATION_BASE_PATH));
    } catch (error) {
      reportRequestError(error);
    }
  }

  function reportRequestError(error: unknown): void {
    if (error instanceof ApiRequestError) {
      setRequestError(error.message);
      if (
        [
          'quota_exhausted',
          'sleep_mode',
          'global_budget_exhausted',
          'model_access_disabled',
          'control_state_unavailable',
        ].includes(error.code)
      ) {
        void refresh();
      }
      return;
    }
    setRequestError(apiErrorMessage('request_failed'));
  }

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
    setRequestError(null);
    try {
      const errs = await checkYaml(yaml);
      setErrors(errs);
      setMarkers(errs);
    } catch (error) {
      reportRequestError(error);
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
    if (loginRequiredFor('ask')) {
      void beginLogin('ask', { question: q });
      return;
    }
    if (modelActionDisabled('ask')) {
      setRequestError(
        modelActionHint('ask') ?? modelLockMessage(modelReason('ask')),
      );
      return;
    }

    const selectedText = getSelectedText();
    const cursorPathHint =
      mode === 'explain_field' || selectedText ? getCursorPath() : null;

    setBusy('ask');
    setAnswer('');
    setSources([]);
    setRequestError(null);
    setRestoredAction(null);

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
    } catch (error) {
      reportRequestError(error);
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  function loadYaml(y: string | null) {
    if (!y) return;
    setYaml(y);
    setErrors(null);
    setMarkers([]);
  }

  async function generate(requestedRequirement: string) {
    if (loginRequiredFor('generate')) {
      void beginLogin('generate', { requirement: requestedRequirement });
      return;
    }
    if (modelActionDisabled('generate')) {
      setRequestError(
        modelActionHint('generate') ??
          modelLockMessage(modelReason('generate')),
      );
      return;
    }
    setBusy('gen');
    setRequestError(null);
    setRestoredAction(null);
    try {
      const { yaml: y } = await generateYaml(requestedRequirement);
      loadYaml(y);
    } catch (error) {
      reportRequestError(error);
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function fix() {
    if (!errors || errors.length === 0) return;
    if (loginRequiredFor('fix')) {
      void beginLogin('fix');
      return;
    }
    if (modelActionDisabled('fix')) {
      setRequestError(
        modelActionHint('fix') ?? modelLockMessage(modelReason('fix')),
      );
      return;
    }
    setBusy('fix');
    setRequestError(null);
    setRestoredAction(null);
    try {
      const { yaml: y } = await fixYaml(yaml, errors);
      loadYaml(y);
    } catch (error) {
      reportRequestError(error);
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <AppHeader
        experience={experience}
        onLogin={() => void beginLogin()}
      />

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
            <span className="ml-auto font-mono text-[10px] text-muted">
              本地 schema（结构模式）检查 · 不调用外部模型
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
                setErrors(null);
                setMarkers([]);
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

        <ResizeHandle
          isResizing={isResizing}
          onMouseDown={onResizeStart}
        />

        <aside
          style={{ width }}
          className="flex shrink-0 flex-col gap-4 overflow-auto p-4"
        >
          {requestError && (
            <div
              role="alert"
              className="rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-xs leading-relaxed text-fg"
            >
              {requestError}
            </div>
          )}
          {restoredAction && (
            <div
              role="status"
              className="rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-xs leading-relaxed text-fg"
            >
              {experience?.authenticated
                ? restoredAction === 'fix'
                  ? '登录成功，YAML 已恢复。请重新检查后再执行修复。'
                  : '登录成功，内容已恢复。请再次点击执行，本次不会自动消耗额度。'
                : '内容已恢复。登录完成后可继续执行，本次不会自动消耗额度。'}
            </div>
          )}
          <GeneratePanel
            requirement={requirement}
            busy={busy === 'gen'}
            disabled={modelActionDisabled('generate')}
            loginRequired={loginRequiredFor('generate')}
            actionHint={modelActionHint('generate')}
            onRequirementChange={setRequirement}
            onGenerate={generate}
          />
          <ValidatePanel
            errors={errors}
            onFix={fix}
            fixing={busy === 'fix'}
            fixDisabled={modelActionDisabled('fix')}
            fixLoginRequired={loginRequiredFor('fix')}
            fixActionHint={modelActionHint('fix')}
          />
          <AskPanel
            question={question}
            answer={answer}
            sources={sources}
            asking={busy === 'ask'}
            disabled={modelActionDisabled('ask')}
            loginRequired={loginRequiredFor('ask')}
            actionHint={modelActionHint('ask')}
            canExplainField={Boolean(cursorPath)}
            canExplainError={Boolean(errors?.length)}
            onChange={setQuestion}
            onAsk={ask}
          />
        </aside>
      </main>

      <StatusBar
        kind={kind}
        apiVersion={apiVersion}
        count={count}
        errors={errors}
      />
    </div>
  );
}

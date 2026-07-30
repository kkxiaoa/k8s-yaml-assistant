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
import { LABEL, PRIMARY_BTN } from './ui/styles';
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
import {
  APPLICATION_BASE_PATH,
  applicationPath,
} from '@/shared/application-path.mjs';
import {
  type ExperienceMode,
  type ExperienceQuota,
  type ModelRoute,
} from '@/server/experience-control';

const DEFAULT_YAML = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`;

const LOGOUT_PATH = applicationPath(
  `/api/auth/signout?callbackUrl=${encodeURIComponent(
    APPLICATION_BASE_PATH,
  )}`,
);
const ADMIN_PATH = applicationPath('/admin');
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

function GitHubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.2.8-.5v-2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.9 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.3 11.3 0 0 0 12 .7Z" />
    </svg>
  );
}

function ModeStatusIcon({
  mode,
}: {
  mode: Extract<ExperienceMode, 'interview' | 'sleep'>;
}) {
  const showcase = mode === 'interview';
  const label = showcase ? '开放展示模式' : '休眠模式';
  return (
    <span
      className={`group relative inline-flex size-7 items-center justify-center rounded border outline-none ${
        showcase
          ? 'border-ok/40 bg-ok/10 text-ok focus:border-ok'
          : 'border-warn/40 bg-warn/10 text-warn focus:border-warn'
      }`}
      role="img"
      aria-label={label}
      tabIndex={0}
    >
      {showcase ? (
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M2.8 12s3.3-5 9.2-5 9.2 5 9.2 5-3.3 5-9.2 5-9.2-5-9.2-5Z" />
          <circle cx="12" cy="12" r="2.3" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" />
        </svg>
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-fg opacity-0 shadow-lg transition group-hover:opacity-100 group-focus:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

function quotaPresentation(
  quota: ExperienceQuota | null | undefined,
): { label: string; title: string } | null {
  if (quota === null || quota === undefined) return null;
  if (quota.kind === 'unlimited') {
    return { label: '个人额度不限', title: '管理员不受个人点数限制' };
  }
  const timestamp =
    quota.kind === 'anonymous_trial' ? quota.expiresAt : quota.resetsAt;
  const timeLabel = new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
  });
  return {
    label:
      quota.kind === 'anonymous_trial'
        ? `匿名体验 ${quota.remaining}/${quota.limit} 点`
        : `今日剩余 ${quota.remaining}/${quota.limit} 点`,
    title:
      quota.kind === 'anonymous_trial'
        ? `匿名体验包有效至 ${timeLabel}；登录后获得独立每日额度`
        : `额度于 ${timeLabel} 重置`,
  };
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
  const { width, onResizeStart } = useResizable(560, 380, 960);
  const { experience, errorCode: experienceError, refresh } = useExperience();

  const { kind, apiVersion, count } = detectResource(yaml);
  const quotaStatus = quotaPresentation(experience?.quota);

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
      <header className="flex items-center gap-4 border-b border-line bg-surface/50 px-5 py-3 backdrop-blur">
        <span className="text-brand">◆</span>
        <span className="font-mono text-sm font-semibold tracking-tight text-fg">
          K8s YAML Assistant
        </span>
        <span className={LABEL}>YAML 编写 · Schema 校验 · 答案可追溯</span>
        <div className="ml-auto flex items-center gap-2">
          {experience?.mode === 'interview' && (
            <ModeStatusIcon mode="interview" />
          )}
          {experience?.mode === 'sleep' && (
            <ModeStatusIcon mode="sleep" />
          )}
          {quotaStatus && (
            <span
              className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-muted"
              title={quotaStatus.title}
            >
              {quotaStatus.label}
            </span>
          )}
          {experience?.user ? (
            <div className="flex h-8 min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-surface/70 font-mono text-[11px] shadow-sm">
              <span
                className="inline-flex min-w-0 items-center gap-1.5 border-r border-line px-2.5 text-muted"
                title={`已通过 GitHub 登录：@${experience.user.login}`}
              >
                <GitHubMark />
                <span className="max-w-32 truncate">
                  @{experience.user.login}
                </span>
              </span>
              {experience.user.admin && (
                <a
                  href={ADMIN_PATH}
                  className="inline-flex items-center border-r border-line px-3 text-fg transition hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40"
                >
                  管理
                </a>
              )}
              <a
                href={LOGOUT_PATH}
                className="inline-flex items-center px-3 text-muted transition hover:bg-white/5 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40"
              >
                退出
              </a>
            </div>
          ) : (
            <span className="group relative">
              <button
                type="button"
                onClick={() => void beginLogin()}
                aria-describedby="github-login-hint"
                className="inline-flex items-center gap-1.5 rounded border border-brand/40 px-2.5 py-1 font-mono text-[11px] text-brand transition hover:border-brand/60 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <GitHubMark />
                使用 GitHub 登录
              </button>
              <span
                id="github-login-hint"
                role="tooltip"
                className="pointer-events-none absolute right-0 top-full z-30 mt-2 whitespace-nowrap rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-fg opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
              >
                登录后可解锁更高的每日体验额度
              </span>
            </span>
          )}
        </div>
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

        <ResizeHandle onMouseDown={onResizeStart} />

        <aside
          style={{ width }}
          className="flex shrink-0 flex-col gap-4 overflow-auto p-4"
        >
          <div
            role="note"
            className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3"
          >
            <p className="font-mono text-[11px] font-semibold text-warn">
              隐私与费用边界
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-fg/80">
              「检查」只在本服务内使用 schema（结构模式），不调用外部模型。
              解释、生成和修复可能把完成任务所需的问题、YAML（配置文件）和编辑上下文发送给
              DeepSeek（回答模型）与 Voyage（向量与重排模型），并产生费用。请勿提交
              Secret（密钥）、私钥或生产集群敏感配置。
            </p>
          </div>
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

'use client';

import { useEffect, useState } from 'react';
import type {
  AdminExperienceRequest,
  AdminExperienceResponse,
} from '@/server/experience-control';
import { applicationPath } from '@/shared/application-path.mjs';
import {
  ApiRequestError,
  apiErrorMessage,
  getAdminExperience,
  getGithubSignInUrl,
  setAdminExperience,
} from '../lib/api';
import { useExperience } from '../lib/use-experience';

const HOME_PATH = applicationPath('/');
const ADMIN_PATH = applicationPath('/admin');

const MODE_LABELS = {
  normal: '普通模式',
  interview: '开放展示模式',
  sleep: '休眠模式',
} as const;

type ShowcaseDurationHours = Extract<
  AdminExperienceRequest,
  { mode: 'interview' }
>['durationHours'];

export default function AdminPage() {
  const { experience, errorCode } = useExperience();
  const [state, setState] = useState<AdminExperienceResponse | null>(null);
  const [durationHours, setDurationHours] =
    useState<ShowcaseDurationHours | null>(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (experience?.user?.admin !== true) return;
    void getAdminExperience()
      .then((next) => {
        setState(next);
        setDurationHours(next.mode === 'interview' ? null : 4);
        setMessage(null);
      })
      .catch((error: unknown) => {
        setMessage(
          error instanceof ApiRequestError
            ? error.message
            : '管理状态暂不可用。',
        );
      });
  }, [experience?.user?.admin]);

  async function update(request: AdminExperienceRequest): Promise<boolean> {
    const durationUpdate =
      state?.mode === 'interview' && request.mode === 'interview';
    setBusy(true);
    setMessage(null);
    try {
      const next = await setAdminExperience(request);
      setState(next);
      if (next.mode !== 'interview') setDurationHours(4);
      setMessage(
        durationUpdate ? '开放展示时长已更新。' : '模式已更新。',
      );
      return true;
    } catch (error) {
      setMessage(
        error instanceof ApiRequestError
          ? error.message
          : '模式更新失败，请稍后重试。',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeDuration(value: string): Promise<void> {
    const next = Number(value) as ShowcaseDurationHours;
    setDurationHours(next);
    if (state?.mode !== 'interview') return;
    if (!(await update({ mode: 'interview', durationHours: next }))) {
      setDurationHours(null);
    }
  }

  async function beginLogin(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      window.location.assign(await getGithubSignInUrl(ADMIN_PATH));
    } catch (error) {
      setMessage(
        error instanceof ApiRequestError
          ? error.message
          : apiErrorMessage('authentication_unavailable'),
      );
      setBusy(false);
    }
  }

  if (experience === null && errorCode === null) {
    return (
      <main className="mx-auto max-w-2xl p-8 text-sm text-muted">
        正在确认管理员身份…
      </main>
    );
  }

  if (experience === null) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="font-mono text-lg font-semibold text-fg">
          体验模式管理
        </h1>
        <p className="mt-4 text-sm text-err">
          体验状态暂不可用，管理操作已安全关闭。
        </p>
        <a
          href={HOME_PATH}
          className="mt-4 inline-block text-sm text-brand underline"
        >
          返回编辑器
        </a>
      </main>
    );
  }

  if (!experience?.authenticated) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="font-mono text-lg font-semibold text-fg">
          体验模式管理
        </h1>
        <p className="mt-4 text-sm text-muted">请先登录管理员账号。</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void beginLogin()}
          className="mt-4 inline-block rounded border border-brand/40 px-3 py-2 text-sm text-brand disabled:opacity-50"
        >
          GitHub 登录
        </button>
      </main>
    );
  }

  if (experience.user?.admin !== true) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="font-mono text-lg font-semibold text-fg">
          体验模式管理
        </h1>
        <p className="mt-4 text-sm text-err">当前账号没有管理员权限。</p>
        <a
          href={HOME_PATH}
          className="mt-4 inline-block text-sm text-brand underline"
        >
          返回编辑器
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-lg font-semibold text-fg">
            体验模式管理
          </h1>
          <p className="mt-1 text-xs text-muted">
            管理员 @{experience.user.login}
          </p>
        </div>
        <a href={HOME_PATH} className="text-sm text-brand underline">
          返回编辑器
        </a>
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">当前模式</span>
          <span
            className={`rounded border px-2.5 py-1 font-mono text-xs ${
              state?.mode === 'interview'
                ? 'border-ok/40 bg-ok/10 text-ok'
                : state?.mode === 'sleep'
                  ? 'border-warn/40 bg-warn/10 text-warn'
                  : 'border-line text-fg'
            }`}
          >
            {state ? MODE_LABELS[state.mode] : '读取中'}
          </span>
        </div>
        {state?.interviewExpiresAt && (
          <p className="mt-2 text-xs text-muted">
            开放展示模式到期时间：
            {new Date(state.interviewExpiresAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}
          </p>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void update({ mode: 'normal' })}
            className="rounded border border-line px-4 py-3 text-sm text-fg transition hover:border-brand/50 disabled:opacity-50"
          >
            切换为普通模式
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void update({ mode: 'sleep' })}
            className="rounded border border-warn/40 px-4 py-3 text-sm text-warn transition hover:bg-warn/10 disabled:opacity-50"
          >
            进入休眠模式
          </button>
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <label className="text-sm text-muted" htmlFor="interview-duration">
            {state?.mode === 'interview'
              ? '更新开放展示时长'
              : '开放展示时长'}
          </label>
          <div className="mt-2 flex items-center gap-3">
            <select
              id="interview-duration"
              value={durationHours ?? ''}
              disabled={busy}
              onChange={(event) => void changeDuration(event.target.value)}
              className="rounded border border-line bg-ink px-3 py-2 text-sm text-fg"
            >
              {state?.mode === 'interview' && (
                <option value="" disabled>
                  选择新时长
                </option>
              )}
              <option value={1}>1 小时</option>
              <option value={4}>4 小时</option>
              <option value={8}>8 小时</option>
            </select>
            {state?.mode === 'interview' ? (
              <span className="text-xs text-muted">
                选择后自动更新，并从当前时间重新计时
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void update({
                    mode: 'interview',
                    durationHours: durationHours ?? 4,
                  })
                }
                className="rounded border border-ok/40 px-4 py-2 text-sm text-ok transition hover:bg-ok/10 disabled:opacity-50"
              >
                开启开放展示模式
              </button>
            )}
          </div>
        </div>

        {message && (
          <p className="mt-5 text-sm text-muted" role="status">
            {message}
          </p>
        )}
      </section>
    </main>
  );
}

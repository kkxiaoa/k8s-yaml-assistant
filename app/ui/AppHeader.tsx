'use client';

import type {
  ExperienceMode,
  ExperienceQuota,
  ExperienceResponse,
} from '@/server/experience-control';
import {
  APPLICATION_BASE_PATH,
  applicationPath,
} from '@/shared/application-path.mjs';
import { LABEL } from './styles';
import { Tooltip } from './Tooltip';

const LOGOUT_PATH = applicationPath(
  `/api/auth/signout?callbackUrl=${encodeURIComponent(
    APPLICATION_BASE_PATH,
  )}`,
);
const ADMIN_PATH = applicationPath('/admin');

interface Props {
  experience: ExperienceResponse | null;
  onLogin: () => void;
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
    <Tooltip
      content={label}
      align="end"
      className={`size-7 items-center justify-center rounded border border-line text-muted outline-none transition focus-visible:ring-2 focus-visible:ring-brand/35 ${
        showcase
          ? 'hover:border-ok/40 hover:bg-ok/10 hover:text-ok'
          : 'hover:border-warn/40 hover:bg-warn/10 hover:text-warn'
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
    </Tooltip>
  );
}

function PrivacyBoundaryTooltip() {
  return (
    <Tooltip
      content={
        <>
          <span className="block font-mono text-xs font-semibold text-warn">
            隐私与费用边界
          </span>
          <span className="mt-1.5 block">
            「检查」只在本服务内使用 schema（结构模式），不调用外部模型。
            解释、生成和修复可能把完成任务所需的问题、YAML（配置文件）和编辑上下文发送给
            DeepSeek（回答模型）与 Voyage（向量与重排模型），并产生费用。请勿提交
            Secret（密钥）、私钥或生产集群敏感配置。
          </span>
        </>
      }
      align="end"
      describeChild
      tooltipClassName="w-96 max-w-[calc(100vw-2rem)] whitespace-normal p-3 text-left text-xs leading-relaxed text-fg/80"
    >
      <span
        role="img"
        tabIndex={0}
        aria-label="隐私与费用边界"
        className="inline-flex size-7 items-center justify-center rounded border border-line text-muted outline-none transition hover:border-warn/40 hover:bg-warn/10 hover:text-warn focus-visible:ring-2 focus-visible:ring-warn/40"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" />
          <path d="M12 8v5" />
          <path d="M12 16h.01" />
        </svg>
      </span>
    </Tooltip>
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

export function AppHeader({ experience, onLogin }: Props) {
  const quotaStatus = quotaPresentation(experience?.quota);

  return (
    <header className="relative z-40 flex items-center gap-4 border-b border-line bg-surface/50 px-5 py-3 backdrop-blur">
      <span className="text-brand">◆</span>
      <span className="font-mono text-sm font-semibold tracking-tight text-fg">
        K8s YAML Assistant
      </span>
      <span className={LABEL}>YAML 编写 · Schema 校验 · 答案可追溯</span>
      <div className="ml-auto flex items-center gap-2">
        <PrivacyBoundaryTooltip />
        {experience?.mode === 'interview' && (
          <ModeStatusIcon mode="interview" />
        )}
        {experience?.mode === 'sleep' && <ModeStatusIcon mode="sleep" />}
        {quotaStatus && (
          <Tooltip
            content={quotaStatus.title}
            align="end"
            tabIndex={0}
            className="rounded border border-line px-2.5 py-1 font-mono text-[11px] text-muted outline-none focus:border-brand/50"
          >
            {quotaStatus.label}
          </Tooltip>
        )}
        {experience?.user ? (
          <div className="flex h-8 min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-surface/70 font-mono text-[11px] shadow-sm">
            <Tooltip
              content={`已通过 GitHub 登录：@${experience.user.login}`}
              align="end"
              tabIndex={0}
              className="min-w-0 items-center gap-1.5 border-r border-line px-2.5 text-muted outline-none focus:bg-white/5 focus:text-fg"
            >
              <GitHubMark />
              <span className="max-w-32 truncate">
                @{experience.user.login}
              </span>
            </Tooltip>
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
          <Tooltip
            content="登录后可解锁更高的每日体验额度"
            align="end"
            describeChild
          >
            <button
              type="button"
              onClick={onLogin}
              className="inline-flex items-center gap-1.5 rounded border border-brand/40 px-2.5 py-1 font-mono text-[11px] text-brand transition hover:border-brand/60 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <GitHubMark />
              使用 GitHub 登录
            </button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type {
  ModelRoute,
  ResponseFeedbackReason,
  ResponseFeedbackSelection,
} from '@/server/experience-control';
import {
  ApiRequestError,
  submitResponseFeedback,
} from '../lib/api';
import { responseFeedbackReasonOptions } from '../lib/response-feedback';
import { Tooltip } from './Tooltip';

interface Props {
  requestId: string | null;
  route: ModelRoute;
}

const ACTION_LABELS: Readonly<
  Record<
    ModelRoute,
    {
      target: string;
      positive: string;
      negative: string;
    }
  >
> = {
  ask: {
    target: '本次回答',
    positive: '本次回答有帮助',
    negative: '本次回答没有帮助',
  },
  generate: {
    target: '本次生成',
    positive: '本次生成有帮助',
    negative: '本次生成没有帮助',
  },
  fix: {
    target: '本次修复',
    positive: '本次修复有帮助',
    negative: '本次修复没有帮助',
  },
};

function ThumbIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={direction === 'down' ? 'size-4 rotate-180' : 'size-4'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v11H4.8A1.8 1.8 0 0 1 3 19.2v-7.4A1.8 1.8 0 0 1 4.8 10H7Z" />
      <path d="M7 19.5h9.4a2 2 0 0 0 1.9-1.4l2.4-7.2A2.2 2.2 0 0 0 18.6 8H14l.7-3.1A2.4 2.4 0 0 0 12.4 2L7 10v9.5Z" />
    </svg>
  );
}

export function ResponseFeedback({ requestId, route }: Props) {
  const [selection, setSelection] =
    useState<ResponseFeedbackSelection>({ rating: null });
  const [badReason, setBadReason] =
    useState<ResponseFeedbackReason | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef(requestId);
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(saving);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const reasonGroupName = useId();
  const actionLabels = ACTION_LABELS[route];
  const reasonOptions = responseFeedbackReasonOptions(route);
  savingRef.current = saving;

  useEffect(() => {
    activeRequestId.current = requestId;
    setSelection({ rating: null });
    setBadReason(null);
    setDialogOpen(false);
    setSaving(false);
    setError(null);
  }, [requestId]);

  useEffect(() => {
    if (!dialogOpen) return;
    function containDialogFocus(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (!savingRef.current) setDialogOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', containDialogFocus);
    return () => window.removeEventListener('keydown', containDialogFocus);
  }, [dialogOpen]);

  useEffect(() => {
    if (dialogOpen) return;
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  }, [dialogOpen]);

  if (requestId === null) return null;

  async function save(next: ResponseFeedbackSelection): Promise<boolean> {
    if (saving || requestId === null) return false;
    const targetRequestId = requestId;
    setSaving(true);
    setError(null);
    try {
      const saved = await submitResponseFeedback(targetRequestId, next);
      if (activeRequestId.current !== targetRequestId) return false;
      setSelection(saved);
      return true;
    } catch (cause) {
      if (activeRequestId.current === targetRequestId) {
        setError(
          cause instanceof ApiRequestError
            ? cause.code === 'control_state_unavailable'
              ? '反馈暂时无法保存，请稍后再试。'
              : cause.message
            : '反馈暂时无法保存，请稍后再试。',
        );
      }
      return false;
    } finally {
      if (activeRequestId.current === targetRequestId) setSaving(false);
    }
  }

  function toggleGood(): void {
    void save(
      selection.rating === 'good' ? { rating: null } : { rating: 'good' },
    );
  }

  function toggleBad(): void {
    if (selection.rating === 'bad') {
      void save({ rating: null });
      return;
    }
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBadReason(null);
    setError(null);
    setDialogOpen(true);
  }

  async function submitBad(): Promise<void> {
    if (badReason === null) return;
    if (await save({ rating: 'bad', reason: badReason })) {
      setDialogOpen(false);
    }
  }

  const buttonClass = (selected: boolean) =>
    `inline-flex size-8 items-center justify-center rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50 ${
      selected
        ? 'border-white/15 bg-white/15 text-fg'
        : 'border-transparent text-muted hover:bg-white/10 hover:text-fg'
    }`;
  const showGood = selection.rating !== 'bad';
  const showBad = selection.rating !== 'good';

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={`评价${actionLabels.target}`}
      >
        {showGood && (
          <Tooltip content={actionLabels.positive} placement="top" describeChild>
            <button
              type="button"
              aria-label={actionLabels.positive}
              aria-pressed={selection.rating === 'good'}
              disabled={saving}
              onClick={toggleGood}
              className={buttonClass(selection.rating === 'good')}
            >
              <ThumbIcon direction="up" />
            </button>
          </Tooltip>
        )}
        {showBad && (
          <Tooltip content={actionLabels.negative} placement="top" describeChild>
            <button
              type="button"
              aria-label={actionLabels.negative}
              aria-pressed={selection.rating === 'bad'}
              disabled={saving}
              onClick={toggleBad}
              className={buttonClass(selection.rating === 'bad')}
            >
              <ThumbIcon direction="down" />
            </button>
          </Tooltip>
        )}
      </div>

      {!dialogOpen && error && (
        <p className="mt-2 text-xs text-err" role="alert">
          {error}
        </p>
      )}

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setDialogOpen(false);
            }
          }}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            aria-describedby={dialogDescriptionId}
            className="w-full max-w-xl rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-4">
              <h2
                id={dialogTitleId}
                className="font-mono text-base font-semibold text-fg"
              >
                反馈原因
              </h2>
              <button
                type="button"
                aria-label="关闭反馈原因"
                disabled={saving}
                onClick={() => setDialogOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-white/10 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <p id={dialogDescriptionId} className="mt-2 text-sm text-muted">
              请选择{actionLabels.target}最主要的问题。只保存所选原因，不保存问题、YAML 或回答内容。
            </p>

            <fieldset className="mt-5">
              <legend className="sr-only">{actionLabels.target}的主要问题</legend>
              <div className="flex flex-wrap gap-2.5">
                {reasonOptions.map((option, index) => {
                  const selected = badReason === option.reason;
                  return (
                    <label
                      key={option.reason}
                      className={`cursor-pointer rounded-full border px-4 py-2 text-sm transition focus-within:outline-none focus-within:ring-2 focus-within:ring-brand/35 ${
                        saving ? 'cursor-default opacity-50' : ''
                      } ${
                        selected
                          ? 'border-brand/60 bg-brand/15 text-brand'
                          : 'border-line text-fg/85 hover:border-brand/40 hover:text-brand'
                      }`}
                    >
                      <input
                        type="radio"
                        name={reasonGroupName}
                        value={option.reason}
                        checked={selected}
                        disabled={saving}
                        autoFocus={index === 0}
                        onChange={() => setBadReason(option.reason)}
                        className="sr-only"
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {error && (
              <p className="mt-4 text-sm text-err" role="alert">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => setDialogOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-sm text-muted transition hover:text-fg disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={badReason === null || saving}
                onClick={() => void submitBad()}
                className="rounded-lg border border-brand/50 bg-brand/15 px-4 py-2 text-sm text-brand transition hover:bg-brand/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                提交
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

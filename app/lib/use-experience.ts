'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExperienceResponse } from '@/server/experience-control';
import { ApiRequestError, getExperience } from './api';

const REFRESH_MS = 60_000;

export function useExperience() {
  const [experience, setExperience] = useState<ExperienceResponse | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const lastUpdated = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current !== null) return inFlight.current;
    const request = getExperience()
      .then((next) => {
        setExperience(next);
        setErrorCode(null);
        lastUpdated.current = Date.now();
      })
      .catch((error: unknown) => {
        setErrorCode(
          error instanceof ApiRequestError
            ? error.code
            : 'control_state_unavailable',
        );
        lastUpdated.current = Date.now();
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => {
      if (Date.now() - lastUpdated.current >= REFRESH_MS) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { experience, errorCode, refresh };
}

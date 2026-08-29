'use client';

import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
} from 'react';
import { ToastRegion } from '@/components/dashboard/shell/toast/ToastRegion';

/**
 * `success` and `error` are the two arms every blocking action owes the owner —
 * the failure arm is the one that gets skipped, so it is not optional here.
 * `info` carries a neutral fact the owner did not ask for (a background job
 * finished), never a status the data can already show.
 */
export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone: ToastTone;
  /** One short clause. The owner reads this and nothing else. */
  title: string;
  /** Optional second line: what happens next, or what to try. */
  body?: string;
}

export interface Toast extends ToastInput {
  id: string;
}

/** An error stays twice as long: it usually asks the owner to do something. */
const DISMISS_MS: Record<ToastTone, number> = {
  success: 5_000,
  info: 5_000,
  error: 10_000,
};

interface ToastApi {
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {}, dismiss: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { ...input, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS[input.tone]),
      );
    },
    [dismiss],
  );

  // A route change or a sign-out unmounts the provider while timers are still
  // pending; without this the callbacks fire against a dead setState. The map is
  // captured in the effect body, not the cleanup, because the ref object is
  // stable but reading `.current` at teardown time is not guaranteed to be.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [dismiss, toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Raise a toast from anywhere under the authenticated layout.
 *
 * Outside the provider this is a no-op rather than a throw: a toast is
 * feedback about work that already happened, and losing the confirmation must
 * never turn a completed action into a crash.
 */
export function useToast(): ToastApi {
  return use(ToastContext);
}

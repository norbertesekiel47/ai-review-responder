// src/components/auth/auth-island/Tabs.tsx
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { pathForMode, type AuthMode } from '@/components/auth/shared/pathForMode';
import { PREFILL_EMAIL_KEY } from '@/components/auth/shared/prefillEmail';

export interface TabsProps {
  mode: AuthMode;
  onChange?: () => void;
}

// These are NOT ARIA tabs: each control navigates to a separate route (/login,
// /signup) rather than swapping a tabpanel in place, so the WAI-ARIA tab pattern
// (tabpanel, aria-controls, roving arrow keys) would lie to assistive tech. They
// are presented as plain navigation buttons with aria-current marking the active
// page. The sliding pill is purely decorative.
export function Tabs({ mode, onChange }: TabsProps) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ left: 4, width: 0 });

  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const recompute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const active = wrap.querySelector<HTMLElement>('.rw-tab.is-active');
      if (!active) return;
      const r = active.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      setPill({ left: r.left - w.left, width: r.width });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [mode]);

  function go(next: AuthMode) {
    if (next === mode) return;
    // Preserve a typed email across the login↔signup switch via sessionStorage
    // (LoginForm and SignupForm both read PREFILL_EMAIL_KEY on mount) so it
    // never rides in the URL/history. Read the live input rather than threading
    // form state up through AuthIslandClient.
    if (typeof document !== 'undefined' && typeof sessionStorage !== 'undefined') {
      const emailInput = document.getElementById('email') as HTMLInputElement | null;
      const typed = emailInput?.value.trim();
      if (typed) {
        sessionStorage.setItem(PREFILL_EMAIL_KEY, typed.toLowerCase());
      }
    }
    onChange?.();
    router.replace(pathForMode(next));
  }

  return (
    <nav className="rw-tabs" ref={wrapRef} aria-label="Sign in or create an account">
      <div className="rw-tab-pill" style={{ left: pill.left, width: pill.width }} aria-hidden="true" />
      <button
        type="button"
        aria-current={mode === 'login' ? 'page' : undefined}
        className={`rw-tab ${mode === 'login' ? 'is-active' : ''}`}
        onClick={() => go('login')}
      >
        Sign in
      </button>
      <button
        type="button"
        aria-current={mode === 'signup' ? 'page' : undefined}
        className={`rw-tab ${mode === 'signup' ? 'is-active' : ''}`}
        onClick={() => go('signup')}
      >
        Create account
      </button>
    </nav>
  );
}

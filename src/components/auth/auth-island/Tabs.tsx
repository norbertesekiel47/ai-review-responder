// src/components/auth/auth-island/Tabs.tsx
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { pathForMode, type AuthMode } from '@/components/auth/shared/pathForMode';

export interface TabsProps {
  mode: AuthMode;
  onChange?: () => void;
}

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
    onChange?.();
    router.replace(pathForMode(next));
  }

  return (
    <div className="rw-tabs" ref={wrapRef} role="tablist" aria-label="Authentication mode">
      <div className="rw-tab-pill" style={{ left: pill.left, width: pill.width }} aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'login'}
        className={`rw-tab ${mode === 'login' ? 'is-active' : ''}`}
        onClick={() => go('login')}
      >
        Sign in
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'signup'}
        className={`rw-tab ${mode === 'signup' ? 'is-active' : ''}`}
        onClick={() => go('signup')}
      >
        Create account
      </button>
    </div>
  );
}

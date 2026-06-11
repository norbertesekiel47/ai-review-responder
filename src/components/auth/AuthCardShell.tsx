'use client';

import type { ReactNode } from 'react';
import { LazyMotion, m, domAnimation, useReducedMotion } from 'motion/react';

/** One owner for auth-card field styling. text-base = 16px (iOS zoom rule). */
export const authFieldClass =
  'w-full px-4 py-3 border border-[#2a2a2a]/15 rounded-xl text-base text-[#2a2a2a] placeholder:text-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE] focus:border-transparent';

export const authLabelClass = 'block text-sm font-medium text-[#2a2a2a] mb-1';

export const authPrimaryButtonClass =
  'w-full bg-[#97B3AE] text-white font-medium py-3 rounded-full hover:bg-[#86a39e] disabled:opacity-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#97B3AE]';

interface AuthCardShellProps {
  children: ReactNode;
  /** Island width — 'sm' for single-field forms, 'md' (default) otherwise. */
  width?: 'sm' | 'md';
}

/**
 * Sage page + centered white island card for single-card owner auth flows
 * (forgot/reset/check-email/finish-signup). Mirrors the MFA island
 * (MfaChallengeForm). No overflow:hidden (iOS Safari rule); motion respects
 * prefers-reduced-motion. Admin portals must NOT use this shell — they keep
 * the utilitarian internal style.
 */
export function AuthCardShell({ children, width = 'md' }: AuthCardShellProps) {
  const reduce = useReducedMotion();
  return (
    <LazyMotion features={domAnimation}>
      <main className="min-h-screen bg-[#D2E0D3] relative flex items-center justify-center px-4 py-16">
        <m.div
          className={`relative z-10 w-full ${width === 'sm' ? 'max-w-sm' : 'max-w-md'} bg-white rounded-[3rem] shadow-2xl p-8 sm:p-10`}
          initial={reduce ? false : { opacity: 0, y: 24, scale: 0.97 }}
          animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <div className="flex items-center gap-2 mb-8">
            <div aria-hidden="true" className="size-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
            <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
          </div>
          {children}
        </m.div>
      </main>
    </LazyMotion>
  );
}

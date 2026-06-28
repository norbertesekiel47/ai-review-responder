'use client';

import type { ReactNode } from 'react';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** One owner for auth-card field styling. text-base = 16px (iOS zoom rule). */
export const authFieldClass =
  'w-full px-4 py-3 border border-rw-ink/15 rounded-xl text-base text-rw-ink placeholder:text-rw-ink-soft/60 focus:outline-none focus:ring-2 focus:ring-rw-teal focus:border-transparent';

export const authLabelClass = 'block text-sm font-medium text-rw-ink mb-1';

// Fill uses the accessible teal token (--rw-teal-strong #557069, ADR 0004) so
// white button text clears WCAG AA — the old #97B3AE on white was 2.24:1 (fail).
// Hover darkens further; focus-visible ring keeps the same accessible token.
export const authPrimaryButtonClass =
  'w-full bg-rw-teal-strong text-white font-medium py-3 rounded-full hover:bg-rw-teal-strong-hover-deep disabled:opacity-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rw-teal-strong';

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
  const reduce = usePrefersReducedMotion();
  return (
    <LazyMotion features={domAnimation}>
      <main id="main-content" className="min-h-screen bg-rw-sage relative flex items-center justify-center px-4 py-16">
        <m.div
          className={`relative z-10 w-full ${width === 'sm' ? 'max-w-sm' : 'max-w-md'} bg-white rounded-[3rem] shadow-2xl p-8 sm:p-10`}
          initial={reduce ? false : { opacity: 0, y: 24, scale: 0.97 }}
          animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <div className="flex items-center gap-2 mb-8">
            <div aria-hidden="true" className="size-8 rounded-full bg-gradient-to-br from-rw-teal to-rw-teal/80" />
            <span className="text-sm tracking-wider uppercase text-rw-teal-strong">RepWorth</span>
          </div>
          {children}
        </m.div>
      </main>
    </LazyMotion>
  );
}

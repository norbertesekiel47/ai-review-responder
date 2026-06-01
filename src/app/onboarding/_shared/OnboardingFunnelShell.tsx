'use client';

import type { ReactNode } from 'react';
import { LazyMotion, domAnimation, m } from 'motion/react';

import { FunnelStepThread, type FunnelStep } from './FunnelStepThread';

interface OnboardingFunnelShellProps {
  /** Current top-level milestone. Drives the step thread. */
  step?: FunnelStep;
  /** Default true; only the legacy (admin-created) wizard passes false. */
  showThread?: boolean;
  /** '2xl' for forms (default); '6xl' for the plan picker grid. */
  maxWidth?: '2xl' | '6xl';
  children: ReactNode;
}

const MAX_WIDTH: Record<'2xl' | '6xl', string> = {
  '2xl': 'max-w-2xl',
  '6xl': 'max-w-6xl',
};

// Static brand atmosphere — funnel pages are short centered forms that don't
// scroll, so (unlike PageShell) there is no scroll-parallax coupling.
const ATMOSPHERE = [
  { className: 'absolute top-24 left-8 w-56 h-72', dots: 5 },
  { className: 'absolute top-[42%] right-12 w-64 h-56', dots: 4 },
  { className: 'absolute bottom-28 left-[12%] w-52 h-64', dots: 5 },
  { className: 'absolute bottom-12 right-[8%] w-56 h-48', dots: 5 },
];

export function OnboardingFunnelShell({
  step,
  showThread = true,
  maxWidth = '2xl',
  children,
}: OnboardingFunnelShellProps) {
  return (
    <LazyMotion features={domAnimation}>
      <div className="min-h-screen bg-[#D2E0D3] relative">
        <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
          {ATMOSPHERE.map((card) => (
            <div
              key={card.className}
              className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
            >
              <div className="flex gap-1 mb-3">
                {Array.from({ length: card.dots }).map((_, j) => (
                  <div key={j} className="size-4 bg-[#F2C3B9]/60 rounded-full" />
                ))}
              </div>
              <div className="space-y-2">
                <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
                <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
                <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
              </div>
            </div>
          ))}
        </div>

        <div className="relative z-10 min-h-screen py-12 sm:py-20 px-4 flex items-center justify-center">
          <m.div
            className={`w-full ${MAX_WIDTH[maxWidth]} bg-white rounded-[3rem] shadow-2xl`}
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          >
            <nav className="px-6 sm:px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-end">
              <div className="flex items-center gap-2">
                <div className="size-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
                <span className="text-sm tracking-wider uppercase text-[#97B3AE]">
                  RepWorth
                </span>
              </div>
            </nav>

            {showThread && step && (
              <div className="px-4 sm:px-8 pt-6">
                <FunnelStepThread step={step} />
              </div>
            )}

            <div className="px-6 sm:px-10 py-8 sm:py-10">{children}</div>
          </m.div>
        </div>
      </div>
    </LazyMotion>
  );
}

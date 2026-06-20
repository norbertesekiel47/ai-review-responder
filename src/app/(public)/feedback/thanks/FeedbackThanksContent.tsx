'use client';

import Link from 'next/link';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function FeedbackThanksContent() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const entryReveal = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 20 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.6, delay: 0.2 },
      };

  return (
    <LazyMotion features={domAnimation}>
    <PageShell sections={[]} maxWidthClassName="max-w-md">
      <main id="main-content">
      {/* Minimal brand header */}
      <div className="flex items-center justify-center gap-2 px-8 pt-8">
        <div
          className="size-8 rounded-full bg-gradient-to-br from-[#557069] to-[#557069]/85"
          aria-hidden="true"
        />
        <span className="text-sm tracking-wider uppercase text-[#557069]">RepWorth</span>
      </div>

      <m.div className="px-8 pb-12 pt-6 text-center" role="status" {...entryReveal}>
        <div
          className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-[#557069]/15"
          aria-hidden="true"
        >
          <svg className="size-8 text-[#557069]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h1 className="mb-3 text-3xl font-medium text-[#2a2a2a]">Thank you</h1>
        <p className="mb-8 leading-relaxed text-[#6a6a6a]">
          Your feedback has been recorded. It goes straight to the team that builds RepWorth.
        </p>

        <Link
          href="/"
          className="inline-block rounded-full bg-[#557069] px-8 py-4 text-white shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#557069] focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:transform-none motion-reduce:hover:scale-100"
        >
          Back to RepWorth →
        </Link>
      </m.div>
      </main>
    </PageShell>
    </LazyMotion>
  );
}

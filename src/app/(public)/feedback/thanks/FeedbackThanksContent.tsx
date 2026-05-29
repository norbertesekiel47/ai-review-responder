'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';

export function FeedbackThanksContent() {
  return (
    <PageShell sections={[]} maxWidthClassName="max-w-md">
      {/* Minimal brand header */}
      <div className="flex items-center justify-center gap-2 px-8 pt-8">
        <div
          className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80"
          aria-hidden="true"
        />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </div>

      <motion.div
        className="px-8 pb-12 pt-6 text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        <div
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-[#97B3AE]/15"
          aria-hidden="true"
        >
          <svg className="h-8 w-8 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h1 className="mb-3 text-3xl font-medium text-[#2a2a2a]">Thank you</h1>
        <p className="mb-8 leading-relaxed text-[#6a6a6a]">
          Your feedback has been recorded. It goes straight to the team that builds RepWorth.
        </p>

        <Link
          href="/"
          className="inline-block rounded-full bg-[#97B3AE] px-8 py-4 text-white shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
        >
          Back to RepWorth →
        </Link>
      </motion.div>
    </PageShell>
  );
}

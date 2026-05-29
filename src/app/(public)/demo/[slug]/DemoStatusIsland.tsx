'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

type DemoStatusVariant = 'loading' | 'error' | 'expired';

interface DemoStatusIslandProps {
  variant: DemoStatusVariant;
  /** Shown for loading/error; absent for expired (no demo row to name). */
  businessName?: string;
  selfServeEnabled: boolean;
}

const REFRESH_INTERVAL_MS = 5000;

const MESSAGES: Record<'error' | 'expired', { title: string; body: (name?: string) => string }> = {
  error: {
    title: "We couldn't generate this demo",
    body: (name) =>
      `Something went wrong creating the demo${name ? ` for ${name}` : ''}. We'd still love to show you RepWorth.`,
  },
  expired: {
    title: 'This demo link has expired',
    body: () =>
      'Demo links are only active for a short time. Request a fresh look at RepWorth for your business.',
  },
};

export function DemoStatusIsland({ variant, businessName, selfServeEnabled }: DemoStatusIslandProps) {
  const router = useRouter();

  useEffect(() => {
    if (variant !== 'loading') return;
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [variant, router]);

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <div role="status" className="px-8 py-20 md:py-28 flex flex-col items-center text-center">
        {variant === 'loading' ? (
          <LoadingBody businessName={businessName} />
        ) : (
          <MessageBody variant={variant} businessName={businessName} />
        )}
      </div>
    </PageShell>
  );
}

function LoadingBody({ businessName }: { businessName?: string }) {
  return (
    <>
      <div
        aria-hidden="true"
        className="w-12 h-12 rounded-full border-4 border-[#97B3AE]/20 border-t-[#97B3AE] animate-spin mb-6"
      />
      {businessName && (
        <h1 className="text-2xl md:text-3xl font-medium text-[#2a2a2a] mb-2">{businessName}</h1>
      )}
      <p className="text-lg text-[#6a6a6a]">Your demo is being generated…</p>
      <p className="text-sm text-[#97B3AE] italic mt-2">This usually takes about 30–60 seconds.</p>
    </>
  );
}

function MessageBody({ variant, businessName }: { variant: 'error' | 'expired'; businessName?: string }) {
  const { title, body } = MESSAGES[variant];
  return (
    <>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-full bg-[#97B3AE]/15 flex items-center justify-center mb-6"
      >
        <svg className="w-7 h-7 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {variant === 'error' ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          )}
        </svg>
      </div>
      <h1 className="text-2xl md:text-3xl font-medium text-[#2a2a2a] mb-3">{title}</h1>
      <p className="text-lg text-[#6a6a6a] max-w-md mb-8">{body(businessName)}</p>
      <motion.div whileHover={{ scale: 1.05, y: -2 }} whileTap={{ scale: 0.98 }} className="inline-block">
        <Link href="/book-a-demo" className="inline-block px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium">
          Book a demo
        </Link>
      </motion.div>
      <Link href="/" className="text-sm text-[#97B3AE] underline mt-6">
        Back to RepWorth
      </Link>
    </>
  );
}

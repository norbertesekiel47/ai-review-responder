'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LazyMotion, domAnimation, m } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

type DemoStatusVariant = 'loading' | 'error' | 'expired';

interface DemoStatusIslandProps {
  variant: DemoStatusVariant;
  /** Shown for loading/error; absent for expired (no demo row to name). */
  businessName?: string;
  /** Forwarded to SiteNav to show/hide the owner sign-up link. */
  selfServeEnabled: boolean;
}

// Poll the route on a backoff schedule so a stuck demo can't refresh forever.
// 5s base, +20% growth, ±15% jitter, capped at 20s per gap. The schedule is
// drained in ~3.5 min over POLL_ATTEMPTS attempts; after that we surface a
// "taking longer than usual" recovery state instead of polling indefinitely.
const POLL_BASE_MS = 5000;
const POLL_MAX_MS = 20000;
const POLL_GROWTH = 1.2;
const POLL_JITTER = 0.15;
const POLL_ATTEMPTS = 24;

function nextPollDelay(attempt: number): number {
  const grown = Math.min(POLL_BASE_MS * POLL_GROWTH ** attempt, POLL_MAX_MS);
  const jitter = grown * POLL_JITTER * (Math.random() * 2 - 1);
  return Math.round(grown + jitter);
}

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
  return (
    <LazyMotion features={domAnimation}>
      <PageShell sections={[]}>
        <SiteNav selfServeEnabled={selfServeEnabled} />
        <main id="main-content">
          {variant === 'loading' ? (
            <LoadingIsland businessName={businessName} />
          ) : (
            <div className="px-8 py-20 md:py-28 flex flex-col items-center text-center">
              <MessageBody variant={variant} businessName={businessName} />
            </div>
          )}
        </main>
      </PageShell>
    </LazyMotion>
  );
}

function LoadingIsland({ businessName }: { businessName?: string }) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const startedAtRef = useRef(0);

  // Hold router in a ref so the poll schedule runs exactly once on mount.
  // `useRouter()` returns a fresh object each render, so depending on its
  // identity would restart the bounded schedule every elapsed-tick re-render.
  // The ref is synced in an effect (not during render) to satisfy react-hooks/refs.
  const refreshRef = useRef(router.refresh);
  useEffect(() => {
    refreshRef.current = router.refresh;
  }, [router]);

  useEffect(() => {
    startedAtRef.current = Date.now();
    let attempt = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const tick = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);

    const scheduleNext = () => {
      if (attempt >= POLL_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      pollTimer = setTimeout(() => {
        refreshRef.current();
        attempt += 1;
        scheduleNext();
      }, nextPollDelay(attempt));
    };
    scheduleNext();

    return () => {
      clearInterval(tick);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  if (timedOut) {
    return (
      <div className="px-8 py-20 md:py-28 flex flex-col items-center text-center">
        <TimedOutBody businessName={businessName} />
      </div>
    );
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const showElapsed = elapsedSeconds >= 75;

  return (
    <div
      role="status"
      aria-label="Demo generation status"
      className="px-8 py-20 md:py-28 flex flex-col items-center text-center"
    >
      <LoadingBody businessName={businessName} showElapsed={showElapsed} elapsedSeconds={elapsedSeconds} />
    </div>
  );
}

function LoadingBody({
  businessName,
  showElapsed,
  elapsedSeconds,
}: {
  businessName?: string;
  showElapsed: boolean;
  elapsedSeconds: number;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <>
      <div
        aria-hidden="true"
        className={`w-12 h-12 rounded-full border-4 border-rw-teal-strong/20 border-t-rw-teal-strong mb-6 ${
          prefersReducedMotion ? '' : 'animate-spin'
        }`}
      />
      {businessName && (
        <h1 className="text-2xl md:text-3xl font-medium text-rw-ink mb-2">{businessName}</h1>
      )}
      <p className="text-lg text-rw-ink-soft">Your demo is being generated…</p>
      <p className="text-sm text-rw-teal-strong italic mt-2">This usually takes under a minute.</p>
      {showElapsed && (
        <p className="text-sm text-rw-teal-strong mt-1">Still working… {elapsedSeconds}s elapsed.</p>
      )}
    </>
  );
}

function TimedOutBody({ businessName }: { businessName?: string }) {
  const router = useRouter();
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-full bg-rw-teal-strong/15 flex items-center justify-center mb-6"
      >
        <svg className="w-7 h-7 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
          />
        </svg>
      </div>
      <h1 className="text-2xl md:text-3xl font-medium text-rw-ink mb-3">
        This is taking longer than usual
      </h1>
      <p className="text-lg text-rw-ink-soft max-w-md mb-8">
        Your demo{businessName ? ` for ${businessName}` : ''} is still generating. You can keep waiting,
        try again, or book a demo and we&apos;ll walk you through it.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <m.button
          type="button"
          onClick={() => router.refresh()}
          whileHover={prefersReducedMotion ? undefined : { scale: 1.05, y: -2 }}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
          className="inline-block px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg font-medium"
        >
          Try again
        </m.button>
        <Link
          href="/book-a-demo"
          className="inline-block px-8 py-4 border border-rw-teal-strong text-rw-teal-strong rounded-full font-medium"
        >
          Book a demo
        </Link>
      </div>
      <Link href="/" className="text-sm text-rw-teal-strong underline mt-6">
        Back to RepWorth
      </Link>
    </>
  );
}

function MessageBody({ variant, businessName }: { variant: 'error' | 'expired'; businessName?: string }) {
  const router = useRouter();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { title, body } = MESSAGES[variant];
  return (
    <>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-full bg-rw-teal-strong/15 flex items-center justify-center mb-6"
      >
        <svg className="w-7 h-7 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
      <h1 className="text-2xl md:text-3xl font-medium text-rw-ink mb-3">{title}</h1>
      <p className="text-lg text-rw-ink-soft max-w-md mb-8">{body(businessName)}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {variant === 'error' && (
          <m.button
            type="button"
            onClick={() => router.refresh()}
            whileHover={prefersReducedMotion ? undefined : { scale: 1.05, y: -2 }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
            className="inline-block px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg font-medium"
          >
            Try again
          </m.button>
        )}
        <m.div
          whileHover={prefersReducedMotion ? undefined : { scale: 1.05, y: -2 }}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
          className="inline-block"
        >
          <Link
            href="/book-a-demo"
            className={
              variant === 'error'
                ? 'inline-block px-8 py-4 border border-rw-teal-strong text-rw-teal-strong rounded-full font-medium'
                : 'inline-block px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg font-medium'
            }
          >
            Book a demo
          </Link>
        </m.div>
      </div>
      <Link href="/" className="text-sm text-rw-teal-strong underline mt-6">
        Back to RepWorth
      </Link>
    </>
  );
}

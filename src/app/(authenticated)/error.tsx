'use client';

import { useEffect, useRef } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function AuthenticatedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="error-state" role="alert" aria-labelledby="error-state-title">
      <div className="error-state-icon" aria-hidden="true">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 id="error-state-title" className="error-state-title" tabIndex={-1} ref={headingRef}>
        Something went wrong
      </h1>
      <p className="error-state-sub">
        We couldn&apos;t load this page. This one&apos;s on us — try again, or head
        back to your dashboard.
      </p>
      <div className="error-state-actions">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <a className="btn btn-secondary" href="/dashboard">
          Back to dashboard
        </a>
        <a className="btn btn-tertiary" href="mailto:support@repworth.net">
          Contact support
        </a>
      </div>
      {error.digest ? (
        <p className="error-state-ref">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}

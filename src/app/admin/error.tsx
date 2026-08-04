'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import * as Sentry from '@sentry/nextjs';

export default function AdminError({
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
    // Renders inside AdminShellFrame's `flex min-h-screen bg-gray-50` main
    // column: no second `min-h-screen` (it would stack a viewport-height box
    // below the sidebar's own) and no full-viewport centering. The measure
    // mirrors <AdminPage>, since this stands in for a page body.
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div
        className="rounded-md border border-red-300 bg-red-50 px-4 py-10 text-center"
        role="alert"
        aria-labelledby="admin-error-title"
      >
        {/* Palette matches the shared <ErrorState> primitive so a segment-level
            failure and an in-page request failure read as the same thing. */}
        <h1
          id="admin-error-title"
          className="text-2xl font-bold text-red-800"
          tabIndex={-1}
          ref={headingRef}
        >
          Admin page failed to load
        </h1>
        <p className="mt-2 text-sm text-red-700">
          The error has been reported. Try again, or return to the overview.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Try again
          </button>
          <Link
            href="/admin/overview"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Back to overview
          </Link>
        </div>
        {error.digest ? (
          <p className="mt-6 text-xs text-red-700">Reference: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}

'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

const FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <div
          style={{
            minHeight: '100vh',
            background: '#D2E0D3',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            fontFamily: FONT_STACK,
          }}
        >
          <div
            role="alert"
            style={{
              maxWidth: '28rem',
              width: '100%',
              background: '#fff',
              borderRadius: '2rem',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
              padding: '2.5rem',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                marginBottom: '1.5rem',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '9999px',
                  background:
                    'linear-gradient(135deg, #97B3AE, rgba(151, 179, 174, 0.8))',
                  display: 'inline-block',
                }}
              />
              <span
                style={{
                  fontSize: '0.875rem',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#97B3AE',
                }}
              >
                RepWorth
              </span>
            </div>
            <h1
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: '#2a2a2a',
                margin: '0 0 0.75rem',
              }}
            >
              Something went wrong
            </h1>
            <p style={{ color: '#6a6a6a', margin: '0 0 1.5rem', lineHeight: 1.6 }}>
              An unexpected error interrupted RepWorth. Please try again.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: '#97B3AE',
                color: '#fff',
                border: 'none',
                padding: '0.625rem 1.5rem',
                borderRadius: '9999px',
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <p style={{ fontSize: '0.8125rem', color: '#6a6a6a', marginTop: '1.25rem' }}>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- root error boundary renders its own <html> outside the router; a full-document navigation re-bootstraps the crashed app */}
              <a href="/" style={{ color: '#97B3AE' }}>
                Go to RepWorth home
              </a>
              {' · '}
              <a href="mailto:support@repworth.com" style={{ color: '#97B3AE' }}>
                Contact support
              </a>
            </p>
            {error.digest ? (
              <p
                style={{
                  fontSize: '0.75rem',
                  color: '#6B7280',
                  marginTop: '0.75rem',
                  fontFamily: 'monospace',
                }}
              >
                Reference: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import GlobalError from '../global-error';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function makeError(digest?: string): Error & { digest?: string } {
  const error = new Error('catastrophe') as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe('GlobalError', () => {
  // The component returns <html>/<body>; React logs an expected DOM-nesting
  // warning when rendered into the test container. Suppress it so output stays
  // clean — it is not a failure.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    const original = console.error.bind(console);
    consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const first = args[0];
      // Swallow only the expected <html>/<body>-in-<div> nesting warning React
      // logs when this root boundary is rendered into the test container; let
      // any other console.error through so real problems still surface.
      if (
        typeof first === 'string' &&
        /cannot be a child|cannot appear|validateDOMNesting|<html>|<body>/i.test(first)
      ) {
        return;
      }
      original(...(args as Parameters<typeof console.error>));
    });
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders the branded fallback with the RepWorth wordmark and reports to Sentry', () => {
    const error = makeError();
    render(<GlobalError error={error} reset={vi.fn()} />);
    expect(
      screen.getByRole('heading', { name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('calls reset when "Try again" is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<GlobalError error={makeError()} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('links to home and support and shows the reference id', () => {
    render(<GlobalError error={makeError('ref-789')} reset={vi.fn()} />);
    expect(
      screen.getByRole('link', { name: /go to repworth home/i }),
    ).toHaveAttribute('href', '/');
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', 'mailto:support@repworth.com');
    expect(screen.getByText(/reference:\s*ref-789/i)).toBeInTheDocument();
  });
});

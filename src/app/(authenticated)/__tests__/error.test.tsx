// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import AuthenticatedError from '../error';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function makeError(digest?: string): Error & { digest?: string } {
  const error = new Error('boom') as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe('AuthenticatedError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the branded heading inside an alert region', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /something went wrong/i }),
    ).toBeInTheDocument();
  });

  it('calls reset when "Try again" is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<AuthenticatedError error={makeError()} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers back-to-dashboard and contact-support recovery links', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(
      screen.getByRole('link', { name: /back to dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', 'mailto:support@repworth.com');
  });

  it('shows the reference id when the error has a digest', () => {
    render(<AuthenticatedError error={makeError('abc123')} reset={vi.fn()} />);
    expect(screen.getByText(/reference:\s*abc123/i)).toBeInTheDocument();
  });

  it('omits the reference id when there is no digest', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });

  it('reports the error to Sentry on mount', () => {
    const error = makeError();
    render(<AuthenticatedError error={error} reset={vi.fn()} />);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

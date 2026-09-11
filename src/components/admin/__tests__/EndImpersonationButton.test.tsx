// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndImpersonationButton } from '../EndImpersonationButton';

const pushMock = vi.fn();
const refreshMock = vi.fn();
const assignMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

describe('EndImpersonationButton', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    const originalWindow = window;
    vi.stubGlobal('window', new Proxy(originalWindow, {
      get: (target, key) => key === 'location'
        ? { href: 'http://localhost/', origin: 'http://localhost', assign: assignMock }
        : Reflect.get(target, key, target),
    }));
  });

  it('ends the same session and performs one full document navigation to the trusted Admin app', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<EndImpersonationButton adminAppUrl="https://admin.example.com" />);

    await user.click(screen.getByRole('button', { name: /end session/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/impersonation/end',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(assignMock).toHaveBeenCalledExactlyOnceWith('https://admin.example.com');
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('renders API errors without navigating', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_impersonation_session' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    render(<EndImpersonationButton adminAppUrl="https://admin.example.com" />);

    await user.click(screen.getByRole('button', { name: /end session/i }));

    expect(await screen.findByText('invalid_impersonation_session')).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('renders the inverse, compact variant for the banner', () => {
    render(<EndImpersonationButton adminAppUrl="https://admin.example.com" tone="inverse" compact />);
    const button = screen.getByRole('button', { name: /end session/i });
    expect(button.className).toContain('bg-white');
    expect(button.className).toContain('text-xs');
  });
});

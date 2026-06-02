// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { PaymentSuccessContent } from '../PaymentSuccessContent';

// PaymentSuccessContent uses useQuery; in production it inherits the QueryClient
// from the admin layout's AdminProviders. Tests render it in isolation, so they
// must supply their own client. The page server component passes session_id as a
// prop (read from searchParams), so the test passes it directly.
function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  pushMock.mockReset();
});

describe('admin PaymentSuccessPage', () => {
  it('does not navigate after unmount (timers cleaned up)', async () => {
    vi.useFakeTimers();
    // Success response schedules the 3s auto-redirect timer.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ businessId: 'biz_1' }) }),
    );

    const { unmount } = renderWithClient(<PaymentSuccessContent sessionId="cs_test" />);
    // Let the initial fetch resolve and schedule the 3s redirect. act() wraps
    // the timer advance so React flushes the resulting state updates (matches
    // the useEditReplyDraft.test.tsx pattern for timer + async state).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Unmount before the redirect fires.
    unmount();
    // Advance well past the 3s redirect + 2s poll timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(pushMock).not.toHaveBeenCalled();
  });
});

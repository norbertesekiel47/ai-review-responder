// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('session_id=cs_test'),
  useRouter: () => ({ push: pushMock }),
}));

import PaymentSuccessPage from '../page';

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

    const { unmount } = render(<PaymentSuccessPage />);
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

// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PastDueModal } from '../PastDueModal';

describe('PastDueModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the day-5 modal when two or fewer days remain and stores daily dismissal', () => {
    render(
      <PastDueModal
        accountId="acct-1"
        daysRemaining={2}
        isReadOnly={false}
        deadline="2026-05-27T12:00:00.000Z"
      />,
    );

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText(/Payment update needed by May 27, 2026/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss payment reminder' }));

    const key = `rw:past_due_modal:acct-1:${new Date().toISOString().slice(0, 10)}`;
    expect(window.localStorage.getItem(key)).toBe('dismissed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not show before day 5 or after read-only begins', () => {
    const { rerender } = render(
      <PastDueModal
        accountId="acct-1"
        daysRemaining={3}
        isReadOnly={false}
        deadline="2026-05-27T12:00:00.000Z"
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(
      <PastDueModal
        accountId="acct-1"
        daysRemaining={0}
        isReadOnly={true}
        deadline="2026-05-27T12:00:00.000Z"
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

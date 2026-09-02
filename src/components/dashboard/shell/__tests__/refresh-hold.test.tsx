// @vitest-environment jsdom
// UX audit D1: a row mid-edit can pause the shell's auto-refresh.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  RefreshHoldProvider,
  useRefreshHeld,
  useRefreshHold,
} from '@/components/dashboard/shell/refresh-hold';

function Holder({ active }: { active: boolean }) {
  useRefreshHold(active);
  return null;
}

function Indicator() {
  return <output>{useRefreshHeld() ? 'held' : 'free'}</output>;
}

describe('refresh hold', () => {
  it('reads as not held with no provider mounted', () => {
    render(<Indicator />);
    expect(screen.getByRole('status')).toHaveTextContent('free');
  });

  it('is held while any holder is active and releases when the last one stops', () => {
    const { rerender } = render(
      <RefreshHoldProvider>
        <Holder active />
        <Holder active />
        <Indicator />
      </RefreshHoldProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('held');

    rerender(
      <RefreshHoldProvider>
        <Holder active={false} />
        <Holder active />
        <Indicator />
      </RefreshHoldProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('held');

    rerender(
      <RefreshHoldProvider>
        <Holder active={false} />
        <Holder active={false} />
        <Indicator />
      </RefreshHoldProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('free');
  });

  it('releases when a holder unmounts', () => {
    const { rerender } = render(
      <RefreshHoldProvider>
        <Holder active />
        <Indicator />
      </RefreshHoldProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('held');
    rerender(
      <RefreshHoldProvider>
        <Indicator />
      </RefreshHoldProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('free');
  });
});

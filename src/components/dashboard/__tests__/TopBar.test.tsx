// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LocationProvider, type LocationInfo } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

const LOC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

function wrapWithProvider(ui: React.ReactElement) {
  return h(
    LocationProvider,
    {
      locations: [{ id: LOC_A, name: 'Test Biz', displayLabel: null, isPrimary: true }],
      initialScope: LOC_A,
      multiLocationEnabled: false,
      children: ui,
    },
  );
}

describe('TopBar', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps auto-refresh side effects outside the countdown state updater', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/dashboard/shell/TopBar.tsx'), 'utf8');
    const updaterBody =
      source.match(/setSecondsToRefresh\(\(s\) => \s*\{([\s\S]*?)\n\s*\}\);/)?.[1] ?? '';

    expect(updaterBody).not.toContain('doRefresh');
  });

  it('auto refreshes once when the countdown reaches zero', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    render(wrapWithProvider(<TopBar title="Dashboard" showLive refresh={refresh} />));

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText(/Live .* syncs in 1s/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/Live .* syncs in 60s/)).toBeInTheDocument();
  });
});

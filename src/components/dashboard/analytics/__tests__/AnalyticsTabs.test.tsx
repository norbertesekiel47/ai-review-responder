// @vitest-environment jsdom
//
// `AnalyticsTabs` — routed tab bar eval (#1014 T6).
//
// Title 55, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// THE TITLE PINS TWO THINGS AT ONCE, and both are deliberate. `aria-current`
// marks the active route because these are LINKS to two routes, not panels in
// one document — so `role="tab"` would promise arrow-key traversal of content
// that is not there. The precedent is `ReviewsTabs`; `CardViewTabs` is
// explicitly NOT the precedent, and its own comment says so.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';

describe('AnalyticsTabs', () => {
  it('AnalyticsTabs marks the active route with aria-current and uses no tab role', () => {
    render(<AnalyticsTabs active="restraint" />);

    const restraint = screen.getByRole('link', { name: 'Restraint' });
    expect(restraint).toHaveAttribute('aria-current', 'page');
    expect(restraint).toHaveAttribute('href', '/dashboard/analytics/restraint');
    expect(screen.getByRole('link', { name: 'Metrics' })).not.toHaveAttribute('aria-current');
    // Links to two routes, never panels in one document.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tablist')).toHaveLength(0);
  });
});

// #1092. The `tabs--routed` marker is a hand-typed string at three call sites
// and was asserted at only one of them (standards review, 2026-09-03). Dropping
// it here would leave the suite green while restoring the desktop double-nav
// that #1089 forbids.
describe('AnalyticsTabs — the routed breakpoint marker', () => {
  it('carries tabs--routed so the breakpoint rule can reach it', () => {
    const { container } = render(<AnalyticsTabs active="metrics" />);
    expect(container.querySelector('.tabs--routed')).not.toBeNull();
  });
});


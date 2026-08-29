// @vitest-environment jsdom
//
// The Refusal Log eval — analytics tab bar (T0 red-first, T6 green).
//
// The title is VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches it as a fixed string, so do not reword it.
//
// House style copied from
// `src/components/dashboard/reviews/__tests__/ReviewsTabs.test.tsx`: mock
// `next/link` to a plain anchor, query by role, and assert both the `active`
// class and `aria-current="page"` on the current route — and their absence on
// the other. Marking the current route is the whole contract of a route tab bar
// (`docs/design/console/DESIGN.md` § Tabs: a `<nav>` with `aria-current`, never
// `role="tab"`), so one case covers both routes rather than pinning the
// highlight in one direction only.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

describe('AnalyticsTabs', () => {
  it('the analytics tab bar marks the current route', () => {
    const { unmount } = render(<AnalyticsTabs active="metrics" />);

    // Both tabs always render, and each points at its own route.
    expect(linkByName(/metrics/i)).toHaveAttribute('href', '/dashboard/analytics');
    expect(linkByName(/restraint/i)).toHaveAttribute('href', '/dashboard/analytics/restraint');

    // Current route: highlighted AND announced.
    expect(linkByName(/metrics/i)).toHaveClass('active');
    expect(linkByName(/metrics/i)).toHaveAttribute('aria-current', 'page');
    // The other route carries neither.
    expect(linkByName(/restraint/i)).not.toHaveClass('active');
    expect(linkByName(/restraint/i)).not.toHaveAttribute('aria-current');

    unmount();

    // The mark follows the `active` prop, so the Restraint route marks itself.
    render(<AnalyticsTabs active="restraint" />);
    expect(linkByName(/restraint/i)).toHaveClass('active');
    expect(linkByName(/restraint/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/metrics/i)).not.toHaveClass('active');
    expect(linkByName(/metrics/i)).not.toHaveAttribute('aria-current');
  });
});

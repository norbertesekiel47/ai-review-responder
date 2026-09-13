// @vitest-environment jsdom
// The Operator screen's flag gate, both halves in one title: the server page
// throws Next's not-found when OWNER_OPERATOR_ENABLED is off, and neither nav
// renders an entry when the server-authoritative prop is false. They are ONE
// fact — "with the flag off the surface does not exist" — so they are asserted
// together rather than in two files that can drift.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

class NotFoundSignal extends Error {}
// `vi.hoisted` runs before the class declaration is evaluated, so the factory
// closes over a box rather than the binding (the layout-role-gate idiom,
// src/app/(authenticated)/__tests__/layout-role-gate.test.ts:22-33).
const NotFoundSignalRef = { value: NotFoundSignal };

const { notFoundMock, pathnameMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => { throw new NotFoundSignalRef.value(); }),
  pathnameMock: vi.fn<() => string>(() => '/dashboard/operator'),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
  usePathname: () => pathnameMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/contexts/PendingCountContext', () => ({ usePendingCount: () => 0 }));

import OperatorPage from '../page';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';

describe('operator page and nav flag gate', () => {
  it('operator page calls notFound when the flag is off and the nav omits the entry', () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    expect(() => OperatorPage()).toThrow(NotFoundSignal);
    expect(notFoundMock).toHaveBeenCalledTimes(1);

    // The nav learns the same fact from the server-authoritative prop, never
    // from a NEXT_PUBLIC companion (invariant #13).
    render(<MobileTabBar solicitationEnabled={false} operatorEnabled={false} />);
    expect(screen.queryByRole('link', { name: /^Operator$/i })).not.toBeInTheDocument();

    // …and with the flag on, the page renders instead of throwing.
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    notFoundMock.mockClear();
    expect(() => OperatorPage()).not.toThrow();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

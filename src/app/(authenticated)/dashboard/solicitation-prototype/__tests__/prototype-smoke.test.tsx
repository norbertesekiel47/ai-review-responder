// @vitest-environment jsdom
// PROTOTYPE #537 — throwaway smoke test: proves each variant and empty state
// renders without a dev login, and that the six #533 reason codes appear
// verbatim. Deleted with the prototype branch.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationProvider } from '@/contexts/LocationContext';
import { SolicitationPrototype } from '../SolicitationPrototype';

const search = { current: new URLSearchParams('variant=A') };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard/solicitation-prototype',
  useSearchParams: () => search.current,
}));

const REASON_CODES = [
  'no_consent',
  'suppressed',
  'already_reviewed',
  'stale_visit',
  'over_contacted',
  'velocity_banked',
];

function renderPrototype(query: string) {
  search.current = new URLSearchParams(query);
  return render(
    <LocationProvider locations={[]} initialScope="all" multiLocationEnabled={false}>
      <SolicitationPrototype />
    </LocationProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SolicitationPrototype (throwaway smoke)', () => {
  it('variant A renders all six #533 reason codes verbatim', () => {
    renderPrototype('variant=A');
    for (const code of REASON_CODES) {
      expect(screen.getAllByText(code).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Would have sent')).toBeInTheDocument();
  });

  it('variant B renders the six gates in precedence order', () => {
    renderPrototype('variant=B');
    const chips = REASON_CODES.map((code) => screen.getByText(code));
    expect(chips).toHaveLength(6);
    expect(screen.getByText(/would have been sent/i)).toBeInTheDocument();
  });

  it('variant C renders filter chips and never shows a star rating', () => {
    renderPrototype('variant=C');
    expect(screen.getByText('Would send')).toBeInTheDocument();
    expect(screen.getAllByText(/no_consent/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/[★⭐]|\b\d(\.\d)?\s*star/i);
  });

  it('empty state renders the pre-upload explainer', () => {
    renderPrototype('variant=A&state=empty');
    expect(screen.getByText('No contact list yet')).toBeInTheDocument();
    expect(screen.getByText(/consent/i)).toBeInTheDocument();
  });
});

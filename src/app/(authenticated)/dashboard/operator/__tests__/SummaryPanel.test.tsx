// @vitest-environment jsdom
// The summary panel's three blocks and the connect call to action.
//
// It renders what `getConversationForOwner` returned and nothing else — no
// dashboard DTO, no second read, no recomputed number (architecture pass
// H1-D). Every assertion here is therefore a passthrough assertion.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryPanel } from '../SummaryPanel';

const SUMMARY = {
  pending: { pendingCount: 3, draftsWaiting: 5 },
  recent: { posted7d: 9, reportingPeriodDays: 7 },
  rules: {
    threshold: null,
    vetoWindowMinutes: 15,
    dailyCap: 5,
    locationOverrideExists: false,
  },
  facts: {
    tone: 'warm and brief',
    productsServices: null,
    avoidFacts: [],
    highlightFacts: [],
    sampleResponses: [],
    updatedAt: '2026-09-12 09:00:00.111111+00',
  },
  pendingProposals: [],
  connectionStatus: 'active' as const,
  asOf: '2026-09-12T10:00:00.000Z',
};

// Test fixture narrowing. `@typescript-eslint/no-explicit-any` is already off
// for tests here, so a disable directive on this line would itself be unused.
const asSummary = (value: Record<string, unknown>) => value as any;

describe('SummaryPanel', () => {
  it('summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing', () => {
    const connected = render(<SummaryPanel summary={asSummary(SUMMARY)} hint={null} />);

    // Waiting for you.
    expect(screen.getByText(/waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Recently completed, with its reporting period stated rather than implied.
    expect(screen.getByText(/recently completed/i)).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/last 7 days/i)).toBeInTheDocument();
    // Current operating rules.
    expect(screen.getByText(/current operating rules/i)).toBeInTheDocument();
    expect(screen.getByText(/15 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/5 a day/i)).toBeInTheDocument();

    // THE AS-OF STAMP: a live number and the instant it was read must not be
    // able to disagree, so the panel prints the server's own `asOf`.
    const stamps = screen.getAllByText(/as of/i);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    for (const stamp of stamps) {
      expect(stamp.querySelector('time')).toHaveAttribute('datetime', SUMMARY.asOf);
    }

    // Connected: no call to action.
    expect(screen.queryByRole('link', { name: /connect google/i })).not.toBeInTheDocument();
    connected.unmount();

    // NOT connected, in all three non-active shapes.
    for (const status of ['pending', 'disconnected', null]) {
      const { unmount } = render(
        <SummaryPanel summary={asSummary({ ...SUMMARY, connectionStatus: status })} hint={null} />,
      );
      const cta = screen.getByRole('link', { name: /connect google/i });
      expect(cta).toHaveAttribute('href', '/dashboard/connect');
      unmount();
    }

    // No summary and a hint: the chooser's sentence stands in for the blocks.
    render(<SummaryPanel summary={null} hint="Pick one location to talk about." />);
    expect(screen.getByText('Pick one location to talk about.')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for you/i)).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
//
// Contract tests for the built-batch screen (#544 Task 2). Three of these
// titles are contract items greped verbatim by CI:
//   · renders the six withhold reason codes verbatim
//   · renders no star rating anywhere on the batch screen
//   · renders suppressed as an explicit zero-count group
//
// The star sweep is a NEGATIVE SWEEP over the whole rendered tree (ported from
// the #537 prototype smoke test), not a per-element check: ADR 0012 forbids a
// rating, a sentiment field or a predicted-sentiment signal anywhere on this
// surface, so the assertion has to be able to fail on markup nobody targeted.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VERTICALS, WITHHOLD_REASONS } from '@/lib/solicitation/restraint-policy';
import type { AskRow, BatchView, WithholdGroup } from '@/lib/solicitation/batch-view';
import { BatchReport } from '../BatchReport';

type BuiltBatch = Extract<BatchView, { state: 'built' }>;

const NOW = new Date('2026-07-25T12:00:00Z');

function askRow(index: number, evidence: AskRow['evidence']): AskRow {
  return {
    askId: `ask-${index}`,
    contactId: `contact-${index}`,
    contactName: `Contact ${index}`,
    decidedAt: '2026-07-22 10:00:00+00',
    evidence,
  };
}

function envelope(index: number) {
  return {
    contact_id: `contact-${index}`,
    policy_version: 'restraint_v_watch_2026-07-23.1',
    decided_at: '2026-07-22T10:00:00Z',
  } as const;
}

/** One sample row per reason, with that reason's real evidence shape. */
function sampleFor(reason: (typeof WITHHOLD_REASONS)[number], index: number): AskRow {
  const base = { ...envelope(index), decision: 'withhold' } as const;
  switch (reason) {
    case 'no_consent':
      return askRow(index, { ...base, reason, upload_id: 'upload-9' });
    case 'suppressed':
      return askRow(index, {
        ...base,
        reason,
        suppression_source: 'owner',
        suppressed_at: '2026-07-02T09:00:00Z',
      });
    case 'already_reviewed':
      return askRow(index, {
        ...base,
        reason,
        review_id: 'rev-abc-123',
        review_date: '2026-07-11',
      });
    case 'stale_visit':
      return askRow(index, {
        ...base,
        reason,
        last_visit_date: '2026-06-12',
        days_since_visit: 43,
        vertical: 'personal_care',
        matched_keyword: 'salon',
        freshness_window_days: 21,
      });
    case 'over_contacted':
      return askRow(index, {
        ...base,
        reason,
        prior_batch_id: 'batch-prior',
        prior_decision_at: '2026-07-08T10:00:00Z',
        min_gap_days: 30,
      });
    case 'velocity_banked':
      return askRow(index, {
        ...base,
        reason,
        batch_cap: 25,
        eligible_count: 29,
        ordering_basis: { last_visit_date: '2026-07-14', contact_id: `contact-${index}` },
      });
  }
}

/** Every reason present with one evidence row, zero-filled where asked. */
function groups(overrides: Partial<Record<(typeof WITHHOLD_REASONS)[number], number>> = {}): WithholdGroup[] {
  return WITHHOLD_REASONS.map((reason, index) => {
    const total = overrides[reason] ?? 1;
    return {
      reason,
      total,
      sample: total === 0 ? [] : [sampleFor(reason, index)],
    };
  });
}

function builtBatch(overrides: Partial<BuiltBatch> = {}): BuiltBatch {
  return {
    state: 'built',
    batchId: 'batch-1',
    builtAt: '2026-07-22 12:00:00+00',
    contactsOnFile: 1240,
    evaluated: 46,
    queued: 25,
    held: 21,
    groups: groups(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BatchReport (built batch)', () => {
  it('renders the six withhold reason codes verbatim', () => {
    render(<BatchReport view={builtBatch()} />);
    for (const code of WITHHOLD_REASONS) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
  });

  it('renders no star rating anywhere on the batch screen', () => {
    const { container } = render(<BatchReport view={builtBatch()} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d(\.\d)?\s*star/i);
    expect(text).not.toMatch(/★/);
    expect(container.querySelectorAll('[aria-label*="star" i]')).toHaveLength(0);
    // already_reviewed evidence must show the DATE and never the review id.
    expect(text).not.toContain('rev-abc-123');
  });

  it('renders suppressed as an explicit zero-count group', () => {
    render(<BatchReport view={builtBatch({ groups: groups({ suppressed: 0 }) })} />);
    const group = screen.getByRole('region', { name: /suppressed/i });
    expect(within(group).getByText('suppressed')).toBeInTheDocument();
    expect(within(group).getByText(/nobody this batch/i)).toBeInTheDocument();
  });

  it('renders the funnel as an ordered list, with contacts on file outside it', () => {
    const { container } = render(<BatchReport view={builtBatch()} />);

    const funnel = screen.getByRole('list', { name: /batch funnel/i });
    expect(funnel.tagName).toBe('OL');
    const rungs = within(funnel).getAllByRole('listitem');
    expect(rungs).toHaveLength(3);
    expect(within(funnel).getByText('46')).toBeInTheDocument();
    expect(within(funnel).getByText('25')).toBeInTheDocument();
    expect(within(funnel).getByText('21')).toBeInTheDocument();

    // contactsOnFile has a different denominator than the batch rungs — it is a
    // present-tense fact, never the funnel's first rung.
    const contactsFact = screen.getByText(
      new RegExp(`${(1240).toLocaleString()} contacts on file`),
    );
    expect(funnel.contains(contactsFact)).toBe(false);
    expect(container.textContent).toContain(`${(1240).toLocaleString()} contacts on file`);
  });

  it('makes "nothing was sent" unmissable with a watch-mode pill', () => {
    render(<BatchReport view={builtBatch()} />);
    expect(screen.getByText(/watch-mode/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing sent/i)).toBeInTheDocument();
  });

  it('renders the build time as relative text with no staleness warning', () => {
    render(<BatchReport view={builtBatch({ builtAt: '2026-07-22 12:00:00+00' })} />);
    expect(screen.getByText(/built 3 days ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/expired|out of date|stale batch/i)).toBeNull();
  });

  it('gives every reason group a heading and its exact total', () => {
    render(<BatchReport view={builtBatch({ groups: groups({ stale_visit: 6 }) })} />);
    for (const code of WITHHOLD_REASONS) {
      expect(screen.getByRole('heading', { name: new RegExp(code) })).toBeInTheDocument();
    }
    const stale = screen.getByRole('region', { name: /stale_visit/i });
    expect(within(stale).getByText(/^6\b/)).toBeInTheDocument();
  });

  it('caps evidence rows and says how many more there are', () => {
    const sample = Array.from({ length: 10 }, (_, i) => sampleFor('stale_visit', i));
    const view = builtBatch({
      groups: WITHHOLD_REASONS.map((reason) =>
        reason === 'stale_visit'
          ? { reason, total: 34, sample }
          : { reason, total: 0, sample: [] },
      ),
    });
    render(<BatchReport view={view} />);
    const stale = screen.getByRole('region', { name: /stale_visit/i });
    expect(within(stale).getAllByRole('listitem')).toHaveLength(10);
    expect(within(stale).getByText(/…and 24 more/)).toBeInTheDocument();
  });

  it('describes velocity_banked as banked rather than refused, in text not colour', () => {
    render(<BatchReport view={builtBatch({ groups: groups({ velocity_banked: 4 }) })} />);
    const banked = screen.getByRole('region', { name: /velocity_banked/i });
    // The count carries the word, so "banked" is never encoded by colour alone.
    expect(within(banked).getByText('4 banked')).toBeInTheDocument();
    expect(within(banked).getByText(/first in line for the next batch/i)).toBeInTheDocument();
    expect(within(banked).queryByText(/rejected|refused|blocked/i)).toBeNull();
  });

  it('points validation rejections at the upload report, not the withheld ledger', () => {
    const { container } = render(<BatchReport view={builtBatch()} />);
    const link = screen.getByRole('link', { name: /upload report/i });
    expect(link).toHaveAttribute('href', '/dashboard/requests/contacts');
    expect(container.textContent).toContain('are listed in the upload report');
  });

  it('never renders a raw snake_case vertical in owner-facing prose', () => {
    // The withhold codes are deliberately verbatim; `Vertical` is not — it is an
    // internal classification, so "for personal_care." / "for other." must never
    // reach the owner. The sweep is scoped to the evidence line so the verbatim
    // reason chips do not mask a regression.
    for (const vertical of VERTICALS) {
      const row = askRow(0, {
        ...envelope(0),
        decision: 'withhold',
        reason: 'stale_visit',
        last_visit_date: '2026-06-12',
        days_since_visit: 43,
        vertical,
        matched_keyword: null,
        freshness_window_days: 21,
      });
      const view = builtBatch({
        groups: WITHHOLD_REASONS.map((reason) =>
          reason === 'stale_visit'
            ? { reason, total: 1, sample: [row] }
            : { reason, total: 0, sample: [] },
        ),
      });
      const { container, unmount } = render(<BatchReport view={view} />);
      const evidence = container.querySelector('.rq-row-evidence')?.textContent ?? '';

      expect(evidence).toMatch(/past the 21-day window for /);
      expect(evidence).not.toMatch(/[a-z]+_[a-z]+/);
      unmount();
    }
  });

  it('renders a zero-queued funnel for a built batch with no asks', () => {
    render(
      <BatchReport
        view={builtBatch({
          evaluated: 0,
          queued: 0,
          held: 0,
          groups: groups({
            no_consent: 0,
            suppressed: 0,
            already_reviewed: 0,
            stale_visit: 0,
            over_contacted: 0,
            velocity_banked: 0,
          }),
        })}
      />,
    );
    const funnel = screen.getByRole('list', { name: /batch funnel/i });
    expect(within(funnel).getAllByText('0')).toHaveLength(3);
    expect(screen.getAllByText(/nobody this batch/i)).toHaveLength(6);
  });
});

describe('BatchReport styles', () => {
  it('guards every animation behind prefers-reduced-motion', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/app/(authenticated)/dashboard/requests/requests.css'),
      'utf-8',
    );
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // The override must cover the whole surface wrapper, not just .rq-stack:
    // the loading, choose-a-location and failure cards render .section-enter
    // with no .rq-stack ancestor.
    expect(css).toMatch(/\.rq-surface \.section-enter \{ animation: none; \}/);
    expect(css).not.toMatch(/\.rq-stack \.section-enter/);
  });

  it('gives focusable targets a visible focus ring and a 44px minimum', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/app/(authenticated)/dashboard/requests/requests.css'),
      'utf-8',
    );
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/min-height: 44px/);
  });
});

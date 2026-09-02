// @vitest-environment jsdom
//
// UX audit D16 + D17 on the Reviews list route: the streaming fallback names
// the destination the way its tab does, and the "Showing: <location>" line is a
// statement with a visible hint — not a dead chevron with a tooltip.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PastRepliesLoading from '../loading';

const PAGE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/(authenticated)/dashboard/reviews/history/page.tsx'),
  'utf-8',
);

describe('Reviews list — one name for one destination (D16)', () => {
  it('the loading fallback is labelled "Loading all reviews", matching the All Reviews tab', () => {
    render(<PastRepliesLoading />);
    expect(screen.getByLabelText('Loading all reviews')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByLabelText(/past replies/i)).toBeNull();
  });
});

describe('Reviews list — the Showing line (D17)', () => {
  it('renders no chevron and no tooltip; the switch hint is visible text', () => {
    expect(PAGE_SOURCE).not.toContain('chevron-down');
    expect(PAGE_SOURCE).not.toMatch(/<span className="reviews-showing" title=/);
    expect(PAGE_SOURCE).toContain('className="reviews-showing-hint"');
    expect(PAGE_SOURCE).toContain('Switch locations from the location picker.');
  });
});

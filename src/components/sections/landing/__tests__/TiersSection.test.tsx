// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TiersSection } from '../tiers/TiersSection';
import { MOVEMENT_NOTE, PRICING_LINK_LABEL } from '../tiers/tiers-copy';

// The tiers section is the landing page's door to /pricing (the nav is
// absolute over the hero, not sticky — tiers-copy.ts, PRICING_LINK_LABEL).
// These tests pin that door: where it sits, what it says, and that it carries
// the landing focus ring like every other landing control.

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));

const TIERS_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/sections/landing/tiers/tiers.css'),
  'utf-8',
);

describe('TiersSection', () => {
  it('renders the two operable mode buttons with Copilot pressed by default', () => {
    render(<TiersSection />);
    expect(screen.getByRole('button', { name: 'Copilot' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Autopilot' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers "See plans and pricing" to /pricing after the movement note', () => {
    render(<TiersSection />);
    const door = screen.getByRole('link', { name: PRICING_LINK_LABEL });
    expect(door).toHaveAttribute('href', '/pricing');
    expect(door).toHaveClass('rw-lp-tiers-pricing-link');
    expect(PRICING_LINK_LABEL).toBe('See plans and pricing');

    // Directly after the note, inside the same staged beat.
    const note = screen.getByText((_, el) => el?.textContent?.startsWith(MOVEMENT_NOTE) === true && el.tagName === 'P');
    expect(note.nextElementSibling).toContainElement(door);
  });

  it('gives the pricing door the landing focus ring (gold, 3px offset)', () => {
    expect(TIERS_CSS).toMatch(
      /\.rw-lp-tiers-pricing-link:focus-visible \{[\s\S]{0,120}?outline: 2px solid var\(--rw-lp-accent\);[\s\S]{0,60}?outline-offset: 3px;/,
    );
  });
});

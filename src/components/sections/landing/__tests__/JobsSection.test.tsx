// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobsSection } from '../jobs/JobsSection';
import { JOBS } from '../jobs/jobs-copy';

// Reduced motion collapses the staged reveals to their final frame, the same
// way the sibling section tests render (TiersSection.test.tsx).
vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));

describe('JobsSection', () => {
  it('renders the five jobs as equal ledger rows with one verb each', () => {
    render(<JobsSection />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName(
      'It runs a whole reputation department.'
    );
    const verbs = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(verbs).toEqual(['Respond', 'Protect', 'Request', 'Brief', 'Measure']);
    expect(screen.getAllByRole('listitem')).toHaveLength(JOBS.length);
  });

  it('keeps the gold/teal temperature split: acting agents gold, the watching layer teal', () => {
    const { container } = render(<JobsSection />);
    const tones = Array.from(container.querySelectorAll('.rw-lp-jobs-row')).map((row) =>
      row.getAttribute('data-tone')
    );
    expect(tones).toEqual(['gold', 'teal', 'gold', 'gold', 'teal']);
  });

  it('states only shipped capability, in present tense, with no channel that is off in production', () => {
    const { container } = render(<JobsSection />);
    const text = container.textContent ?? '';
    expect(text).toContain('printable QR code');
    expect(text).toContain('Solicitor asks your past customers by email');
    expect(text).toContain('Rep Pulse');
    expect(text).toContain('Restraint tab');
    expect(text).not.toMatch(/\bwill\b/);
    expect(text).not.toContain('Telegram');
    expect(text).not.toContain('WhatsApp');
    expect(text).not.toContain('Coming');
  });
});

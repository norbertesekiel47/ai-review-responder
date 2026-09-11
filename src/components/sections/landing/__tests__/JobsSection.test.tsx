// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsSection } from '../jobs/JobsSection';
import { JOBS } from '../jobs/jobs-copy';

// Reduced motion keeps every job film on its still, so the render is static.
vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}));

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

describe('JobsSection', () => {
  it('renders the five jobs in order, one verb each', () => {
    render(<JobsSection />);
    const verbs = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(verbs).toEqual(['Respond.', 'Protect.', 'Request.', 'Brief.', 'Measure.']);
    expect(screen.getAllByRole('article')).toHaveLength(JOBS.length);
  });

  it('gives every job its own film still, with a description of the scene', () => {
    render(<JobsSection />);
    for (const job of JOBS) {
      const still = document.querySelector(`[data-job-film="${job.id}"] img`);
      expect(still).toHaveAttribute('src', `/jobs/${job.id}.webp`);
      expect(still?.getAttribute('alt')).toBeTruthy();
    }
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

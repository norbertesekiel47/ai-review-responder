// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TiersSection } from '../tiers/TiersSection';
import { PRICING_LINK_LABEL, TIERS } from '../tiers/tiers-copy';

// The owner controls explain the two plans; they change no subscription.
// These tests pin the selector state, the lever mapping (Copilot = left,
// Autopilot = right), and the section's two doors: the primary CTA and
// /pricing.

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}));

const CTA = { primaryCtaHref: '/book-a-demo', primaryCtaLabel: 'Get early access' };

function tier(id: 'copilot' | 'autopilot') {
  const found = TIERS.find((item) => item.id === id);
  if (!found) throw new Error(`missing tier ${id}`);
  return found;
}

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

describe('TiersSection', () => {
  it('opens on Copilot, with the lever at the left over the approval tray', () => {
    render(<TiersSection {...CTA} />);
    expect(screen.getByRole('button', { name: /Copilot/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Autopilot/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(tier('copilot').claim);
    expect(screen.getByAltText(/lever set to the left for Copilot/)).toHaveAttribute('src', '/tiers/lever-copilot.webp');
  });

  it('moves the lever to the right and explains Autopilot when selected', () => {
    render(<TiersSection {...CTA} />);
    fireEvent.click(screen.getByRole('button', { name: /Autopilot/ }));
    expect(screen.getByRole('button', { name: /Autopilot/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(tier('autopilot').claim);
    expect(screen.getByAltText(/lever set to the right for Autopilot/)).toHaveAttribute('src', '/tiers/lever-autopilot.webp');
  });

  it('switches instantly under reduced motion: no transition film plays', () => {
    const { container } = render(<TiersSection {...CTA} />);
    fireEvent.click(screen.getByRole('button', { name: /Autopilot/ }));
    expect(container.querySelector('video')).toBeNull();
  });

  it('offers the server-selected CTA and the door to /pricing', () => {
    render(<TiersSection {...CTA} />);
    expect(screen.getByRole('link', { name: /Get early access/ })).toHaveAttribute('href', '/book-a-demo');
    expect(screen.getByRole('link', { name: new RegExp(PRICING_LINK_LABEL) })).toHaveAttribute('href', '/pricing');
  });
});

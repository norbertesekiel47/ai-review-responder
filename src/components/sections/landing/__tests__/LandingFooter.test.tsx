// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AmbientMotionProvider } from '../ambient-motion';
import { LandingFooter } from '../footer/LandingFooter';
import { SUPPORT_EMAIL, WORDMARK } from '../footer/footer-copy';
import { LEGAL_LINKS } from '@/components/ui/marketing-links';

// The footer's contract: real destinations only (no `#` links), the legal set
// as its own navigation, and a decorative wordmark whose hover reveal is wired
// only for a real pointer.

const { mockReduced } = vi.hoisted(() => ({ mockReduced: vi.fn<() => boolean>(() => false) }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockReduced(),
}));

function stubPointer(fine: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: fine && query === '(hover: hover) and (pointer: fine)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
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
afterEach(() => {
  vi.unstubAllGlobals();
  mockReduced.mockReturnValue(false);
});

/** The footer carries the pause control, which needs the page's provider. */
function renderFooter() {
  return render(
    <AmbientMotionProvider>
      <LandingFooter />
    </AmbientMotionProvider>,
  );
}

function wordmarkParts(container: HTMLElement) {
  const svg = container.querySelector('svg.rw-lp-foot-wordmark');
  const fill = container.querySelector('.rw-lp-foot-wordmark-fill');
  if (!svg || !fill) throw new Error('wordmark not rendered');
  return { svg, fill };
}

describe('LandingFooter', () => {
  it('links only to real destinations', () => {
    stubPointer(true);
    const { container } = renderFooter();
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('#');
    expect(screen.getByRole('link', { name: SUPPORT_EMAIL })).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
    const legal = within(screen.getByRole('navigation', { name: 'Legal' }));
    expect(legal.getAllByRole('link')).toHaveLength(LEGAL_LINKS.length);
  });

  it('keeps the wordmark decorative', () => {
    stubPointer(true);
    const { container } = renderFooter();
    const { svg } = wordmarkParts(container);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveTextContent(WORDMARK);
  });

  it('reveals the wordmark under a fine pointer and tracks it', () => {
    stubPointer(true);
    const { container } = renderFooter();
    const { svg, fill } = wordmarkParts(container);
    expect(fill).toHaveAttribute('data-hovered', 'false');
    fireEvent.mouseEnter(svg);
    expect(fill).toHaveAttribute('data-hovered', 'true');
    fireEvent.mouseMove(svg, { clientX: 10, clientY: 5 });
    fireEvent.mouseLeave(svg);
    expect(fill).toHaveAttribute('data-hovered', 'false');
  });

  it('attaches no hover behaviour for a coarse pointer', () => {
    stubPointer(false);
    const { container } = renderFooter();
    const { svg, fill } = wordmarkParts(container);
    fireEvent.mouseEnter(svg);
    expect(fill).toHaveAttribute('data-hovered', 'false');
  });

  it('still renders the reveal under reduced motion', () => {
    mockReduced.mockReturnValue(true);
    stubPointer(true);
    const { container } = renderFooter();
    const { svg, fill } = wordmarkParts(container);
    fireEvent.mouseEnter(svg);
    expect(fill).toHaveAttribute('data-hovered', 'true');
  });
});

// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FleetSection } from '../fleet/FleetSection';

// The living diagram's contract (DESIGN.md → Fleet): the constellation is
// measured at runtime and assembles on one arming signal; below 900px it is
// abandoned for a stacked list; a hovered node claims its wire; the centre
// opens the film. These tests pin the composition and the measurement path
// with deterministic observer stubs.

const { mockPrefersReducedMotion, mockConstellation } = vi.hoisted(() => ({
  mockPrefersReducedMotion: vi.fn<() => boolean>(() => false),
  mockConstellation: vi.fn<() => boolean>(() => true),
}));

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockPrefersReducedMotion(),
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockConstellation(),
}));
vi.mock('../fleet/VideoLightbox', () => ({
  VideoLightbox: ({ open, title }: { open: boolean; title: string }) =>
    open ? createElement('div', { 'data-testid': 'lightbox-open' }, title) : null,
}));
vi.mock('next/image', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
    createElement('img', { src, alt, className, 'data-testid': 'poster-image' }),
}));

/** Fires its callback synchronously on observe — the section arms on sight. */
class ImmediateIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, intersectionRatio: 1, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** Fires once on observe with the initial size — the real contract the hook
 *  documents ("it fires once on observe()"). */
class ImmediateResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const VIDEO_PROPS = {
  videoSrc: '/video/repworth-explainer.mp4',
  videoPoster: '/video/repworth-explainer-poster.jpg',
  videoTitle: 'Watch the film',
};

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
  // jsdom boxes are all zeros, which the measurer treats as "not laid out
  // yet". One non-zero box for every element is enough to draw the fan.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
    height: 100,
    top: 200,
    left: 0,
    bottom: 300,
    right: 1000,
    x: 0,
    y: 200,
    toJSON: () => ({}),
  } as DOMRect);
});

describe('FleetSection', () => {
  it('renders the constellation: six live agents, no NEXT tag, and six measured wires', () => {
    mockConstellation.mockReturnValue(true);
    const { container } = render(<FleetSection {...VIDEO_PROPS} />);

    expect(screen.getAllByRole('article')).toHaveLength(6);
    // Solicitor went live on 2026-09-06 (fleet-copy.ts contract), so no agent
    // wears the roadmap tag and no connector is the dashed one.
    expect(screen.queryByText('Next')).toBeNull();
    expect(screen.getByText('Judge reviews 100% of auto-posts')).toBeInTheDocument();

    // The arming signal fired (stubbed observer), so the stage assembles.
    expect(container.querySelector('.rw-lp-fleet-stage')).toHaveAttribute('data-armed', 'true');

    // Six connectors measured — one per agent, all solid.
    const groups = container.querySelectorAll('.rw-lp-fleet-wires g');
    expect(groups).toHaveLength(6);
    expect(container.querySelectorAll("g[data-status='next']")).toHaveLength(0);
    expect(container.querySelectorAll("g[data-status='live']")).toHaveLength(6);
  });

  it('a hovered node claims its wire (data-hot follows the pointer)', () => {
    mockConstellation.mockReturnValue(true);
    const { container } = render(<FleetSection {...VIDEO_PROPS} />);

    const judge = screen.getByText('Judge').closest('article');
    expect(judge).not.toBeNull();
    fireEvent.pointerEnter(judge as HTMLElement);
    expect(container.querySelectorAll("g[data-hot='true']")).toHaveLength(1);
    fireEvent.pointerLeave(judge as HTMLElement);
    expect(container.querySelectorAll("g[data-hot='true']")).toHaveLength(0);
  });

  it('the centre opens the film lightbox from a real button', () => {
    mockConstellation.mockReturnValue(true);
    render(<FleetSection {...VIDEO_PROPS} />);

    expect(screen.queryByTestId('lightbox-open')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /watch the film/i }));
    expect(screen.getByTestId('lightbox-open')).toBeInTheDocument();
  });

  it('abandons the constellation below the breakpoint: nodes stack, no wires', () => {
    mockConstellation.mockReturnValue(false);
    const { container } = render(<FleetSection {...VIDEO_PROPS} />);

    expect(screen.getAllByRole('article')).toHaveLength(6);
    expect(container.querySelectorAll('.rw-lp-fleet-wires g')).toHaveLength(0);
  });

  it('renders the honest placeholder when no film is wired', () => {
    mockConstellation.mockReturnValue(true);
    render(<FleetSection />);

    expect(screen.getByText('16 : 9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /watch the film/i })).toBeNull();
  });
});

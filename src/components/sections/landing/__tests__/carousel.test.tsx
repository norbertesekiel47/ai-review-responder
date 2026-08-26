// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CarouselDots, useCarousel } from '../carousel';

// The phone carousel's JS half. The rail itself is CSS scroll-snap, so the
// only behaviour worth pinning here is the pair the stylesheet cannot express:
// which slide is reported as current, and where a dot press scrolls to.
//
// jsdom has no layout, so every rect the maths reads is stubbed. The numbers
// below place slide 1 nearest the track's centre.

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false,
}));

const TRACK_WIDTH = 300;

function stubRect(element: Element, left: number, width: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left,
    width,
    right: left + width,
    top: 0,
    bottom: 0,
    height: 0,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Fires its callback synchronously on `observe`, the way the real one does. */
class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

/** jsdom reports 0 for every metric and the ref is only attached at commit, so
 *  the size has to be on the PROTOTYPE before the effect observes — an
 *  instance stub applied after `render` is already too late. */
function stubTrackWidth(value: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value });
}

/** One box for every element. The overflow test only needs the span between
 *  the first and last slide, and both read from this. */
function stubSpan(width: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: width,
    width,
    top: 0,
    bottom: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

function Harness() {
  const carousel = useCarousel();
  return (
    <>
      <div data-testid="track" className="rw-lp-carousel" {...carousel.track}>
        <div data-testid="slide-0" />
        <div data-testid="slide-1" />
        <div data-testid="slide-2" />
      </div>
      <p data-testid="overflowing">{String(carousel.overflowing)}</p>
      <CarouselDots count={3} active={carousel.active} onSelect={carousel.goTo} label="Cards" />
    </>
  );
}

/** Renders the harness and places slide 1 under the track's centre. */
function renderScrolledToSlideOne() {
  render(<Harness />);
  const track = screen.getByTestId('track');
  Object.defineProperty(track, 'clientWidth', { value: TRACK_WIDTH, configurable: true });
  stubRect(track, 0, TRACK_WIDTH);
  stubRect(screen.getByTestId('slide-0'), -300, TRACK_WIDTH);
  stubRect(screen.getByTestId('slide-1'), 10, TRACK_WIDTH);
  stubRect(screen.getByTestId('slide-2'), 320, TRACK_WIDTH);
  return track;
}

describe('useCarousel', () => {
  it('marks the track so the rail stylesheet can out-specify the section grid', () => {
    render(<Harness />);
    expect(screen.getByTestId('track')).toHaveAttribute('data-carousel', 'true');
  });

  it('reports the slide nearest the track centre after a scroll', async () => {
    const track = renderScrolledToSlideOne();
    fireEvent.scroll(track);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Card 2 of 3' })).toHaveAttribute(
        'aria-current',
        'true',
      );
    });
    expect(screen.getByRole('button', { name: 'Card 1 of 3' })).not.toHaveAttribute('aria-current');
  });

  it('scrolls by the distance between the first slide and the target slide', () => {
    const track = renderScrolledToSlideOne();
    const scrollTo = vi.fn();
    Object.defineProperty(track, 'scrollTo', { value: scrollTo, configurable: true });

    fireEvent.click(screen.getByRole('button', { name: 'Card 3 of 3' }));

    // 320 - (-300). Derived from the slides, never from the track's padding —
    // that is what makes the offset immune to the gutter changing.
    expect(scrollTo).toHaveBeenCalledWith({ left: 620, behavior: 'smooth' });
  });

  it('does nothing when the platform has no Element.scrollTo (jsdom, old webviews)', () => {
    renderScrolledToSlideOne();
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Card 3 of 3' }))).not.toThrow();
  });

  // The dots are gated on this. A track with nowhere to scroll — the desktop
  // grid, or the fleet's two watchdog cards at 767px — must not offer a
  // control that does nothing when pressed.
  it('reports no overflow when the slides fit the track', () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    stubTrackWidth(300);
    stubSpan(100);
    render(<Harness />);
    expect(screen.getByTestId('overflowing')).toHaveTextContent('false');
  });

  it('reports overflow once the slides run wider than the track', () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    stubTrackWidth(300);
    stubSpan(900);
    render(<Harness />);
    expect(screen.getByTestId('overflowing')).toHaveTextContent('true');
  });

  // The regression this measurement exists for: a card can paint outside its
  // own box (the future card's glow sits at `inset: -0.875rem`), and that bleed
  // lands in `scrollWidth`. Measuring the slides ignores it, so a desktop grid
  // is never mistaken for a rail with 14px of travel.
  it('ignores decorative bleed that only shows up in scrollWidth', () => {
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
    stubTrackWidth(556);
    stubSpan(556);
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      value: 570,
    });
    render(<Harness />);
    expect(screen.getByTestId('overflowing')).toHaveTextContent('false');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  });
});

describe('CarouselDots', () => {
  it('renders one labelled button per slide and marks the active one', () => {
    render(<CarouselDots count={4} active={2} onSelect={() => {}} label="The acting agents" />);
    const group = screen.getByRole('group', { name: 'The acting agents' });
    expect(group).toHaveAttribute('data-tone', 'gold');
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Card 3 of 4' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('carries the teal tone for the oversight layer', () => {
    render(<CarouselDots count={2} active={0} onSelect={() => {}} label="Watchdogs" tone="teal" />);
    expect(screen.getByRole('group', { name: 'Watchdogs' })).toHaveAttribute('data-tone', 'teal');
  });

  it('reports the pressed index', () => {
    const onSelect = vi.fn();
    render(<CarouselDots count={3} active={0} onSelect={onSelect} label="Cards" />);
    fireEvent.click(screen.getByRole('button', { name: 'Card 2 of 3' }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

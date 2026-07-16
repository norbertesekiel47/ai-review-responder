// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));
vi.mock('@/components/ui/SiteShell', () => ({
  SiteShell: ({ children, overlay }: { children?: ReactNode; overlay?: ReactNode }) => (
    <div>
      {overlay}
      {children}
    </div>
  ),
}));
vi.mock('../../lead-intake/LeadIntakeForm', () => ({
  LeadIntakeForm: () => <form aria-label="Waitlist form" />,
}));

import { HowItWorksContent } from '../HowItWorksContent';

const observerInstances: ControlledIntersectionObserver[] = [];

class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[];
  readonly observe = vi.fn<(target: Element) => void>();
  readonly unobserve = vi.fn<(target: Element) => void>();
  readonly disconnect = vi.fn<() => void>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    observerInstances.push(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  intersect(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this,
    );
  }
}

function offscreenRect(): DOMRect {
  return {
    x: 0,
    y: 1_000,
    width: 100,
    height: 100,
    top: 1_000,
    right: 100,
    bottom: 1_100,
    left: 0,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  observerInstances.length = 0;
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(offscreenRect());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HowItWorksContent Reveal effects', () => {
  it('reveals the delayed section after intersection and disconnects observers on transition and cleanup', () => {
    const { container, unmount } = render(<HowItWorksContent />);
    const guarantees = container.querySelector('.hiw-guarantees');
    expect(guarantees).not.toBeNull();
    const delayedReveal = guarantees!.parentElement;
    expect(delayedReveal).toHaveClass('hiw-reveal');
    expect(delayedReveal).not.toHaveClass('is-in');

    const revealObserver = observerInstances.find((observer) =>
      observer.observe.mock.calls.some(([target]) => target === delayedReveal),
    );
    expect(revealObserver).toBeDefined();
    expect(revealObserver!.thresholds).toEqual([0.05]);
    expect(revealObserver!.rootMargin).toBe('0px 0px -50px 0px');

    act(() => revealObserver!.intersect(delayedReveal!));
    expect(revealObserver!.disconnect).toHaveBeenCalledTimes(1);
    expect(delayedReveal).not.toHaveClass('is-in');

    act(() => vi.advanceTimersByTime(119));
    expect(delayedReveal).not.toHaveClass('is-in');

    act(() => vi.advanceTimersByTime(1));
    expect(delayedReveal).toHaveClass('is-in');
    // `seen` changes, so React cleans up the observer-owning effect before
    // running its no-op seen=true pass.
    expect(revealObserver!.disconnect).toHaveBeenCalledTimes(2);

    const sectionObserver = observerInstances.find((observer) =>
      observer.thresholds.length === 4,
    );
    expect(sectionObserver).toBeDefined();
    expect(sectionObserver!.disconnect).not.toHaveBeenCalled();

    unmount();
    expect(sectionObserver!.disconnect).toHaveBeenCalledTimes(1);
  });
});

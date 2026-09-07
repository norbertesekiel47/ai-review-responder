// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FutureSection } from '../future/FutureSection';
import {
  HORIZON_MARKER,
  HORIZON_X,
  LEGEND_NOTE,
  PLANNED_MARKER,
  SHIPPED_MARKER,
  STOPS,
} from '../future/future-copy';
import { routePath } from '../future/future-route';

// The route map's contract (DESIGN.md → Future): every stop is a real button
// with its body reachable by assistive tech; unbuilt stops carry their marker
// beside the name; the disclaimer sits on the chart; only shipped stops may be
// written in the present tense. These tests pin the honesty machinery and the
// geometry, not the pixels.

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false,
}));
vi.mock('next/image', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
    createElement('img', { src, alt, className }),
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, useInView: () => true };
});

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

describe('FutureSection — the route map', () => {
  it('renders one button per stop, in travel order, each describing its body', () => {
    render(<FutureSection />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(STOPS.length);
    STOPS.forEach((stop, index) => {
      const button = buttons[index];
      expect(button).toHaveTextContent(stop.name);
      expect(button).toHaveTextContent(stop.marker);
      const describedBy = button?.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? '')).toHaveTextContent(stop.body);
    });
  });

  it('keeps the disclaimer on the chart', () => {
    render(<FutureSection />);
    expect(screen.getByText(LEGEND_NOTE)).toBeInTheDocument();
  });

  it('opens exactly one stop at a time, on hover and on focus', () => {
    render(<FutureSection />);
    const [first, second] = screen.getAllByRole('button');
    if (!first || !second) throw new Error('stops missing');
    fireEvent.pointerEnter(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    fireEvent.focus(second);
    fireEvent.pointerLeave(first);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(second).toHaveAttribute('aria-pressed', 'true');
    fireEvent.blur(second);
    expect(second).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('future-copy — the honesty contract', () => {
  it('lists the shipped stops first, then the locked order, then the horizon', () => {
    const states = STOPS.map((stop) => stop.state);
    const firstPlanned = states.indexOf('planned');
    const firstHorizon = states.indexOf('horizon');
    expect(states.slice(0, firstPlanned).every((s) => s === 'shipped')).toBe(true);
    expect(states.slice(firstPlanned, firstHorizon).every((s) => s === 'planned')).toBe(true);
    expect(states.slice(firstHorizon).every((s) => s === 'horizon')).toBe(true);
  });

  it('writes every unbuilt stop in the future tense, with its marker', () => {
    for (const stop of STOPS) {
      if (stop.state === 'shipped') {
        expect(stop.marker).toBe(SHIPPED_MARKER);
        continue;
      }
      expect(stop.body.startsWith('Will ')).toBe(true);
      if (stop.state === 'planned') expect(stop.marker).toMatch(/^Phase \d$/);
      if (stop.state === 'horizon') expect(stop.marker).toBe(HORIZON_MARKER);
    }
    expect(PLANNED_MARKER).toBe('Planned');
  });

  it('keeps the horizon stops past the horizon line and everything else before it', () => {
    for (const stop of STOPS) {
      if (stop.state === 'horizon') expect(stop.x).toBeGreaterThan(HORIZON_X);
      else expect(stop.x).toBeLessThan(HORIZON_X);
    }
  });
});

describe('routePath', () => {
  it('draws nothing for fewer than two points', () => {
    expect(routePath([])).toBe('');
    expect(routePath([{ x: 1, y: 1 }])).toBe('');
  });

  it('starts at the first point, ends at the last, one cubic per leg', () => {
    const d = routePath([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 0 },
    ]);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('200 0')).toBe(true);
    expect(d.match(/ C /g)).toHaveLength(2);
  });
});

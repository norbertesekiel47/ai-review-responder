// @vitest-environment jsdom
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FutureSection } from '../future/FutureSection';
import {
  HORIZON_MARKER,
  PLANNED_MARKER,
  SHIPPED_MARKER,
  STOPS,
} from '../future/future-copy';

// The Working Atlas's contract (chosen-design.md → "Where this is going"):
// three chapter controls, five stops per chapter on the map and in the
// ledger, and every one of the 15 canonical stops reachable with its
// availability label. These tests pin the honesty machinery, not the pixels.

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}));

function ledger() {
  return within(screen.getByRole('complementary', { name: 'Roadmap detail ledger' }));
}

function chapterButton(name: RegExp) {
  return within(screen.getByRole('navigation', { name: 'Explore roadmap chapters' })).getByRole('button', { name });
}

describe('FutureSection — the Working Atlas', () => {
  it('opens on the shipped chapter with its first stop selected', () => {
    render(<FutureSection />);
    expect(chapterButton(/Shipped/)).toHaveAttribute('aria-pressed', 'true');
    expect(chapterButton(/Planned/)).toHaveAttribute('aria-pressed', 'false');
    const first = STOPS[0];
    if (!first) throw new Error('no stops');
    expect(ledger().getByRole('heading', { level: 3 })).toHaveTextContent(first.name);
    expect(ledger().getByText('Available today')).toBeInTheDocument();
  });

  it('lists exactly the chapter’s stops on the map and in the ledger', () => {
    render(<FutureSection />);
    const shipped = STOPS.filter((stop) => stop.state === 'shipped');
    const rows = ledger().getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(
      shipped.map((stop) => expect.stringContaining(stop.name)),
    );
    const mapStops = document.querySelectorAll('.rw-lp-final-atlas-stop');
    expect(mapStops).toHaveLength(shipped.length);
  });

  it('moves to a chapter’s first stop and marks unbuilt stops "Not available yet"', () => {
    render(<FutureSection />);
    fireEvent.click(chapterButton(/Planned/));
    const firstPlanned = STOPS.find((stop) => stop.state === 'planned');
    if (!firstPlanned) throw new Error('no planned stop');
    expect(chapterButton(/Planned/)).toHaveAttribute('aria-pressed', 'true');
    expect(ledger().getByRole('heading', { level: 3 })).toHaveTextContent(firstPlanned.name);
    expect(ledger().getByText('Not available yet')).toBeInTheDocument();
    expect(ledger().getAllByText(`Planned · ${firstPlanned.marker}`).length).toBeGreaterThan(0);
  });

  it('reaches all 15 canonical stops through the three chapters', () => {
    render(<FutureSection />);
    const seen = new Set<string>();
    for (const name of [/Shipped/, /Planned/, /Horizon/]) {
      fireEvent.click(chapterButton(name));
      for (const button of ledger().getAllByRole('button')) {
        fireEvent.click(button);
        seen.add(ledger().getByRole('heading', { level: 3 }).textContent ?? '');
      }
    }
    expect([...seen].sort()).toEqual(STOPS.map((stop) => stop.name).sort());
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
      // A hint, not a spec — but still a promise about the future.
      expect(/\bwill\b/i.test(stop.body)).toBe(true);
      if (stop.state === 'planned') expect(stop.marker).toMatch(/^Phase \d$/);
      if (stop.state === 'horizon') expect(stop.marker).toBe(HORIZON_MARKER);
    }
    expect(PLANNED_MARKER).toBe('Planned');
  });
});

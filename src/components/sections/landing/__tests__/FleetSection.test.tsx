// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FleetSection } from '../fleet/FleetSection';
import { PersonasSection } from '../personas/PersonasSection';
import { PERSONAS } from '../personas/personas-copy';

// The fleet's contract (chosen-design.md → Fleet): four station links, each a
// real anchor to its agent's story in the personas section, and a film that
// opens in the accessible lightbox.

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true,
}));
vi.mock('../fleet/VideoLightbox', () => ({
  VideoLightbox: ({ open, title }: { open: boolean; title: string }) =>
    open ? createElement('div', { 'data-testid': 'lightbox-open' }, title) : null,
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

describe('FleetSection', () => {
  it('links each of the four stations to its agent in the personas section', () => {
    render(
      <>
        <FleetSection />
        <PersonasSection />
      </>,
    );
    const stations = document.querySelectorAll<HTMLAnchorElement>('a.rw-lp-syn-l-station');
    expect(stations).toHaveLength(PERSONAS.length);
    stations.forEach((station, index) => {
      const agent = PERSONAS[index];
      if (!agent) throw new Error('station without an agent');
      expect(station).toHaveTextContent(agent.name);
      const target = document.getElementById(station.getAttribute('href')?.slice(1) ?? '');
      expect(target).toHaveTextContent(agent.tagline);
    });
  });

  it('opens the film in the lightbox', () => {
    render(<FleetSection />);
    expect(screen.queryByTestId('lightbox-open')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Watch the RepWorth film/ }));
    expect(screen.getByTestId('lightbox-open')).toHaveTextContent('Meet the RepWorth fleet');
  });

  it('shows the whole courtyard scene', () => {
    render(<FleetSection />);
    expect(screen.getByAltText(/Four sage CRT agents/)).toHaveAttribute('src', '/fleet/courtyard.webp');
  });
});

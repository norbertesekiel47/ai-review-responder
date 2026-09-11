// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeroSection } from '../hero/HeroSection';

// The hero backdrop's contract (HeroBackdrop's doc comment): the poster is
// always the LCP element; the video mounts only on the client, picks its
// source from the viewport, reveals itself once it can play, and does not
// exist at all under reduced motion.

const { mockReduced, mockNarrow } = vi.hoisted(() => ({
  mockReduced: vi.fn<() => boolean>(() => false),
  mockNarrow: vi.fn<() => boolean>(() => false),
}));

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockReduced(),
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockNarrow(),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
    createElement('img', { src, alt, className }),
}));

const CTA = { primaryCtaHref: '/book-a-demo', primaryCtaLabel: 'Get early access' };

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  mockReduced.mockReturnValue(false);
  mockNarrow.mockReturnValue(false);
});

describe('HeroSection backdrop', () => {
  it('always renders the poster', () => {
    const { container } = render(<HeroSection {...CTA} />);
    expect(container.querySelector('img.rw-lp-hero-poster')).toHaveAttribute('src', '/video/heroVideo-poster.jpg');
  });

  it('plays the wide clip on wide viewports, hidden until it can play', () => {
    const { container } = render(<HeroSection {...CTA} />);
    const video = container.querySelector('video.rw-lp-hero-video');
    expect(video).toHaveAttribute('src', '/video/heroVideo-1600.mp4');
    expect(video).toHaveAttribute('data-ready', 'false');
    if (!video) throw new Error('video not rendered');
    fireEvent.canPlay(video);
    expect(video).toHaveAttribute('data-ready', 'true');
  });

  it('reveals the clip on loadeddata as well', () => {
    const { container } = render(<HeroSection {...CTA} />);
    const video = container.querySelector('video.rw-lp-hero-video');
    if (!video) throw new Error('video not rendered');
    fireEvent.loadedData(video);
    expect(video).toHaveAttribute('data-ready', 'true');
  });

  it('plays the narrow clip on narrow viewports', () => {
    mockNarrow.mockReturnValue(true);
    const { container } = render(<HeroSection {...CTA} />);
    expect(container.querySelector('video.rw-lp-hero-video')).toHaveAttribute('src', '/video/heroVideo-960.mp4');
  });

  it('renders no video at all under reduced motion', () => {
    mockReduced.mockReturnValue(true);
    const { container } = render(<HeroSection {...CTA} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img.rw-lp-hero-poster')).toBeInTheDocument();
  });
});

describe('HeroSection copy', () => {
  it('points the primary action at the server-selected destination', () => {
    render(<HeroSection {...CTA} />);
    expect(screen.getByRole('link', { name: /Get early access/ })).toHaveAttribute('href', '/book-a-demo');
  });
});

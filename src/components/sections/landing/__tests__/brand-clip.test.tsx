// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { BrandClip } from '../brand-clip';

// BrandClip's contract: the authored clip plays only in view and only when
// motion is allowed; otherwise, and after a failed source, its still shows.

const { mockReduced, mockInView } = vi.hoisted(() => ({
  mockReduced: vi.fn<() => boolean>(() => false),
  mockInView: vi.fn<() => boolean>(() => true),
}));

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockReduced(),
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, useInView: () => mockInView() };
});
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}));

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  mockReduced.mockReturnValue(false);
  mockInView.mockReturnValue(true);
});

describe('BrandClip', () => {
  it('plays the house film from the problem folder when in view', () => {
    const { container } = render(<BrandClip id="house" />);
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', '/problem/problem-diagram.mp4');
    expect(video).toHaveAttribute('poster', '/problem/problem-diagram.jpg');
    expect(container.querySelector('img')).toBeNull();
  });

  it('plays an agent clip from the agents folder', () => {
    const { container } = render(<BrandClip id="judge" />);
    expect(container.querySelector('video')).toHaveAttribute('src', '/agents/judge.mp4');
  });

  it('shows the still, and no video, under reduced motion', () => {
    mockReduced.mockReturnValue(true);
    const { container } = render(<BrandClip id="governor" />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', '/agents/governor.jpg');
  });

  it('shows the still while out of view', () => {
    mockInView.mockReturnValue(false);
    const { container } = render(<BrandClip id="judge" />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', '/agents/judge.jpg');
  });

  it('falls back to the still when the source fails', () => {
    const { container } = render(<BrandClip id="judge" />);
    const video = container.querySelector('video');
    if (!video) throw new Error('video not rendered');
    fireEvent.error(video);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', '/agents/judge.jpg');
  });

  it('is decorative', () => {
    const { container } = render(<BrandClip id="house" className="extra" />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper).toHaveClass('rw-lp-syn-m-clip', 'extra');
  });
});

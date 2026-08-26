// @vitest-environment jsdom
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentFlipCard } from '../agent-flip-card';

// The flip card's input contract (agent-flip-card.css header): hover-capable
// fine pointers flip via :hover/:focus-visible and a click must NOT latch;
// touch devices flip via the click toggle. These tests pin the JS half of
// that contract (the `canHover` gate), the roadmap treatment, the front rule
// plate, and the reduced-motion still.

const { mockPrefersReducedMotion, mockCanHover } = vi.hoisted(() => ({
  mockPrefersReducedMotion: vi.fn<() => boolean>(() => false),
  mockCanHover: vi.fn<() => boolean>(() => false),
}));

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockPrefersReducedMotion(),
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockCanHover(),
}));
vi.mock('../ambient-motion', () => ({
  AmbientVideo: ({ className }: { className?: string }) =>
    createElement('video', { 'data-testid': 'ambient-video', className }),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
    createElement('img', { src, alt, className, 'data-testid': 'still-image' }),
}));

const BASE = {
  name: 'Reply',
  tagline: 'Every review gets a response.',
  duties: 'Drafts a reply to every new review.',
  videoSrc: '/agents/reply.mp4',
  posterSrc: '/agents/reply.jpg',
};

describe('AgentFlipCard', () => {
  it('renders both faces in the DOM with no aria-hidden on the back', () => {
    mockPrefersReducedMotion.mockReturnValue(false);
    render(<AgentFlipCard {...BASE} />);
    expect(screen.getByText('Every review gets a response.')).toBeInTheDocument();
    // The duties stay readable without any interaction — the flip is visual.
    expect(screen.getByText('Drafts a reply to every new review.')).toBeInTheDocument();
    expect(screen.getByTestId('ambient-video')).toBeInTheDocument();
  });

  it('toggles the flip on click for non-hover devices', () => {
    mockCanHover.mockReturnValue(false);
    render(<AgentFlipCard {...BASE} />);
    const card = screen.getByRole('button');
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('data-flipped', 'true');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'false');
  });

  it('does NOT latch on click for hover-capable devices (the #955 contract)', () => {
    mockCanHover.mockReturnValue(true);
    render(<AgentFlipCard {...BASE} />);
    const card = screen.getByRole('button');
    fireEvent.click(card);
    // Hover owns the flip on these devices; a click latching data-flipped
    // would hold the card flipped after the pointer leaves.
    expect(card).toHaveAttribute('data-flipped', 'false');
  });

  it('renders the roadmap treatment, chip tone, and front rule plate', () => {
    mockCanHover.mockReturnValue(false);
    render(
      <AgentFlipCard
        {...BASE}
        status="next"
        statusTag="Coming"
        chip="Reviews 100% of auto-posts"
        chipTone="teal"
        tier="watchdog"
        frontRule="Reviews 100% of auto-posts"
      />,
    );
    const card = screen.getByRole('button');
    expect(card).toHaveAttribute('data-status', 'next');
    expect(card).toHaveAttribute('data-tier', 'watchdog');
    expect(screen.getByText('Coming')).toBeInTheDocument();
    // The rule appears twice: the front plate and the back chip.
    expect(screen.getAllByText('Reviews 100% of auto-posts')).toHaveLength(2);
  });

  it('reduced motion swaps the clip for its still poster', () => {
    mockPrefersReducedMotion.mockReturnValue(true);
    render(<AgentFlipCard {...BASE} />);
    expect(screen.getByTestId('still-image')).toBeInTheDocument();
    expect(screen.queryByTestId('ambient-video')).toBeNull();
  });
});

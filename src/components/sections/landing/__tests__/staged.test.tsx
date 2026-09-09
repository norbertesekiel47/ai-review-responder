// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Staged, StagedLine } from '../staged';

// The staged-beat contract (docs/brand-asset-library/design-systems/landing/DESIGN.md → Motion): both
// elements share ONE motion-prop builder, reduced motion renders the final
// frame on the SAME element type, and rise={0} writes no transform at all
// (the future-glow rule). These tests execute every branch of that builder.

const { mockPrefersReducedMotion } = vi.hoisted(() => ({
  mockPrefersReducedMotion: vi.fn<() => boolean>(() => false),
}));

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => mockPrefersReducedMotion(),
}));

describe('Staged / StagedLine', () => {
  it('renders children in a div (Staged) and a span (StagedLine)', () => {
    mockPrefersReducedMotion.mockReturnValue(false);
    const { container } = render(
      <>
        <Staged beat={1} className="block-beat">
          <p>block child</p>
        </Staged>
        <p>
          <StagedLine beat={2} className="line-beat">
            line child
          </StagedLine>
        </p>
      </>,
    );
    expect(screen.getByText('block child')).toBeInTheDocument();
    expect(screen.getByText('line child')).toBeInTheDocument();
    expect(container.querySelector('div.block-beat')).not.toBeNull();
    expect(container.querySelector('span.line-beat')).not.toBeNull();
  });

  it('starts hidden (opacity 0) when motion is allowed', () => {
    mockPrefersReducedMotion.mockReturnValue(false);
    const { container } = render(
      <Staged className="probe">
        <p>child</p>
      </Staged>,
    );
    const wrapper = container.querySelector<HTMLElement>('.probe');
    expect(wrapper?.style.opacity).toBe('0');
  });

  it('rise={0} writes no transform — the future-glow rule', () => {
    mockPrefersReducedMotion.mockReturnValue(false);
    const { container } = render(
      <Staged rise={0} className="probe">
        <p>child</p>
      </Staged>,
    );
    const wrapper = container.querySelector<HTMLElement>('.probe');
    expect(wrapper?.style.opacity).toBe('0');
    // Opacity-only: any transform here would break the fixed-attachment glow.
    expect(wrapper?.style.transform ?? '').not.toContain('translate');
  });

  it('reduced motion renders the settled frame on the same element type', () => {
    mockPrefersReducedMotion.mockReturnValue(true);
    const { container } = render(
      <>
        <Staged className="probe-div">
          <p>block child</p>
        </Staged>
        <StagedLine rise={0} className="probe-span">
          line child
        </StagedLine>
      </>,
    );
    // Same element type in both branches (the SectionTransition observer trap):
    // the reduced-motion frame is still a motion element, not a swapped-in div.
    const div = container.querySelector<HTMLElement>('div.probe-div');
    const span = container.querySelector<HTMLElement>('span.probe-span');
    expect(div).not.toBeNull();
    expect(span).not.toBeNull();
    // `initial={false}` — the final frame, not a hidden start.
    expect(div?.style.opacity ?? '').not.toBe('0');
    expect(span?.style.opacity ?? '').not.toBe('0');
  });
});

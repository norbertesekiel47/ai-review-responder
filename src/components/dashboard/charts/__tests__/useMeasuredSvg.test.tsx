// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_CHART_WIDTH, useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';

type ROCallback = (entries: Array<{ contentRect: { width: number } }>) => void;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ROCallback;
  observed: Element[] = [];
  constructor(callback: ROCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}

function Probe() {
  const { ref, width, measured } = useMeasuredSvg<HTMLDivElement>();
  return (
    <div ref={ref}>
      <span data-testid="width">{width}</span>
      <span data-testid="measured">{String(measured)}</span>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockResizeObserver.instances = [];
});

describe('useMeasuredSvg', () => {
  it('reports the canonical width, unmeasured, when ResizeObserver is unavailable (SSR/jsdom default)', () => {
    render(<Probe />);
    expect(screen.getByTestId('width').textContent).toBe(String(CANONICAL_CHART_WIDTH));
    expect(screen.getByTestId('measured').textContent).toBe('false');
  });

  it('adopts the observed width once ResizeObserver reports a positive size', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(<Probe />);
    const instance = MockResizeObserver.instances[0]!;
    act(() => instance.callback([{ contentRect: { width: 831 } }]));
    expect(screen.getByTestId('width').textContent).toBe('831');
    expect(screen.getByTestId('measured').textContent).toBe('true');
  });

  it('falls back to canonical width and measured=false on a zero-size report', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(<Probe />);
    act(() => MockResizeObserver.instances[0]!.callback([{ contentRect: { width: 0 } }]));
    expect(screen.getByTestId('width').textContent).toBe(String(CANONICAL_CHART_WIDTH));
    expect(screen.getByTestId('measured').textContent).toBe('false');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCountUp } from '@/hooks/useCountUp';

/**
 * Drives the cubic-ease-out counter via a controllable requestAnimationFrame
 * mock so we can assert the contract that the three former inline copies relied
 * on: gating, easing to target, delay, and rounding.
 */
describe('useCountUp', () => {
  let pending: FrameRequestCallback | null;

  beforeEach(() => {
    pending = null;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      pending = fn;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      pending = null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function frame(timestamp: number) {
    const fn = pending;
    pending = null;
    if (fn) act(() => fn(timestamp));
  }

  it('starts at 0 and eases to the target by the end of the duration', () => {
    const { result } = renderHook(() => useCountUp(100, { duration: 1000 }));
    expect(result.current).toBe(0);
    frame(0); // first frame anchors the start time
    expect(result.current).toBe(0);
    frame(1000); // progress = 1 → eased = 1 → value = target
    expect(result.current).toBe(100);
  });

  it('does not animate or schedule a frame while inactive', () => {
    const { result } = renderHook(() => useCountUp(100, { active: false }));
    expect(result.current).toBe(0);
    expect(pending).toBeNull();
  });

  it('emits integers when round is true', () => {
    const { result } = renderHook(() => useCountUp(3, { duration: 1000, round: true }));
    frame(0);
    frame(500);
    expect(Number.isInteger(result.current)).toBe(true);
  });

  it('holds at 0 through delayMs, then animates', () => {
    const { result } = renderHook(() => useCountUp(100, { duration: 1000, delayMs: 500 }));
    frame(0); // start anchored at 0 + 500
    frame(250); // still inside the delay window
    expect(result.current).toBe(0);
    frame(1500); // (1500 - 500) / 1000 = 1 → target
    expect(result.current).toBe(100);
  });

  it('cancels the scheduled frame on unmount', () => {
    const { unmount } = renderHook(() => useCountUp(100, { duration: 1000 }));
    expect(pending).not.toBeNull(); // a frame is scheduled while active
    unmount();
    expect(pending).toBeNull(); // the effect cleanup cancelled it
  });
});

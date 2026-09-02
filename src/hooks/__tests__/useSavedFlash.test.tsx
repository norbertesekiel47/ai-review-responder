// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSavedFlash } from '../useSavedFlash';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSavedFlash', () => {
  it('starts off, raises on flashSaved, and clears after the window', () => {
    const { result } = renderHook(() => useSavedFlash(1800));
    expect(result.current.savedFlash).toBe(false);

    act(() => result.current.flashSaved());
    expect(result.current.savedFlash).toBe(true);

    act(() => vi.advanceTimersByTime(1799));
    expect(result.current.savedFlash).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.savedFlash).toBe(false);
  });

  it('re-arms rather than stacks when saved twice inside the window', () => {
    const { result } = renderHook(() => useSavedFlash(1000));
    act(() => result.current.flashSaved());
    act(() => vi.advanceTimersByTime(700));
    act(() => result.current.flashSaved());

    act(() => vi.advanceTimersByTime(700));
    expect(result.current.savedFlash).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.savedFlash).toBe(false);
  });

  it('clears its timer on unmount so nothing fires afterwards', () => {
    const { result, unmount } = renderHook(() => useSavedFlash(1000));
    act(() => result.current.flashSaved());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

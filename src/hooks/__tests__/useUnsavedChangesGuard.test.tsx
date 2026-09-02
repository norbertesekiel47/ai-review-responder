// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  readUnsavedChanges,
  useHasUnsavedChanges,
  useUnsavedChangesGuard,
} from '../useUnsavedChangesGuard';

function fireBeforeUnload(): BeforeUnloadEvent {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  return event;
}

describe('useUnsavedChangesGuard', () => {
  it('arms the browser leave prompt only while dirty', () => {
    const { rerender, unmount } = renderHook(({ dirty }: { dirty: boolean }) => useUnsavedChangesGuard(dirty), {
      initialProps: { dirty: false },
    });

    expect(readUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    rerender({ dirty: true });
    expect(readUnsavedChanges()).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    rerender({ dirty: false });
    expect(readUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    unmount();
  });

  it('clears its entry on unmount so a completed navigation leaves nothing armed', () => {
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    expect(readUnsavedChanges()).toBe(true);

    unmount();

    expect(readUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('exposes the shared flag to navigation chrome through useHasUnsavedChanges', () => {
    const reader = renderHook(() => useHasUnsavedChanges());
    expect(reader.result.current).toBe(false);

    const form = renderHook(({ dirty }: { dirty: boolean }) => useUnsavedChangesGuard(dirty), {
      initialProps: { dirty: true },
    });
    expect(reader.result.current).toBe(true);

    form.rerender({ dirty: false });
    expect(reader.result.current).toBe(false);

    form.unmount();
    reader.unmount();
  });
});

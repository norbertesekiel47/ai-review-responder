import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('fireConfetti', () => {
  let appended: number;
  let removeCalled: boolean;

  beforeEach(() => {
    appended = 0;
    removeCalled = false;
    const stubLayer = {
      className: '',
      appendChild: () => {
        appended++;
      },
      remove: () => {
        removeCalled = true;
      },
    } as unknown as HTMLElement;
    const stubSpan = (() => {
      const el: Record<string, unknown> = {
        style: { setProperty: () => {} },
      };
      return el as unknown as HTMLElement;
    })();
    (globalThis as unknown as { document: Document }).document = {
      createElement: (tag: string) => (tag === 'div' ? stubLayer : stubSpan) as HTMLElement,
      body: { appendChild: () => {} } as unknown as HTMLElement,
    } as unknown as Document;
    (globalThis as unknown as { window: Window }).window = {
      matchMedia: () => ({ matches: false } as MediaQueryList),
    } as unknown as Window;
  });

  afterEach(() => {
    delete (globalThis as { document?: Document }).document;
    delete (globalThis as { window?: Window }).window;
    vi.useRealTimers();
  });

  it('appends 60 particles to a layer when reduced-motion is off', async () => {
    vi.useFakeTimers();
    const { fireConfetti } = await import('../fireConfetti');
    fireConfetti();
    expect(appended).toBe(60);
    vi.advanceTimersByTime(2300);
    expect(removeCalled).toBe(true);
  });

  it('is a no-op when prefers-reduced-motion is reduce', async () => {
    (globalThis as unknown as { window: Window }).window = {
      matchMedia: () => ({ matches: true } as MediaQueryList),
    } as unknown as Window;
    const { fireConfetti } = await import('../fireConfetti');
    fireConfetti();
    expect(appended).toBe(0);
  });
});

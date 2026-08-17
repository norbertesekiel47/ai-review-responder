import { describe, it, expect, vi } from 'vitest';

// The Messaging adapter accessor (#657 Task 5). RED until
// `src/lib/messaging/messaging-adapter.ts` exists.
//
// Mirrors `getReviewPublisher()` in src/lib/publishing/review-publisher.ts: the
// interface file owns the types and the accessor, the adapter file owns the
// provider, and the factory shape IS the selection seam — when a WhatsApp
// adapter lands it is chosen HERE, not at every call site.

/**
 * A fresh module graph per case: `getMessagingAdapter` caches in a module-level
 * singleton, so the "returns" case must not observe a leftover from the
 * "caches" case. Both modules come from the SAME graph, or `instanceof` would
 * compare against a different class object.
 */
async function freshMessagingModules() {
  vi.resetModules();
  const seam = await import('../messaging-adapter');
  const email = await import('../email-adapter');
  return { getMessagingAdapter: seam.getMessagingAdapter, EmailAdapter: email.EmailAdapter };
}

describe('getMessagingAdapter', () => {
  it('getMessagingAdapter returns the email adapter', async () => {
    const { getMessagingAdapter, EmailAdapter } = await freshMessagingModules();

    const adapter = getMessagingAdapter();

    // EmailAdapter is the first and today ONLY adapter. Constructing it must not
    // require the Sending identity to exist — the client resolves per send, so
    // this call works with no solicitation env set at all.
    expect(adapter).toBeInstanceOf(EmailAdapter);
    expect(typeof adapter.send).toBe('function');
  });

  it('getMessagingAdapter caches the adapter across calls', async () => {
    const { getMessagingAdapter } = await freshMessagingModules();

    const first = getMessagingAdapter();
    const second = getMessagingAdapter();

    expect(second).toBe(first);
  });
});

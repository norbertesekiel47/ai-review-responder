import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The `'solicitation'` EmailCategory (#657 Task 3, spec §7.3). RED until that
// task widens `EmailCategory` and adds the fail-closed branch — today
// `getEmailHeaders('solicitation')` falls through the `category !== 'marketing'`
// guard and returns `{}`.
//
// Mirrors src/lib/shared/__tests__/email-headers.test.ts exactly: each case sets
// the env it needs, then `vi.resetModules()` + a fresh dynamic import re-parses
// the live env through the memoized `getServerConfig()` accessor (Stage-3
// convention #6). That suite stays the regression anchor for the marketing
// contract; this one owns the new category.
//
// The whole point of the category is that it NEVER degrades. A marketing digest
// with a broken List-Unsubscribe is a deliverability problem; a solicitation ask
// with one ships a legally-required opt-out that cannot work.

const PER_ASK_URL = 'https://worker.test.repworth.net/u/tok_657_per_ask';
const SOLICITATION_MAILBOX = 'unsubscribe@feedback.test.repworth.net';
const GLOBAL_MARKETING_URL = 'https://repworth.example/api/unsubscribe?token=global';

async function freshEmailHeaders() {
  vi.resetModules();
  const mod = await import('@/lib/notifications/email');
  return { getEmailHeaders: mod.getEmailHeaders, getEmailTags: mod.getEmailTags };
}

describe('getEmailHeaders — solicitation category', () => {
  const KEYS = [
    'LIST_UNSUBSCRIBE_EMAIL',
    'LIST_UNSUBSCRIBE_URL',
    'RESEND_FROM_EMAIL',
    'SOLICITATION_UNSUBSCRIBE_MAILTO',
  ] as const;
  const SNAP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      SNAP[k] = process.env[k];
      delete process.env[k];
    }
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
    process.env.SOLICITATION_UNSUBSCRIBE_MAILTO = SOLICITATION_MAILBOX;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k];
      else process.env[k] = SNAP[k];
    }
    vi.resetModules();
  });

  it('getEmailHeaders returns no headers for a transactional category', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();
    // Approval mail is user-initiated and service-necessary. Widening the
    // category union must not leak an unsubscribe onto the approval rail —
    // invariant #3 reached sideways.
    expect(getEmailHeaders('transactional')).toEqual({});
  });

  it('getEmailHeaders is unchanged for the marketing category when a URL is configured', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = GLOBAL_MARKETING_URL;
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.example';
    const { getEmailHeaders } = await freshEmailHeaders();

    const headers = getEmailHeaders('marketing');

    // Byte-for-byte the pre-#657 contract: the new branch returns BEFORE this
    // body, so the existing marketing form may not shift by a character.
    expect(headers['List-Unsubscribe']).toBe(
      `<${GLOBAL_MARKETING_URL}>, <mailto:unsubscribe@repworth.example>`,
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('getEmailHeaders builds the solicitation List-Unsubscribe from the supplied per-ask URL', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();

    const headers = getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL });

    // Per-ask, never per-sender: the token in this URL is what identifies the
    // recipient, so a shared URL would unsubscribe the wrong person.
    expect(headers['List-Unsubscribe']).toContain(`<${PER_ASK_URL}>`);
    expect(headers['List-Unsubscribe']!.indexOf(`<${PER_ASK_URL}>`)).toBe(0);
  });

  it('getEmailHeaders emits List-Unsubscribe-Post one-click for the solicitation category', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();

    const headers = getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL });

    // RFC 8058 §3: the Post header only functions alongside an HTTPS member,
    // which the branch above guarantees by throwing without one.
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('getEmailHeaders includes the SOLICITATION_UNSUBSCRIBE_MAILTO member for the solicitation category', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();

    const headers = getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL });

    // One advertised address reached by two code paths — the header and the
    // Neutral page (#644 §5.4). A mismatch is a compliance defect.
    expect(headers['List-Unsubscribe']).toContain(`<mailto:${SOLICITATION_MAILBOX}>`);
    // And never the transactional lane's mailbox.
    expect(headers['List-Unsubscribe']).not.toContain('notifications@repworth.example');
  });

  it('getEmailHeaders throws for the solicitation category when no unsubscribe URL is supplied', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();

    // Fail closed. The marketing branch degrades to mailto-only; this one may
    // not, because the degraded form is a silent compliance violation.
    expect(() => getEmailHeaders('solicitation')).toThrow(/unsubscribeUrl/i);
    expect(() => getEmailHeaders('solicitation', { unsubscribeUrl: '   ' })).toThrow(
      /unsubscribeUrl/i,
    );
  });

  it('getEmailHeaders throws for the solicitation category when the unsubscribe URL is not HTTPS', async () => {
    const { getEmailHeaders } = await freshEmailHeaders();

    for (const bad of [
      'http://worker.test.repworth.net/u/tok',
      'javascript:alert(1)',
      'mailto:someone@example.test',
      'not a url',
    ]) {
      expect(() => getEmailHeaders('solicitation', { unsubscribeUrl: bad })).toThrow(/https/i);
    }
  });

  it('getEmailHeaders never falls back to LIST_UNSUBSCRIBE_URL for the solicitation category', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = GLOBAL_MARKETING_URL;
    const { getEmailHeaders } = await freshEmailHeaders();

    // With a per-ask URL present the global one must not appear at all...
    const headers = getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL });
    expect(headers['List-Unsubscribe']).not.toContain(GLOBAL_MARKETING_URL);

    // ...and without one, the configured global URL is NOT a substitute. It
    // unsubscribes from owner reports, not from this recipient's asks.
    expect(() => getEmailHeaders('solicitation')).toThrow();
  });

  it('getEmailHeaders never falls back to the example.com mailbox for the solicitation category', async () => {
    delete process.env.SOLICITATION_UNSUBSCRIBE_MAILTO;
    delete process.env.RESEND_FROM_EMAIL;
    const { getEmailHeaders } = await freshEmailHeaders();

    // The marketing branch warns and ships the RFC 2606 reserved address. Doing
    // that here would advertise an opt-out mailbox nobody reads.
    expect(() =>
      getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL }),
    ).toThrow(/SOLICITATION_UNSUBSCRIBE_MAILTO/);

    let emitted: Record<string, string> | undefined;
    try {
      emitted = getEmailHeaders('solicitation', { unsubscribeUrl: PER_ASK_URL });
    } catch {
      emitted = undefined;
    }
    expect(emitted).toBeUndefined();
  });
});

describe('getEmailTags — solicitation category', () => {
  it('getEmailTags returns the solicitation category tag', async () => {
    const { getEmailTags } = await freshEmailHeaders();

    // Generic over EmailCategory already — this pins that the new member flows
    // through untouched, so the Resend dashboard can split the two lanes.
    expect(getEmailTags('solicitation')).toEqual([
      { name: 'category', value: 'solicitation' },
    ]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Resend } from 'resend';

// EmailAdapter — the first Messaging adapter (#657 Task 5, spec §7.1). RED until
// `src/lib/messaging/email-adapter.ts` exists.
//
// Envelope tests against a fake Resend client, mirroring how
// src/lib/notifications/email/__tests__/send-email.test.ts fakes the SDK. The
// fake is passed THROUGH the real `sendEmail`, so these cases prove the whole
// path — envelope construction, the injected client, the timeout owner and the
// idempotency key — rather than a re-implementation of it.
//
// Six of these cases are header injection. Business name, subject, recipient and
// Reply-To are all owner- or LLM-supplied text that lands in SMTP headers.

const { getSolicitationResendSpy, getResendSpy } = vi.hoisted(() => ({
  getSolicitationResendSpy: vi.fn(),
  getResendSpy: vi.fn(),
}));

vi.mock('@/lib/notifications/email/client', () => ({
  getSolicitationResend: getSolicitationResendSpy,
  getResend: getResendSpy,
}));

import { EmailAdapter } from '../email-adapter';
import type { OutboundMessage } from '../messaging-adapter';
import { resetServerConfigForTests } from '@/lib/config/server';

const FROM_ADDRESS = 'reviews@feedback.test.repworth.net';
const UNSUBSCRIBE_MAILBOX = 'unsubscribe@feedback.test.repworth.net';
const UNSUBSCRIBE_URL = 'https://worker.test.repworth.net/u/tok_657_adapter';

/** Only the members `sendEmail` and these cases ever touch. */
interface FakeResend {
  lastPayload?: Record<string, unknown>;
  lastOptions?: Record<string, unknown>;
  sendCalls: number;
  batchCalls: number;
  emails: { send: (payload: unknown, options?: unknown) => Promise<unknown> };
  batch: { send: (payload: unknown, options?: unknown) => Promise<unknown> };
}

function fakeResend(result: unknown = { data: { id: 'msg_657_provider' }, error: null }): FakeResend {
  const client: FakeResend = {
    sendCalls: 0,
    batchCalls: 0,
    emails: {
      send: (payload, options) => {
        client.sendCalls += 1;
        client.lastPayload = payload as Record<string, unknown>;
        client.lastOptions = options as Record<string, unknown> | undefined;
        return Promise.resolve(result);
      },
    },
    batch: {
      send: () => {
        client.batchCalls += 1;
        return Promise.resolve(result);
      },
    },
  };
  return client;
}

/**
 * The Resend SDK type has a large surface; the adapter only ever reaches
 * `emails.send`, so the fake is narrowed and cast at the seam — `as unknown as`
 * rather than `any` (house rule).
 */
function adapterFor(client: FakeResend): EmailAdapter {
  return new EmailAdapter(() => client as unknown as Resend);
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outreachId: '0198f0c0-0000-7000-8000-000000000657',
    accountId: '0198f0c0-0000-7000-8000-0000000000ac',
    businessId: '0198f0c0-0000-7000-8000-0000000000b1',
    batchId: '0198f0c0-0000-7000-8000-0000000000ba',
    businessName: 'Bright Smile Dental',
    ownerEmail: 'owner@brightsmile.test',
    recipient: 'customer@example.test',
    subject: 'How did we do?',
    bodyHtml: '<p>Would you mind leaving a review?</p>',
    bodyText: 'Would you mind leaving a review?',
    unsubscribeUrl: UNSUBSCRIBE_URL,
    ...overrides,
  };
}

function headersOf(client: FakeResend): Record<string, string> {
  return (client.lastPayload?.headers ?? {}) as Record<string, string>;
}

function tagsOf(client: FakeResend): Array<{ name: string; value: string }> {
  return (client.lastPayload?.tags ?? []) as Array<{ name: string; value: string }>;
}

describe('EmailAdapter — the §7.1 envelope', () => {
  const KEYS = [
    'SOLICITATION_SEND_FROM_ADDRESS',
    'SOLICITATION_UNSUBSCRIBE_MAILTO',
    'EMAIL_SEND_TIMEOUT_MS',
  ] as const;
  const SNAP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      SNAP[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SOLICITATION_SEND_FROM_ADDRESS = FROM_ADDRESS;
    process.env.SOLICITATION_UNSUBSCRIBE_MAILTO = UNSUBSCRIBE_MAILBOX;
    resetServerConfigForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k];
      else process.env[k] = SNAP[k];
    }
    resetServerConfigForTests();
  });

  it('the email adapter sends from SOLICITATION_SEND_FROM_ADDRESS with the business name as the display name', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message());

    // The Sending identity's mailbox, the business's name. The recipient sees
    // the business they visited, not a platform they never heard of (§2.3).
    expect(client.lastPayload?.from).toBe(`"Bright Smile Dental" <${FROM_ADDRESS}>`);
  });

  it('the email adapter emits no via-RepWorth suffix in the From display name', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message());

    // DKIM d= alignment on feedback.<env>.repworth.net suppresses Gmail's "via"
    // annotation, so the line renders as purely the business. Adding the suffix
    // ourselves would re-introduce what the sending domain exists to remove.
    const from = String(client.lastPayload?.from);
    expect(from).not.toMatch(/via\s+RepWorth/i);
    // The display name is the business name and NOTHING else. Asserted on the
    // display-name half only — the sending domain legitimately carries the
    // platform name, and a blanket /repworth/ check would fail on the address.
    const displayName = from.slice(0, from.lastIndexOf(' <'));
    expect(displayName).toBe('"Bright Smile Dental"');
  });

  it('the email adapter sets Reply-To to the owner email', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message({ ownerEmail: 'owner@brightsmile.test' }));

    // A reply goes to the business, not to a monitored platform mailbox (§2.4).
    expect(client.lastPayload?.replyTo).toBe('owner@brightsmile.test');
  });

  it('the email adapter sends exactly one recipient per message', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message({ recipient: 'solo@example.test' }));

    expect(client.lastPayload?.to).toEqual(['solo@example.test']);
    expect(client.sendCalls).toBe(1);
  });

  it('the email adapter refuses to send to more than one recipient', async () => {
    const client = fakeResend();

    // "Exactly one recipient" is a RULE, not a shape: wrapping a string in an
    // array does not enforce it. Whitespace separates two mailboxes just as
    // effectively as a comma.
    await expect(
      adapterFor(client).send(message({ recipient: 'one@x.test two@y.test' })),
    ).rejects.toThrow(/recipient/i);
    expect(client.sendCalls).toBe(0);
  });

  it('the email adapter always sends an HTML and a plain-text part', async () => {
    const client = fakeResend();

    await adapterFor(client).send(
      message({ bodyHtml: '<p>hello</p>', bodyText: 'hello' }),
    );

    expect(client.lastPayload?.html).toBe('<p>hello</p>');
    expect(client.lastPayload?.text).toBe('hello');
  });

  it('the email adapter refuses to send without a plain-text part', async () => {
    const client = fakeResend();

    // HTML-only is a spam signal (§7.1). Silently sending one would degrade
    // deliverability for every later ask on this domain.
    await expect(adapterFor(client).send(message({ bodyText: '   ' }))).rejects.toThrow(
      /plain-text/i,
    );
    expect(client.sendCalls).toBe(0);
  });

  it('the email adapter uses the outreach row id as the idempotency key', async () => {
    const client = fakeResend();
    const outreachId = '0198f0c0-0000-7000-8000-00000000dead';

    await adapterFor(client).send(message({ outreachId }));

    // Amendments A/B: §7.1's `solicitation-ask/<ask_id>` collides across
    // attempts, and a timeout-retry is a ROUTINE path here, not an edge.
    expect(client.lastOptions).toEqual({ idempotencyKey: outreachId });
  });

  it('the email adapter emits the lane, account_id, business_id and batch_id tags', async () => {
    const client = fakeResend();
    const msg = message();

    await adapterFor(client).send(msg);

    const tags = new Map(tagsOf(client).map((tag) => [tag.name, tag.value]));
    // `lane` is the routing discriminant the Solicitation lane reads BEFORE any
    // DB lookup (§5.2) — without it every webhook event for this send lands in
    // the notification_deliveries path.
    expect(tags.get('lane')).toBe('solicitation');
    expect(tags.get('account_id')).toBe(msg.accountId);
    expect(tags.get('business_id')).toBe(msg.businessId);
    expect(tags.get('batch_id')).toBe(msg.batchId);
    expect(tags.get('category')).toBe('solicitation');
  });

  it('the email adapter emits no Precedence bulk header', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message());

    // A solicitation is a one-to-one message to a customer of that business.
    // `Precedence: bulk` tells the mailbox provider otherwise and suppresses
    // auto-replies the owner may actually want.
    const headerNames = Object.keys(headersOf(client)).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('precedence');
  });

  it('the email adapter emits no Auto-Submitted header', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message());

    const headerNames = Object.keys(headersOf(client)).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('auto-submitted');
    // The List-Unsubscribe pair IS expected — this is the compliance header set,
    // not an empty one.
    expect(headersOf(client)['List-Unsubscribe']).toContain(UNSUBSCRIBE_URL);
  });

  it('the email adapter sends through the solicitation Resend client, never the transactional one', async () => {
    const client = fakeResend();
    getSolicitationResendSpy.mockReturnValue(client as unknown as Resend);

    // The DEFAULT constructor — no injection — is what production uses.
    await new EmailAdapter().send(message());

    expect(getSolicitationResendSpy).toHaveBeenCalled();
    // The whole point of the split identity: a key leaked from this lane cannot
    // forge an approval email.
    expect(getResendSpy).not.toHaveBeenCalled();
    expect(client.sendCalls).toBe(1);
  });

  it('the email adapter never calls resend.batch.send', async () => {
    const client = fakeResend();

    await adapterFor(client).send(message());

    // Batch is atomic — one bad address rejects all 100 — and it contradicts
    // per-child suppression re-validation at each child's own dispatch time.
    expect(client.batchCalls).toBe(0);
    expect(client.sendCalls).toBe(1);
  });

  it('the email adapter propagates a missing unsubscribe URL as a throw rather than sending', async () => {
    const client = fakeResend();

    // getEmailHeaders' fail-closed 'solicitation' branch throws; the adapter
    // must let it out rather than catching and sending a headerless ask.
    await expect(adapterFor(client).send(message({ unsubscribeUrl: '' }))).rejects.toThrow();
    expect(client.sendCalls).toBe(0);
  });

  // ── Header injection (plan review round 1, F5/F7 + planning) ──────────────

  it('the email adapter strips CR and LF from the From display name', async () => {
    const client = fakeResend();
    await adapterFor(client).send(
      message({ businessName: "Joe's\r\nBcc: attacker@evil.test" }),
    );
    expect(client.lastPayload?.from).not.toMatch(/[\r\n]/);
  });

  it('the email adapter escapes a double quote in the From display name', async () => {
    const client = fakeResend();
    await adapterFor(client).send(message({ businessName: 'The "Best" Diner' }));
    expect(client.lastPayload?.from).toBe(
      `"The \\"Best\\" Diner" <${FROM_ADDRESS}>`,
    );
  });

  it('the email adapter rejects a recipient containing CR or LF', async () => {
    const client = fakeResend();
    await expect(
      adapterFor(client).send(message({ recipient: 'a@b.test\r\nBcc: c@d.test' })),
    ).rejects.toThrow(/recipient/i);
    expect(client.sendCalls).toBe(0);
  });

  it('the email adapter rejects a subject containing CR or LF', async () => {
    const client = fakeResend();
    await expect(
      adapterFor(client).send(message({ subject: 'Hi\r\nBcc: c@d.test' })),
    ).rejects.toThrow(/subject/i);
    expect(client.sendCalls).toBe(0);
  });

  it('the email adapter rejects a Reply-To value containing CR or LF', async () => {
    const client = fakeResend();
    await expect(
      adapterFor(client).send(message({ ownerEmail: 'o@b.test\r\nBcc: c@d.test' })),
    ).rejects.toThrow(/reply-to/i);
    expect(client.sendCalls).toBe(0);
  });

  it('the email adapter rejects a comma-separated recipient value rather than allowing more than one mailbox', async () => {
    const client = fakeResend();
    await expect(
      adapterFor(client).send(message({ recipient: 'one@x.test, two@y.test' })),
    ).rejects.toThrow(/recipient/i);
    expect(client.sendCalls).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../client', () => ({
  getResend: () => ({ emails: { send: mockSend } }),
}));

import type { Resend } from 'resend';
import { sendEmail, EmailSendTimeoutError } from '../send-email';

describe('sendEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.EMAIL_SEND_TIMEOUT_MS;
  });

  it('passes the payload through to Resend and returns its result on success', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    const payload = { from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' };
    const result = await sendEmail(payload);

    expect(mockSend).toHaveBeenCalledWith(payload, undefined);
    expect(result).toEqual({ data: { id: 'msg-1' }, error: null });
  });

  it('forwards a flat idempotencyKey to Resend as request options', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg-3' }, error: null });

    const payload = { from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' };
    await sendEmail(payload, { idempotencyKey: 'key-1' });

    expect(mockSend).toHaveBeenCalledWith(payload, { idempotencyKey: 'key-1' });
  });

  it('throws EmailSendTimeoutError when the send exceeds the timeout', async () => {
    mockSend.mockReturnValue(new Promise(() => {})); // never resolves

    await expect(
      sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(EmailSendTimeoutError);
  });

  it('does not throw a timeout if the send resolves before the deadline', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg-2' }, error: null });

    const result = await sendEmail(
      { from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' },
      { timeoutMs: 1000 },
    );

    expect(result.data).toEqual({ id: 'msg-2' });
  });
});

// ── #657 Task 4: `opts.client` ────────────────────────────────────────────
//
// RED until sendEmail accepts an injected client. The Sending identity needs its
// own Resend key, and the alternative — a second send function for the
// solicitation lane — would fork the 10s timeout and the idempotency-key
// plumbing this module is the single owner of. These four cases exist to prove
// that neither of those moved.

/**
 * The Resend SDK type has a large surface; sendEmail only ever touches
 * `emails.send`, so the fake is narrowed to that and cast at the seam.
 * `as unknown as` rather than `any` (house rule).
 */
function fakeClient(send: typeof mockSend): Resend {
  return { emails: { send } } as unknown as Resend;
}

describe('sendEmail — solicitation client injection', () => {
  const suppliedSend = vi.fn();
  const payload = { from: 'a@b.com', to: 'c@d.com', subject: 's', html: '<p>x</p>' };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.EMAIL_SEND_TIMEOUT_MS;
  });

  it('sendEmail uses the transactional Resend client when no client is supplied', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg-default' }, error: null });

    const result = await sendEmail(payload);

    // The default path is UNCHANGED — every existing caller keeps the
    // transactional identity without passing anything.
    expect(mockSend).toHaveBeenCalledWith(payload, undefined);
    expect(suppliedSend).not.toHaveBeenCalled();
    expect(result.data).toEqual({ id: 'msg-default' });
  });

  it('sendEmail uses the supplied client when one is passed', async () => {
    suppliedSend.mockResolvedValue({ data: { id: 'msg-solicitation' }, error: null });

    const result = await sendEmail(payload, { client: fakeClient(suppliedSend) });

    expect(suppliedSend).toHaveBeenCalledWith(payload, undefined);
    // The two identities never share a key, so the transactional client must
    // not be touched at all on this path.
    expect(mockSend).not.toHaveBeenCalled();
    expect(result.data).toEqual({ id: 'msg-solicitation' });
  });

  it('sendEmail still applies its timeout when a client is supplied', async () => {
    suppliedSend.mockReturnValue(new Promise(() => {})); // never resolves

    await expect(
      sendEmail(payload, { timeoutMs: 10, client: fakeClient(suppliedSend) }),
    ).rejects.toBeInstanceOf(EmailSendTimeoutError);
  });

  it('sendEmail still forwards the idempotency key when a client is supplied', async () => {
    suppliedSend.mockResolvedValue({ data: { id: 'msg-idem' }, error: null });

    await sendEmail(payload, {
      idempotencyKey: 'outreach-row-id-657',
      client: fakeClient(suppliedSend),
    });

    // The Outreach row id is the idempotency key (amendments A/B), and a
    // timeout-retry is a routine path in the solicitation lane — so this
    // plumbing has to survive the injection, not be re-implemented beside it.
    expect(suppliedSend).toHaveBeenCalledWith(payload, {
      idempotencyKey: 'outreach-row-id-657',
    });
  });
});

// Classification of Resend's three idempotency error codes by sendInternalEmail
// (#1363). The mock replaces the Resend CLIENT, not `sendEmail`, so these cases
// also exercise the real key-to-request-option wiring in `send-email.ts`.
//
// The replay sentinel is asserted as a LITERAL rather than through the exported
// constant on purpose: the intake's operator query
// (`external_message_id LIKE 'idempotent-replay:%'`) depends on the wire format,
// not on the constant's name, so the test must fail if the format ever moves.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('../../client', () => ({ getResend: () => ({ emails: { send: mockSend } }) }));
vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode: () => false }));

import { sendInternalEmail } from '../internal';

const PARAMS = {
  to: 'owner@example.com',
  from: 'noreply@repworth.com',
  subject: 'You have 3 reviews waiting for your approval',
  bodyHtml: '<p>nudge</p>',
  category: 'marketing' as const,
};

const KEY = 'owner_nudge:0199a1b2-c3d4-7000-8000-000000000001';

/** Shape of a Resend `{ data: null, error }` rejection for a given code. */
function resendError(name: string, statusCode: number) {
  return { data: null, error: { name, message: `resend says ${name}`, statusCode } };
}

describe('sendInternalEmail idempotency classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('forwards the idempotency key to Resend as a request option', async () => {
    await sendInternalEmail({ ...PARAMS, idempotencyKey: KEY });
    const call = mockSend.mock.calls[0] as unknown[];
    expect(call[1]).toEqual({ idempotencyKey: KEY });
  });

  it('omits the idempotency key from the Resend request when the caller supplies none', async () => {
    await sendInternalEmail({ ...PARAMS });
    const call = mockSend.mock.calls[0] as unknown[];
    expect(call[1]).toBeUndefined();
  });

  it('treats invalid_idempotent_request as a delivered email and reports an idempotent replay', async () => {
    // Resend answers this when the SAME key arrives with a DIFFERENT body. That
    // is proof the first request was accepted, so the email IS delivered. It is
    // the NORMAL retry path for the day_7 drip and the owner nudge, whose bodies
    // change because createApprovalLink mints a fresh token per attempt.
    mockSend.mockResolvedValue(resendError('invalid_idempotent_request', 409));

    const result = await sendInternalEmail({ ...PARAMS, idempotencyKey: KEY });

    expect(result).toEqual({
      messageId: `idempotent-replay:${KEY}`,
      idempotentReplay: true,
    });
  });

  it('rethrows concurrent_idempotent_requests so the job retries instead of dropping the email', async () => {
    // The first request is still in flight. That is NOT proof of acceptance, so
    // swallowing it would drop a real email.
    mockSend.mockResolvedValue(resendError('concurrent_idempotent_requests', 409));

    await expect(sendInternalEmail({ ...PARAMS, idempotencyKey: KEY })).rejects.toThrow(
      /concurrent_idempotent_requests/,
    );
  });

  it('rethrows invalid_idempotency_key because a malformed key is a programming error', async () => {
    mockSend.mockResolvedValue(resendError('invalid_idempotency_key', 400));

    await expect(sendInternalEmail({ ...PARAMS, idempotencyKey: KEY })).rejects.toThrow(
      /invalid_idempotency_key/,
    );
  });

  it('keeps throwing on an ordinary Resend error when an idempotency key was supplied', async () => {
    mockSend.mockResolvedValue(resendError('rate_limit_exceeded', 429));

    await expect(sendInternalEmail({ ...PARAMS, idempotencyKey: KEY })).rejects.toThrow(
      /rate_limit_exceeded/,
    );
  });

  it('throws on invalid_idempotent_request when no idempotency key was supplied', async () => {
    // That code cannot arise without a key, so seeing it here means a provider or
    // plumbing fault. Reporting a delivery we never made would hide it.
    mockSend.mockResolvedValue(resendError('invalid_idempotent_request', 409));

    await expect(sendInternalEmail({ ...PARAMS })).rejects.toThrow(/invalid_idempotent_request/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../client', () => ({
  getResend: () => ({ emails: { send: mockSend } }),
}));

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

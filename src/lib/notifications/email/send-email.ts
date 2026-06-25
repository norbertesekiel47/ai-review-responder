// Single sanctioned Resend send path. Every email send goes through here so a
// hung Resend request cannot head-of-line-block the concurrency-1 notification
// worker (the approval rail AND the auto-post FYI rail). The Resend SDK exposes
// no AbortSignal on emails.send, so we bound it with a Promise.race timeout: the
// awaiter stops waiting and the queue slot frees; any orphaned fetch completes on
// its own. Throws on timeout, matching existing throw-on-error call-site handling
// (→ BullMQ retry). This is also the future home for an outbound token-bucket.
import { getServerConfig } from '@/lib/config/server';
import { getResend } from './client';

type ResendEmails = ReturnType<typeof getResend>['emails'];
type SendPayload = Parameters<ResendEmails['send']>[0];
type SendResult = Awaited<ReturnType<ResendEmails['send']>>;

const DEFAULT_EMAIL_SEND_TIMEOUT_MS = 10_000;

export class EmailSendTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Resend send exceeded ${timeoutMs}ms timeout`);
    this.name = 'EmailSendTimeoutError';
  }
}

function resolveTimeoutMs(): number {
  const raw = getServerConfig().EMAIL_SEND_TIMEOUT_MS;
  if (!raw) return DEFAULT_EMAIL_SEND_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMAIL_SEND_TIMEOUT_MS;
}

export async function sendEmail(
  payload: SendPayload,
  opts: { timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
  const resend = getResend();
  // A stable idempotency key lets a timeout-retry or failover re-send of the same
  // logical email dedupe at Resend instead of double-sending. The Resend SDK's
  // request-options shape stays hidden here — callers pass a flat key.
  const requestOptions = opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EmailSendTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([resend.emails.send(payload, requestOptions), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

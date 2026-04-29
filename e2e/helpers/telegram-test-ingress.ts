// e2e/helpers/telegram-test-ingress.ts
//
// Synthesizes a valid Telegram /start <token> webhook update and POSTs it to
// the worker's ingress endpoint. Used by owner-channels.spec.ts to simulate
// the verification webhook that flips a pending_verification row to verified.
//
// Requires TELEGRAM_WEBHOOK_SECRET + WORKER_PUBLIC_URL in the test env.
//
// update_id and message_id default to a monotonic per-process counter combined
// with Date.now() so two simulate calls in the same test run can't collide
// with each other or with prior CI runs against the same `inbound_events`
// dedup table (the worker dedups on `tg:${update_id}`). Callers can override
// with explicit ids when they need deterministic dedup-collision testing.

interface SimulateOptions {
  rawToken: string;
  chatId?: number;
  workerBaseUrl?: string;
  updateId?: number;
  messageId?: number;
}

let counter = 0;
function nextId(): number {
  counter = (counter + 1) % 1_000_000;
  // Date.now() * 1e6 + counter — comfortably under 2^53 for the next ~285 years.
  return Date.now() * 1_000_000 + counter;
}

export async function simulateTelegramStart(opts: SimulateOptions): Promise<Response> {
  const workerBase = opts.workerBaseUrl ?? process.env.WORKER_PUBLIC_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!workerBase) throw new Error('WORKER_PUBLIC_URL required for telegram test ingress');
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET required for telegram test ingress');

  const update_id = opts.updateId ?? nextId();
  const message_id = opts.messageId ?? nextId();

  const update = {
    update_id,
    message: {
      message_id,
      from: {
        id: opts.chatId ?? 5_555_550_123,
        is_bot: false,
        first_name: 'Test',
        username: 'test_owner',
      },
      chat: {
        id: opts.chatId ?? 5_555_550_123,
        type: 'private',
        first_name: 'Test',
      },
      date: Math.floor(Date.now() / 1000),
      text: `/start ${opts.rawToken}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  };

  return fetch(`${workerBase.replace(/\/$/, '')}/ingress/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
}

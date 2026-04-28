// e2e/helpers/telegram-test-ingress.ts
//
// Synthesizes a valid Telegram /start <token> webhook update and POSTs it to
// the worker's ingress endpoint. Used by owner-channels.spec.ts to simulate
// the verification webhook that flips a pending_verification row to verified.
//
// Requires TELEGRAM_WEBHOOK_SECRET + WORKER_PUBLIC_URL in the test env.

interface SimulateOptions {
  rawToken: string;
  chatId?: number;
  workerBaseUrl?: string;
}

export async function simulateTelegramStart(opts: SimulateOptions): Promise<Response> {
  const workerBase = opts.workerBaseUrl ?? process.env.WORKER_PUBLIC_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!workerBase) throw new Error('WORKER_PUBLIC_URL required for telegram test ingress');
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET required for telegram test ingress');

  const update = {
    update_id: Math.floor(Math.random() * 1_000_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
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

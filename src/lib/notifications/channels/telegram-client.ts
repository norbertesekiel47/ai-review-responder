// src/lib/notifications/channels/telegram-client.ts
//
// Thin fetch wrapper over the Telegram Bot API. Only the 4 methods we use.
// Typed error classes let callers (TelegramChannel, the ingress handler) do
// pattern matching without parsing Telegram's description strings twice.

export class TelegramRecipientBlockedError extends Error {
  constructor() { super('telegram_recipient_blocked'); this.name = 'TelegramRecipientBlockedError'; }
}

export class TelegramChatNotFoundError extends Error {
  constructor() { super('telegram_chat_not_found'); this.name = 'TelegramChatNotFoundError'; }
}

export class TelegramRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`telegram_rate_limited retry_after=${retryAfterSeconds}`);
    this.name = 'TelegramRateLimitError';
  }
}

export class TelegramApiError extends Error {
  constructor(public readonly errorCode: number, public readonly description: string) {
    super(`telegram_api_error code=${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface SendMessageParams {
  chat_id: string;
  text: string;
  reply_markup?: unknown;
  parse_mode?: 'HTML' | 'Markdown';
  disable_web_page_preview?: boolean;
}

interface SendMessageResult {
  message_id: number;
  chat: { id: number };
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(botToken: string = process.env.TELEGRAM_BOT_TOKEN ?? '') {
    if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    // M4: bound the fetch at 10s so a hung Bot API call cannot stall the
    // BullMQ worker (or exceed Telegram's 30s webhook timeout when called
    // from an ingress handler). On abort we throw TelegramApiError so the
    // failure funnels through the same typed-error contract as other
    // network errors.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        throw new TelegramApiError(0, `telegram_timeout: ${method}`);
      }
      throw new TelegramApiError(0, `telegram_network_error: ${(err as Error).message ?? 'unknown'}`);
    }
    clearTimeout(timeout);
    let payload: TelegramResponse<T>;
    try {
      payload = (await res.json()) as TelegramResponse<T>;
    } catch {
      throw new TelegramApiError(res.status, `non-json response (status ${res.status})`);
    }
    if (payload.ok && payload.result !== undefined) return payload.result;
    const code = payload.error_code ?? res.status;
    const desc = payload.description ?? 'unknown telegram error';
    if (code === 403 && /blocked/i.test(desc)) throw new TelegramRecipientBlockedError();
    if (code === 400 && /chat not found/i.test(desc)) throw new TelegramChatNotFoundError();
    if (code === 429) {
      const retry = payload.parameters?.retry_after ?? 1;
      throw new TelegramRateLimitError(retry);
    }
    throw new TelegramApiError(code, desc);
  }

  async sendMessage(p: SendMessageParams): Promise<SendMessageResult> {
    return this.call<SendMessageResult>('sendMessage', {
      chat_id: p.chat_id,
      text: p.text,
      parse_mode: p.parse_mode ?? 'HTML',
      disable_web_page_preview: p.disable_web_page_preview ?? true,
      reply_markup: p.reply_markup,
    });
  }

  async editMessageText(p: {
    chat_id: string;
    message_id: number;
    text: string;
    reply_markup?: { inline_keyboard: unknown[][] };
  }): Promise<boolean> {
    // Telegram's editMessageText preserves the existing reply_markup when the
    // field is omitted from the request. To strip stale buttons on the same
    // round-trip, callers must pass reply_markup explicitly — we default to an
    // empty inline_keyboard so buttons are removed unless the caller provides
    // a replacement set.
    return this.call<boolean>('editMessageText', {
      chat_id: p.chat_id,
      message_id: p.message_id,
      text: p.text,
      parse_mode: 'HTML',
      reply_markup: p.reply_markup ?? { inline_keyboard: [] },
    });
  }

  async editMessageReplyMarkup(p: { chat_id: string; message_id: number; reply_markup: { inline_keyboard: unknown[][] } }): Promise<boolean> {
    return this.call<boolean>('editMessageReplyMarkup', {
      chat_id: p.chat_id,
      message_id: p.message_id,
      reply_markup: p.reply_markup,
    });
  }

  async answerCallbackQuery(p: { callback_query_id: string; text?: string }): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: p.callback_query_id,
      text: p.text,
    });
  }
}

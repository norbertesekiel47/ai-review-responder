import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelegramClient,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  TelegramRateLimitError,
  TelegramApiError,
} from '../telegram-client';

describe('TelegramClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  it('sendMessage calls correct URL with token and returns message_id on success', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 123 } } }),
        { status: 200 }),
    );
    const client = new TelegramClient();
    const result = await client.sendMessage({ chat_id: '123', text: 'hi' });
    expect(result.message_id).toBe(42);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps 403 bot_blocked to TelegramRecipientBlockedError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
        { status: 403 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toBeInstanceOf(TelegramRecipientBlockedError);
  });

  it('maps 400 chat not found to TelegramChatNotFoundError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
        { status: 400 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toBeInstanceOf(TelegramChatNotFoundError);
  });

  it('maps 429 with retry_after to TelegramRateLimitError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } }),
        { status: 429 }),
    );
    const client = new TelegramClient();
    try {
      await client.sendMessage({ chat_id: '1', text: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramRateLimitError);
      expect((err as TelegramRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it('maps other errors to TelegramApiError with description', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal server error' }),
        { status: 500 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toThrow(/Internal server error/);
  });

  it('editMessageReplyMarkup posts with empty keyboard correctly', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const client = new TelegramClient();
    await client.editMessageReplyMarkup({ chat_id: '1', message_id: 99, reply_markup: { inline_keyboard: [] } });
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.reply_markup.inline_keyboard).toEqual([]);
  });

  it('answerCallbackQuery accepts optional text', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const client = new TelegramClient();
    await client.answerCallbackQuery({ callback_query_id: 'cb1', text: 'Approving…' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.callback_query_id).toBe('cb1');
    expect(body.text).toBe('Approving…');
  });
});

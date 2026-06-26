import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

import {
  WhatsAppClient,
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
  WhatsAppApiError,
} from '../whatsapp-client';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

const RAW_TOKEN = 'TOKEN_FOR_LEAK_DETECTION';

const baseSendParams = {
  to: 'whatsapp:+15551234567',
  contentSid: 'HX_test',
  contentVariables: { '9': RAW_TOKEN },
  statusCallback: 'https://example.com/ingress/twilio/whatsapp-status',
};

describe('WhatsAppClient.sendTemplate error classification', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCreate.mockReset();
    // WhatsAppClient.client()/sendTemplate now read TWILIO_* via the memoized
    // getWorkerConfig() — reset the memo so each send re-parses (convention #6).
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'auth_test';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    resetWorkerConfigForTests();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function assertNoTokenLeak() {
    for (const spy of [logSpy, errSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        const serialized = call.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        expect(serialized).not.toContain(RAW_TOKEN);
      }
    }
  }

  it('returns external message id on success', async () => {
    mockCreate.mockResolvedValueOnce({ sid: 'SM_abc' });
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .resolves.toEqual({ externalMessageId: 'SM_abc' });
    assertNoTokenLeak();
  });

  it('classifies Twilio 63014 as recipient blocked', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 63014 }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppRecipientBlockedError);
    assertNoTokenLeak();
  });

  it('classifies Twilio 63033 as recipient blocked', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('opted out'), { code: 63033 }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppRecipientBlockedError);
    assertNoTokenLeak();
  });

  it('classifies 63024, 21211, 21408 as invalid recipient', async () => {
    for (const code of [63024, 21211, 21408]) {
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('bad number'), { code }));
      const client = new WhatsAppClient();
      await expect(client.sendTemplate(baseSendParams))
        .rejects.toBeInstanceOf(WhatsAppInvalidRecipientError);
    }
    assertNoTokenLeak();
  });

  it('classifies 63040, 63041, 63042, 63027, 63028 as template config error', async () => {
    for (const code of [63040, 63041, 63042, 63027, 63028]) {
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('template'), { code }));
      const client = new WhatsAppClient();
      await expect(client.sendTemplate(baseSendParams))
        .rejects.toBeInstanceOf(WhatsAppTemplateConfigError);
    }
    assertNoTokenLeak();
  });

  it('classifies 63016 as session-window error', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('window'), { code: 63016 }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppSessionWindowError);
    assertNoTokenLeak();
  });

  it('classifies 429 / 63017 / 63018 as rate limit', async () => {
    for (const code of [429, 63017, 63018]) {
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('rate'), { code }));
      const client = new WhatsAppClient();
      await expect(client.sendTemplate(baseSendParams))
        .rejects.toBeInstanceOf(WhatsAppRateLimitError);
    }
    assertNoTokenLeak();
  });

  it('classifies AbortError as timeout', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppTimeoutError);
    assertNoTokenLeak();
  });

  it('classifies ETIMEDOUT as timeout', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppTimeoutError);
    assertNoTokenLeak();
  });

  it('classifies unknown codes as generic WhatsAppApiError', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('who knows'), { code: 99999 }));
    const client = new WhatsAppClient();
    await expect(client.sendTemplate(baseSendParams))
      .rejects.toBeInstanceOf(WhatsAppApiError);
    assertNoTokenLeak();
  });
});

describe('WhatsAppClient.sendFreeform', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'auth_test';
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+14155238886';
    resetWorkerConfigForTests();
  });

  it('sends a freeform body and returns external message id', async () => {
    mockCreate.mockResolvedValueOnce({ sid: 'SM_freeform' });
    const client = new WhatsAppClient();
    await expect(client.sendFreeform({ to: 'whatsapp:+15551234567', body: 'Hi' }))
      .resolves.toEqual({ externalMessageId: 'SM_freeform' });
  });

  it('propagates typed errors from the classifier', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 63014 }));
    const client = new WhatsAppClient();
    await expect(client.sendFreeform({ to: 'whatsapp:+15551234567', body: 'Hi' }))
      .rejects.toBeInstanceOf(WhatsAppRecipientBlockedError);
  });
});

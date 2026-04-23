// src/lib/notifications/channels/whatsapp-client.ts
//
// Thin wrapper around the existing `twilio` SDK for WhatsApp sends. Lazy env
// reads (inside methods, not at module scope) so the module is import-safe
// when the WA flag is off (Phase 3 spec §2.0 rule 2). Explicit 10s timeout +
// autoRetry: false because the ingress layer does inline free-form
// confirmation sends — a hung Twilio call would stall ingress processing.
//
// Error classification per docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md §1.2.

import twilio from 'twilio';

export class WhatsAppRecipientBlockedError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`whatsapp_blocked:${code}`);
    this.name = 'WhatsAppRecipientBlockedError';
    this.code = code;
  }
}

export class WhatsAppInvalidRecipientError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`whatsapp_invalid_recipient:${code}`);
    this.name = 'WhatsAppInvalidRecipientError';
    this.code = code;
  }
}

export class WhatsAppTemplateConfigError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`whatsapp_template_config:${code}`);
    this.name = 'WhatsAppTemplateConfigError';
    this.code = code;
  }
}

export class WhatsAppSessionWindowError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`whatsapp_session_window:${code}`);
    this.name = 'WhatsAppSessionWindowError';
    this.code = code;
  }
}

export class WhatsAppRateLimitError extends Error {
  readonly code: number | 'HTTP_429';
  constructor(code: number | 'HTTP_429') {
    super(`whatsapp_rate_limit:${code}`);
    this.name = 'WhatsAppRateLimitError';
    this.code = code;
  }
}

export class WhatsAppTimeoutError extends Error {
  constructor() {
    super('whatsapp_timeout');
    this.name = 'WhatsAppTimeoutError';
  }
}

export class WhatsAppApiError extends Error {
  readonly code: number | string | undefined;
  constructor(code: number | string | undefined, message: string) {
    super(`whatsapp_api_error:${code ?? 'unknown'}:${message}`);
    this.name = 'WhatsAppApiError';
    this.code = code;
  }
}

export interface SendTemplateParams {
  to: string;                                  // 'whatsapp:+1...'
  contentSid: string;
  contentVariables: Record<string, string>;
  statusCallback: string;
}

export interface SendFreeformParams {
  to: string;                                  // 'whatsapp:+1...'
  body: string;
}

const OWNER_INTENT_BLOCKED = new Set<number>([63014, 63033]);
const OWNER_INTENT_INVALID = new Set<number>([63024, 21211, 21408]);
const CONFIG_TEMPLATE = new Set<number>([63040, 63041, 63042, 63027, 63028]);
const CONFIG_SESSION = new Set<number>([63016]);
const TRANSIENT_RATE_LIMIT = new Set<number>([63017, 63018]);

export class WhatsAppClient {
  private client(): ReturnType<typeof twilio> {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
    return twilio(sid, token, { timeout: 10_000, autoRetry: false });
  }

  async sendTemplate(p: SendTemplateParams): Promise<{ externalMessageId: string }> {
    try {
      const msg = await this.client().messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER!,
        to: p.to,
        contentSid: p.contentSid,
        contentVariables: JSON.stringify(p.contentVariables),
        statusCallback: p.statusCallback,
      });
      return { externalMessageId: msg.sid };
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  async sendFreeform(p: SendFreeformParams): Promise<{ externalMessageId: string }> {
    try {
      const msg = await this.client().messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER!,
        to: p.to,
        body: p.body,
      });
      return { externalMessageId: msg.sid };
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  private classifyError(err: unknown): Error {
    const e = err as { code?: number | string; name?: string; message?: string; status?: number };

    // Timeout detection first — timeouts may lack a Twilio error code
    if (e?.name === 'AbortError' || e?.code === 'ETIMEDOUT') return new WhatsAppTimeoutError();

    if (typeof e?.code === 'number') {
      const code = e.code;
      if (OWNER_INTENT_BLOCKED.has(code)) return new WhatsAppRecipientBlockedError(code);
      if (OWNER_INTENT_INVALID.has(code)) return new WhatsAppInvalidRecipientError(code);
      if (CONFIG_TEMPLATE.has(code)) return new WhatsAppTemplateConfigError(code);
      if (CONFIG_SESSION.has(code)) return new WhatsAppSessionWindowError(code);
      if (TRANSIENT_RATE_LIMIT.has(code)) return new WhatsAppRateLimitError(code);
      if (code === 429) return new WhatsAppRateLimitError('HTTP_429');
    }
    if (e?.status === 429) return new WhatsAppRateLimitError('HTTP_429');

    return new WhatsAppApiError(e?.code, e?.message ?? 'unknown');
  }
}

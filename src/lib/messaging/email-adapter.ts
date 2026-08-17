// src/lib/messaging/email-adapter.ts
//
// EmailAdapter — the first Messaging adapter (#657, spec §7.1). Owns the whole
// envelope so no caller has to know it: From-line construction, Reply-To, the
// one-recipient rule, the always-multipart rule, Resend tags, List-Unsubscribe
// via getEmailHeaders, the idempotency key, and the Sending identity's client.

import { getServerConfig } from '@/lib/config/server';
import { getSolicitationResend, type getResend } from '@/lib/notifications/email/client';
import { getEmailHeaders, getEmailTags } from '@/lib/notifications/email/headers';
import { sendEmail } from '@/lib/notifications/email/send-email';
import type { MessagingAdapter, OutboundMessage } from './messaging-adapter';

type ResendClient = ReturnType<typeof getResend>;

/** CR/LF in any header-bound field is header injection. Business name, subject
 *  and recipient are all owner- or LLM-supplied text that lands in SMTP headers. */
const CRLF = /[\r\n]/;

export class EmailAdapter implements MessagingAdapter {
  /**
   * The client is resolved per send, not at construction, so building the
   * adapter never requires the key to exist. Tests inject a fake factory.
   */
  constructor(private readonly resolveClient: () => ResendClient = getSolicitationResend) {}

  async send(message: OutboundMessage): Promise<{ providerMessageId: string }> {
    assertSendable(message);

    const headers = getEmailHeaders('solicitation', {
      unsubscribeUrl: message.unsubscribeUrl,
    });

    const result = await sendEmail(
      {
        from: formatFrom(message.businessName, resolveFromAddress()),
        to: [message.recipient],
        replyTo: message.ownerEmail,
        subject: message.subject,
        html: message.bodyHtml,
        text: message.bodyText,
        headers,
        tags: [
          ...getEmailTags('solicitation'),
          // The routing discriminant the Solicitation lane reads (§5.2). Values
          // are ASCII letters/digits/_/- per Resend's tag constraint; UUIDs pass.
          { name: 'lane', value: 'solicitation' },
          { name: 'account_id', value: message.accountId },
          { name: 'business_id', value: message.businessId },
          { name: 'batch_id', value: message.batchId },
        ],
      },
      { idempotencyKey: message.outreachId, client: this.resolveClient() },
    );

    // The Resend SDK returns { data, error } rather than throwing on an API
    // error. Convert to a throw so every failure reaches the caller one way.
    if (result.error || !result.data?.id) {
      throw new Error(
        `Resend refused the solicitation send: ${result.error?.message ?? 'no message id returned'}`,
      );
    }

    return { providerMessageId: result.data.id };
  }
}

function assertSendable(message: OutboundMessage): void {
  if (!message.bodyText.trim()) {
    throw new Error(
      'solicitation send requires a plain-text part — HTML-only is a spam signal (§7.1)',
    );
  }
  // "Exactly one recipient" is a RULE, not a shape. Wrapping one string in an array
  // does not enforce it: 'a@x.test, b@y.test' is one string and two mailboxes.
  const recipient = message.recipient.trim();
  if (!recipient || CRLF.test(recipient) || /[,\s;]/.test(recipient)) {
    throw new Error('solicitation send requires exactly one well-formed recipient (§7.1)');
  }
  if (CRLF.test(message.subject)) {
    throw new Error('solicitation subject may not contain CR or LF');
  }
  // Reply-To is owner-supplied and lands in a header exactly like the others.
  if (!message.ownerEmail.trim() || CRLF.test(message.ownerEmail)) {
    throw new Error('solicitation Reply-To must be a single well-formed address (§2.4)');
  }
}

/**
 * `"Joe's Diner" <reviews@feedback.repworth.net>` — display name is the business
 * name with NO 'via RepWorth' suffix (§2.3). DKIM d= alignment suppresses Gmail's
 * "via" annotation, so the line renders as purely the business.
 *
 * CR/LF are stripped and quotes escaped: the display name is owner-supplied text
 * landing in an SMTP header.
 */
function formatFrom(businessName: string, address: string): string {
  const safe = businessName.replace(/[\r\n]/g, ' ').replace(/(["\\])/g, '\\$1').trim();
  return `"${safe}" <${address}>`;
}

function resolveFromAddress(): string {
  const address = getServerConfig().SOLICITATION_SEND_FROM_ADDRESS?.trim();
  if (!address) {
    throw new Error(
      'SOLICITATION_SEND_FROM_ADDRESS is not set — the solicitation lane cannot send (fail-closed, §9)',
    );
  }
  return address;
}

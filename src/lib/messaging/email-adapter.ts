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
import {
  LANE_TAG_NAME,
  SOLICITATION_LANE_TAG_VALUE,
  type MessagingAdapter,
  type OutboundMessage,
} from './messaging-adapter';

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
    // The RETURNED value is what goes on the wire, so no future edit can
    // validate one string and send another (round-1 review).
    const recipient = assertSendable(message);

    const headers = getEmailHeaders('solicitation', {
      unsubscribeUrl: message.unsubscribeUrl,
    });

    const result = await sendEmail(
      {
        from: formatFrom(message.businessName, resolveFromAddress()),
        to: [recipient],
        replyTo: message.ownerEmail,
        subject: message.subject,
        html: message.bodyHtml,
        text: message.bodyText,
        headers,
        tags: [
          ...getEmailTags('solicitation'),
          // The routing discriminant the Solicitation lane reads (§5.2). Both
          // halves import the constants from messaging-adapter.ts — never spell
          // either one here. Values are ASCII letters/digits/_/- per Resend's
          // tag constraint; UUIDs pass.
          { name: LANE_TAG_NAME, value: SOLICITATION_LANE_TAG_VALUE },
          { name: 'account_id', value: message.accountId },
          { name: 'business_id', value: message.businessId },
          { name: 'batch_id', value: message.batchId },
        ],
      },
      { idempotencyKey: message.outreachId, client: this.resolveClient() },
    );

    // The Resend SDK returns { data, error } rather than throwing on an API
    // error. Convert to a throw so every failure reaches the caller one way.
    //
    // The MESSAGE is safe to log: it names the failure and nothing else. Resend's
    // error text is provider-controlled and its validation errors quote the
    // offending field, so it can carry a recipient address — the same rule the
    // Solicitation lane applies to bounce/failure reasons ("stored, never
    // logged"). It rides on `cause`, where #630 can persist it to a COLUMN
    // (solicitation_outreach.provider_error) without the default `err.message`
    // log path carrying it.
    if (result.error) {
      throw new Error('Resend refused the solicitation send', { cause: result.error });
    }
    if (!result.data?.id) {
      throw new Error('Resend accepted the solicitation send but returned no message id');
    }

    return { providerMessageId: result.data.id };
  }
}

/**
 * Validates every header-bound field and RETURNS the recipient that goes on the
 * wire, so the validated value and the sent value cannot drift apart.
 *
 * The recipient is checked RAW — exactly as `subject` and `ownerEmail` are.
 * Checking `message.recipient.trim()` instead let `'a@b.test\r\n'` through: trim
 * erases the trailing CR/LF before either guard sees it, and the UNtrimmed value
 * then reached `to:` with the CR/LF intact (round-1 review).
 */
function assertSendable(message: OutboundMessage): string {
  if (!message.bodyText.trim()) {
    throw new Error(
      'solicitation send requires a plain-text part — HTML-only is a spam signal (§7.1)',
    );
  }
  // "Exactly one recipient" is a RULE, not a shape. Wrapping one string in an array
  // does not enforce it: 'a@x.test, b@y.test' is one string and two mailboxes.
  // `/[,\s;]/` also rejects surrounding whitespace, which is correct: the stored
  // handle is normalizeEmail-normalized, so padding is a defect, not a nicety.
  const recipient = message.recipient;
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

  return recipient;
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

// src/lib/approval/types.ts
//
// Shared type definitions for the approval layer. Lives in its own
// module so locks.ts, audit.ts, and the mode files can import these
// shapes without forming a cycle.

import type { MobileChannel } from '@/lib/channels/mobile-enrollment';

export interface ApprovalLink {
  id: string;
  response_id: string;
  business_id: string;
  token_hash: string;
  channel: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  device_cookie_hash: string | null;
  created_at: Date;
}

// ── Audit context shapes ──────────────────────────────────────────────────

export interface AuditContext {
  tokenHash: string;
  deviceCookieHash: string | null;
  ipAddress: string | null;
}

export interface SessionAuditContext {
  actorUserId: string;
  ipAddress: string | null;
}

interface CallbackAuditContextBase {
  /** Stable provider event identifier — Telegram update_id as string, Twilio MessageSid. */
  providerEventId: string;
  ipAddress: string | null;
}

/**
 * Existing public input union — DO NOT rename. Ingress layers construct
 * values of this type when invoking callback-mode approval.
 */
export type CallbackAuditContext =
  | (CallbackAuditContextBase & {
      /** Telegram-only: numeric update_id stored in metadata.update_id for forensics continuity. */
      telegramUpdateId: number;
      twilioMessageSid?: never;
    })
  | (CallbackAuditContextBase & {
      /** WhatsApp-only: Twilio MessageSid stored in metadata.message_sid. */
      twilioMessageSid: string;
      telegramUpdateId?: never;
    });

/**
 * Return shape of buildCallbackAudit — distinct from the input union above.
 * Named to make the audit/metadata pair explicit at call sites.
 */
export interface CallbackAuditArtifacts {
  audit: AuditContext;
  metadata: Record<string, unknown>;
}

/**
 * Input shape for inline-callback approval (Telegram, WhatsApp button taps).
 * Constructed by ingress layers and consumed by callback-mode +
 * buildCallbackAudit.
 */
export interface CallbackApprovalInput {
  approvalLinkId: string;
  chatHandle: string;
  viaChannel: MobileChannel;
  audit: CallbackAuditContext;
}

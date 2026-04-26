// src/lib/approval/audit.ts
//
// Audit log writers for approval transitions. Three modes share the
// approval_audit_log table but differ in context shape:
//   - token mode    → AuditContext (token hash + device cookie + IP)
//   - session mode  → SessionAuditContext (session-bound, no token hash; auth_method='owner_session')
//   - callback mode → AuditContext (token hash from link) + provider-specific metadata
//
// See approval/service.ts for callers; the buildCallbackAudit helper
// returns the artifacts needed by the callback adapter.

import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';
import type { ApprovalLink } from './types';
import type { CallbackApprovalInput } from './callback-mode';

type TxClient = postgres.TransactionSql;

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

// ── Insert helpers ────────────────────────────────────────────────────────

export async function insertAuditLog(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: AuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata)
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${audit.tokenHash},
      ${audit.deviceCookieHash},
      ${action},
      ${audit.ipAddress},
      ${jsonb(metadata ?? {})}
    )
  `;
}

export async function insertAuditLogSession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: SessionAuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata, actor_user_id, auth_method)
    VALUES (
      ${uuidv7()}, ${responseId}, ${businessId}, ${null}, ${null},
      ${action}, ${audit.ipAddress}, ${jsonb(metadata ?? {})},
      ${audit.actorUserId}, 'owner_session'
    )
  `;
}

// ── Callback audit builder ────────────────────────────────────────────────

export function buildCallbackAudit(
  link: ApprovalLink,
  input: CallbackApprovalInput,
  correlationId: string,
): CallbackAuditArtifacts {
  const chatHandleHash = createHash('sha256').update(input.chatHandle).digest('hex');
  const metadata: Record<string, unknown> = {
    via_channel: input.viaChannel,
    chat_handle_hash: chatHandleHash,
    correlation_id: correlationId,
    // Cross-channel stable identifier — always set regardless of provider.
    // The channel-specific `update_id` / `message_sid` keys below are kept
    // for forensics continuity with historical Telegram queries.
    provider_event_id: input.audit.providerEventId,
  };
  // Preserve the existing Telegram metadata key (`update_id`) so historical
  // audit-log queries continue to match. WhatsApp writes `message_sid` instead.
  // Never both on the same row — discriminated union enforces this at compile time.
  if (input.audit.telegramUpdateId !== undefined) {
    metadata.update_id = input.audit.telegramUpdateId;
  }
  if (input.audit.twilioMessageSid !== undefined) {
    metadata.message_sid = input.audit.twilioMessageSid;
  }
  return {
    audit: {
      tokenHash: link.token_hash,
      deviceCookieHash: null,
      ipAddress: input.audit.ipAddress,
    },
    metadata,
  };
}

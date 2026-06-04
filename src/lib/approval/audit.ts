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
import type {
  ApprovalMethod,
  AutoApprovalThreshold,
  PolicySource,
} from '@/lib/auto-approval/types';
import type { GenerateResponseOriginLane } from '@/lib/shared/worker-types';
import type {
  ApprovalLink,
  CallbackApprovalInput,
  AuditContext,
  SessionAuditContext,
  CallbackAuditArtifacts,
} from './types';

type TxClient = postgres.TransactionSql;

export interface ApprovalContentSnapshot {
  responseTextAtApproval: string;
}

export type AutoPolicyAuditAction =
  | 'auto_approved_by_policy'
  | 'auto_policy_revoked_by_kill_switch';

export interface AutoPolicyAuditMetadata {
  policy_id?: string | null;
  policy_source?: PolicySource;
  threshold?: AutoApprovalThreshold | null;
  resolved_min_star?: AutoApprovalThreshold | null;
  star_rating?: number | null;
  origin_lane?: GenerateResponseOriginLane | null;
  response_version?: number;
  provider_status?: 'clean' | 'error' | null;
  review_content_hash_matched?: boolean;
  publisher_subscription_allowed?: boolean;
  publisher_subscription_reason?: string | null;
  active_zernio_connection?: boolean;
  active_location?: boolean;
  runtime_enabled?: boolean;
  provider_moderation_enabled?: boolean;
  correlation_id?: string;
  downgrade_reason?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

export interface AutoPolicyAuditInput {
  responseId: string;
  businessId: string;
  action?: AutoPolicyAuditAction;
  responseTextAtApproval: string | null;
  metadata?: AutoPolicyAuditMetadata;
}

// Re-export the type shapes so existing `import { AuditContext, ... } from '@/lib/approval/audit'`
// (and the service.ts barrel that does the same) keep resolving.
export type {
  AuditContext,
  SessionAuditContext,
  CallbackAuditArtifacts,
} from './types';

// ── Account ID resolution ───────────────────────────────────────────────
// VAL-APPROVAL-008: Every audit log row includes both business_id (location)
// and account_id (denormalized). account_id is resolved from businesses at
// write time.

async function resolveAccountIdFromBusiness(
  tx: TxClient,
  businessId: string,
): Promise<string> {
  const [row] = await tx<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  return row?.account_id ?? '';
}

const AUTO_POLICY_METADATA_KEYS = [
  'policy_id',
  'policy_source',
  'threshold',
  'resolved_min_star',
  'star_rating',
  'origin_lane',
  'response_version',
  'provider_status',
  'review_content_hash_matched',
  'publisher_subscription_allowed',
  'publisher_subscription_reason',
  'active_zernio_connection',
  'active_location',
  'runtime_enabled',
  'provider_moderation_enabled',
  'correlation_id',
  'downgrade_reason',
  'outbox_id',
  'outbox_attempt',
] as const satisfies readonly (keyof AutoPolicyAuditMetadata)[];

const AUTO_POLICY_AUTH_METHOD: ApprovalMethod = 'auto_policy';

function compactAutoPolicyMetadata(
  metadata: AutoPolicyAuditMetadata | undefined,
): Record<string, unknown> {
  if (!metadata) return {};

  const compact: Record<string, unknown> = {};
  for (const key of AUTO_POLICY_METADATA_KEYS) {
    const value = metadata[key];
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

// ── Insert helpers ────────────────────────────────────────────────────────

export async function insertAuditLog(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: AuditContext,
  metadata?: Record<string, unknown>,
  snapshot?: ApprovalContentSnapshot,
): Promise<void> {
  const accountId = await resolveAccountIdFromBusiness(tx, businessId);
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, account_id, token_hash, device_cookie_hash, action, ip_address, metadata, response_text_at_approval)
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${accountId},
      ${audit.tokenHash},
      ${audit.deviceCookieHash},
      ${action},
      ${audit.ipAddress},
      ${jsonb(metadata ?? {})},
      ${snapshot?.responseTextAtApproval ?? null}
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
  snapshot?: ApprovalContentSnapshot,
): Promise<void> {
  const accountId = await resolveAccountIdFromBusiness(tx, businessId);
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, account_id, token_hash, device_cookie_hash, action, ip_address, metadata, actor_user_id, auth_method, response_text_at_approval)
    VALUES (
      ${uuidv7()}, ${responseId}, ${businessId}, ${accountId}, ${null}, ${null},
      ${action}, ${audit.ipAddress}, ${jsonb(metadata ?? {})},
      ${audit.actorUserId}, 'owner_session', ${snapshot?.responseTextAtApproval ?? null}
    )
  `;
}

export async function insertAuditLogAutoPolicy(
  tx: TxClient,
  input: AutoPolicyAuditInput,
): Promise<void> {
  const action = input.action ?? 'auto_approved_by_policy';
  // The approval action must carry the response snapshot it attests to;
  // downgrade actions (recorded with no text) are exempt.
  if (action === 'auto_approved_by_policy' && input.responseTextAtApproval === null) {
    throw new Error(
      'insertAuditLogAutoPolicy: responseTextAtApproval is required for auto_approved_by_policy rows',
    );
  }
  const accountId = await resolveAccountIdFromBusiness(tx, input.businessId);
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, account_id, token_hash, device_cookie_hash, action, ip_address, metadata, actor_user_id, auth_method, response_text_at_approval)
    VALUES (
      ${uuidv7()},
      ${input.responseId},
      ${input.businessId},
      ${accountId},
      ${null},
      ${null},
      ${action},
      ${null},
      ${jsonb(compactAutoPolicyMetadata(input.metadata))},
      ${null},
      ${AUTO_POLICY_AUTH_METHOD},
      ${input.responseTextAtApproval}
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

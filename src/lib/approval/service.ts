// src/lib/approval/service.ts
//
// Barrel re-export of the modularized approval layer. New code should
// import directly from approval/locks, approval/audit, approval/token-mode,
// approval/session-mode, or approval/callback-mode.
//
// Existing imports from '@/lib/approval/service' continue to resolve.

import {
  insertAuditLog,
  insertAuditLogSession,
  buildCallbackAudit,
  type AuditContext,
  type SessionAuditContext,
  type CallbackAuditContext,
  type CallbackAuditArtifacts,
} from './audit';
import { lockValidLink } from './locks';
import { approve, edit, regenerate } from './token-mode';
import {
  establishApprovalSession,
  approveBySession,
  editBySession,
  regenerateBySession,
} from './session-mode';
import {
  approveViaCallback,
  regenerateViaCallback,
  type CallbackApprovalInput,
} from './callback-mode';
import type { ApprovalLink } from './types';

export {
  insertAuditLog,
  insertAuditLogSession,
  buildCallbackAudit,
  lockValidLink,
  approve,
  edit,
  regenerate,
  establishApprovalSession,
  approveBySession,
  editBySession,
  regenerateBySession,
  approveViaCallback,
  regenerateViaCallback,
};
export type {
  AuditContext,
  SessionAuditContext,
  CallbackAuditContext,
  CallbackAuditArtifacts,
  CallbackApprovalInput,
  ApprovalLink,
};

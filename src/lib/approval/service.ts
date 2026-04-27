// src/lib/approval/service.ts
//
// Barrel re-export of the modularized approval layer. New code should
// import directly from approval/locks, approval/audit, approval/token-mode,
// approval/session-mode, or approval/callback-mode.
//
// Existing imports from '@/lib/approval/service' continue to resolve.

export * from './errors';
export * from './correlation';
export * from './audit';
export * from './locks';
export * from './token-mode';
export * from './session-mode';
export * from './callback-mode';
export type { ApprovalLink } from './types';

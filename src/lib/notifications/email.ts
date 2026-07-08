// src/lib/notifications/email.ts
//
// Barrel re-export of the modularized email layer. New code should import
// directly from email/client, email/headers, or email/templates/<family>.
//
// Existing imports from '@/lib/notifications/email' continue to resolve
// without modification.

export * from './email/client';
export * from './email/headers';
export * from './email/templates/shared';
export * from './email/templates/approval';
export * from './email/templates/auto-post-notice';
export * from './email/templates/escalation-notice';
export * from './email/templates/internal';
export * from './email/templates/weekly-value-report';
export * from './email/templates/monthly-impact';
export * from './email/templates/owner-nudge';
export * from './email/templates/owner-reconnect-required';
export * from './email/templates/owner-connection-lost';
export * from './email/templates/partner-alerts';
export * from './email/templates/onboarding';
export * from './email/templates/account-offboarding';

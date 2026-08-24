// worker/jobs/solicitation-veto-notice/errors.ts
//
// Retryable-vs-terminal classification for the Auto-approval lane's Veto
// notice send (#631). RETRYABLE failures cause the claim to be RELEASED so a
// BullMQ retry can re-acquire and re-send (transient infra: rate limits,
// timeouts, network blips). TERMINAL failures write a failed delivery row
// and are never retried.
//
// Retryability is decided by the single-owner predicate
// `isTransientChannelSendError` — same classifier the pending-post-notice and
// autonomy-suspended-notice families use, so a provider-error taxonomy change
// is made once for every notice family.

import { isTransientChannelSendError } from '../../../src/lib/notifications/channels/transient-send-error';

export interface SolicitationVetoNoticeSendClassification {
  retryable: boolean;
  reason: string;
}

export function classifySolicitationVetoNoticeSendError(
  err: unknown,
): SolicitationVetoNoticeSendClassification {
  const reason = err instanceof Error ? err.message : String(err);
  return { retryable: isTransientChannelSendError(err), reason };
}

import { isTransientChannelSendError } from '@/lib/notifications/channels/transient-send-error';

export interface AutonomySuspendedNoticeSendClassification {
  retryable: boolean;
  reason: string;
}

export function classifyAutonomySuspendedNoticeSendError(
  error: unknown,
): AutonomySuspendedNoticeSendClassification {
  return {
    retryable: isTransientChannelSendError(error),
    reason: error instanceof Error ? error.message : String(error),
  };
}

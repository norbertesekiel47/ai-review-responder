import { createHash } from 'node:crypto';
import type { AccountOffboardingEmailPayload } from '@/lib/shared/worker-types';

const DELIVERY_ID_NAMESPACE = 'repworth:account-offboarding-email:v1';
const EMAIL_IDEMPOTENCY_NAMESPACE = 'repworth:account-offboarding-email-send:v1';

export type AccountOffboardingEmailDeliveryType =
  | AccountOffboardingEmailPayload['email_type']
  | 'purge_receipt';

export function accountOffboardingDeliveryId(
  accountOffboardingId: string,
  emailType: AccountOffboardingEmailDeliveryType,
): string {
  const digest = createHash('sha256')
    .update(`${DELIVERY_ID_NAMESPACE}:${accountOffboardingId}:${emailType}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function accountOffboardingEmailSendIdempotencyKey(deliveryId: string): string {
  return `${EMAIL_IDEMPOTENCY_NAMESPACE}:${deliveryId}`;
}

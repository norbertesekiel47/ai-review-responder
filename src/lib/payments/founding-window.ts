import { getServerConfig } from '@/lib/config/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const FULL_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function parseFoundingDeadline(raw: string | undefined): Date | null {
  const match = raw?.match(FULL_UTC_TIMESTAMP);
  if (!raw || !match) return null;

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;

  const canonicalRoundTrip = parsed.toISOString().replace('.000Z', 'Z');
  return canonicalRoundTrip === raw ? parsed : null;
}

function reportInvalidDeadline(reason: 'missing' | 'malformed'): void {
  reportCaughtError(
    'payments/founding-window',
    new Error('FOUNDING_DEADLINE is missing or malformed; list pricing selected'),
    { reason },
  );
}

/**
 * Founding eligibility is strictly `now < deadline`. Missing or malformed
 * configuration is observable but never throws or grants founding pricing.
 */
export function isFoundingWindowOpen(now: Date = new Date()): boolean {
  const raw = getServerConfig().FOUNDING_DEADLINE;
  const deadline = parseFoundingDeadline(raw);
  if (!deadline) {
    reportInvalidDeadline(raw === undefined ? 'missing' : 'malformed');
    return false;
  }
  return now.getTime() < deadline.getTime();
}

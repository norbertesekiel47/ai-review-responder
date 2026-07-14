import { SubscriptionStatus } from './subscription-status';

const DAY_MS = 86_400_000;
export const PAST_DUE_GRACE_DAYS = 7;
const GRACE_MS = PAST_DUE_GRACE_DAYS * DAY_MS;

// One exact timestamp language for both the canonical TypeScript publisher
// guard and its fleet-scan SQL counterpart: the UTC millisecond form emitted
// by Date.toISOString(). This deliberately rejects offsets and every other
// fractional precision so fixed-width SQL string ordering is chronological.
export const PAST_DUE_EXTENSION_TIMESTAMP_PATTERN =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$';
const pastDueExtensionTimestampRegex = new RegExp(PAST_DUE_EXTENSION_TIMESTAMP_PATTERN);

export interface PastDueExtension {
  days: number;
  expires_at: string;
  reason?: string;
  granted_at?: string;
  granted_by_user_id?: string;
}

export type AccountFlagsInput = Record<string, unknown> | string | null;

export interface ComputePastDueRecoveryInput {
  subscriptionStatus: string;
  pastDueAt: Date | string | null | undefined;
  accountFlags?: AccountFlagsInput;
  now?: Date;
}

export interface PastDueRecoveryState {
  isPastDue: boolean;
  pastDueAt: Date | null;
  deadline: Date | null;
  daysRemaining: number | null;
  isReadOnly: boolean;
  extension: PastDueExtension | null;
}

function parseExtension(
  flags: AccountFlagsInput | undefined,
  now: Date,
): PastDueExtension | null {
  const normalizedFlags = parseAccountFlags(flags);
  const raw = normalizedFlags?.past_due_extension;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const ext = raw as Partial<PastDueExtension>;
  if (typeof ext.days !== 'number' || ext.days <= 0 || ext.days > 30) return null;
  if (typeof ext.expires_at !== 'string') return null;
  if (!isValidPastDueExtensionTimestamp(ext.expires_at)) return null;

  const expiresAt = new Date(ext.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    days: ext.days,
    expires_at: ext.expires_at,
    reason: typeof ext.reason === 'string' ? ext.reason : undefined,
    granted_at: typeof ext.granted_at === 'string' ? ext.granted_at : undefined,
    granted_by_user_id:
      typeof ext.granted_by_user_id === 'string' ? ext.granted_by_user_id : undefined,
  };
}

function isValidPastDueExtensionTimestamp(value: string): boolean {
  if (!pastDueExtensionTimestampRegex.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}

function parseAccountFlags(
  flags: AccountFlagsInput | undefined,
): Record<string, unknown> | null {
  if (!flags) return null;
  if (typeof flags === 'object' && !Array.isArray(flags)) return flags;
  if (typeof flags !== 'string') return null;
  try {
    const parsed = JSON.parse(flags);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function computePastDueRecoveryState(
  input: ComputePastDueRecoveryInput,
): PastDueRecoveryState {
  const now = input.now ?? new Date();
  const isPastDue = input.subscriptionStatus === SubscriptionStatus.PAST_DUE;
  const pastDueAt = input.pastDueAt ? new Date(input.pastDueAt) : null;

  if (!isPastDue) {
    return {
      isPastDue: false,
      pastDueAt: null,
      deadline: null,
      daysRemaining: null,
      isReadOnly: false,
      extension: null,
    };
  }

  if (!pastDueAt || !Number.isFinite(pastDueAt.getTime())) {
    return {
      isPastDue: true,
      pastDueAt: null,
      deadline: null,
      daysRemaining: 0,
      isReadOnly: true,
      extension: null,
    };
  }

  // Clamp a future-dated past_due_at to now. A few seconds of clock skew
  // between Stripe/Postgres and the reader must not deny the grace window,
  // and a garbage far-future value must not grant unbounded grace.
  const effectivePastDueAt = pastDueAt.getTime() > now.getTime() ? now : pastDueAt;

  const extension = parseExtension(input.accountFlags, now);
  const graceDeadline = new Date(effectivePastDueAt.getTime() + GRACE_MS);
  const extensionDeadline = extension ? new Date(extension.expires_at) : null;
  const deadline =
    extensionDeadline && extensionDeadline.getTime() > graceDeadline.getTime()
      ? extensionDeadline
      : graceDeadline;
  const remainingMs = deadline.getTime() - now.getTime();

  return {
    isPastDue: true,
    pastDueAt,
    // Round down so the banner never promises more time than actually remains.
    daysRemaining: Math.max(0, Math.floor(remainingMs / DAY_MS)),
    deadline,
    isReadOnly: remainingMs <= 0,
    extension,
  };
}

import { SubscriptionStatus } from './subscription-status';

const DAY_MS = 86_400_000;
const GRACE_MS = 7 * DAY_MS;

export interface PastDueExtension {
  days: number;
  expires_at: string;
  reason?: string;
  granted_at?: string;
  granted_by_user_id?: string;
}

export interface ComputePastDueRecoveryInput {
  subscriptionStatus: string;
  pastDueAt: Date | string | null | undefined;
  accountFlags?: Record<string, unknown> | string | null;
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
  flags: Record<string, unknown> | string | null | undefined,
  now: Date,
): PastDueExtension | null {
  const normalizedFlags = parseAccountFlags(flags);
  const raw = normalizedFlags?.past_due_extension;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const ext = raw as Partial<PastDueExtension>;
  if (typeof ext.days !== 'number' || ext.days <= 0 || ext.days > 30) return null;
  if (typeof ext.expires_at !== 'string') return null;

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

function parseAccountFlags(
  flags: Record<string, unknown> | string | null | undefined,
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

  if (!isPastDue || !pastDueAt || !Number.isFinite(pastDueAt.getTime())) {
    return {
      isPastDue,
      pastDueAt: null,
      deadline: null,
      daysRemaining: null,
      isReadOnly: false,
      extension: null,
    };
  }

  const extension = parseExtension(input.accountFlags, now);
  const extensionMs = extension ? extension.days * DAY_MS : 0;
  const deadline = new Date(pastDueAt.getTime() + GRACE_MS + extensionMs);
  const remainingMs = deadline.getTime() - now.getTime();

  return {
    isPastDue: true,
    pastDueAt,
    deadline,
    daysRemaining: Math.max(0, Math.ceil(remainingMs / DAY_MS)),
    isReadOnly: remainingMs <= 0,
    extension,
  };
}

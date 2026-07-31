import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// One authoritative status → style mapping for the admin console. Pages never
// hand-pick badge colors (spec §3). Subscription keys come from the const enum;
// outbox terminal statuses have no exported constant owner (the jobs route
// spells them inline), so they are literal keys here, matching that practice.
export const STATUS_BADGE_STYLES: Record<string, string> = {
  [SubscriptionStatus.ACTIVE]: 'bg-green-100 text-green-800',
  [SubscriptionStatus.TRIALING]: 'bg-blue-100 text-blue-800',
  [SubscriptionStatus.PAST_DUE]: 'bg-red-100 text-red-800',
  [SubscriptionStatus.CANCELLED]: 'bg-gray-100 text-gray-700',
  [SubscriptionStatus.PENDING_PAYMENT]: 'bg-amber-100 text-amber-800',
  pending: 'bg-amber-100 text-amber-800',
  dispatching: 'bg-blue-100 text-blue-800',
  dispatched: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

const NEUTRAL = 'bg-gray-100 text-gray-700';

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_BADGE_STYLES[status] ?? NEUTRAL;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
    >
      {status}
    </span>
  );
}

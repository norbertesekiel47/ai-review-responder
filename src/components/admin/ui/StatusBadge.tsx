import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';

// One authoritative status → style mapping for the admin console. Pages never
// hand-pick badge colors (spec §3). Subscription keys come from the const enum
// and outbox in-flight keys from OUTBOX_IN_FLIGHT_STATUSES; only the outbox
// terminal pair (completed/failed) has no exported constant owner (the jobs
// route spells them inline), so those two are literal keys here.
const [OUTBOX_PENDING, OUTBOX_DISPATCHING, OUTBOX_DISPATCHED] = OUTBOX_IN_FLIGHT_STATUSES;

export const STATUS_BADGE_STYLES: Record<string, string> = {
  [SubscriptionStatus.ACTIVE]: 'bg-green-100 text-green-800',
  [SubscriptionStatus.TRIALING]: 'bg-blue-100 text-blue-800',
  [SubscriptionStatus.PAST_DUE]: 'bg-red-100 text-red-800',
  [SubscriptionStatus.CANCELLED]: 'bg-gray-100 text-gray-700',
  [SubscriptionStatus.PENDING_PAYMENT]: 'bg-amber-100 text-amber-800',
  [OUTBOX_PENDING]: 'bg-amber-100 text-amber-800',
  [OUTBOX_DISPATCHING]: 'bg-blue-100 text-blue-800',
  [OUTBOX_DISPATCHED]: 'bg-blue-100 text-blue-800',
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

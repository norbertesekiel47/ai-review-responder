import { SubscriptionStatus, type SubscriptionStatusValue } from '@/lib/shared/subscription-status';
import { SubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';
import type { SuppressionScope, SuppressionSource } from '@/lib/solicitation/suppression';
import type {
  AccountOffboardingMode,
  AccountOffboardingStatus,
} from '@/lib/account-offboarding/types';
import type { MarginRiskLevel } from '@/lib/admin/margin-service';

/**
 * The admin console's ONE status badge — a keyed-vocabulary primitive (X8/X9).
 *
 * RULE: one badge per vocabulary. Every status-like value the console renders
 * (a subscription status, an outbox status, a delivery outcome, a suppression
 * scope…) is a VOCABULARY registered here with a humanized label AND a colour
 * per member. Pages pick the vocabulary; they never pick a colour, never spell
 * a label, and never pass a value the vocabulary does not know. Before this
 * primitive the same `past_due` rendered as raw `past_due` in red, "past due"
 * in gray and "Past due" via a local badge on three pages — the repair is to
 * have nowhere else to put a badge map.
 *
 * Adding a vocabulary: add a key below with `labels` + `styles` keyed on the
 * value's OWN type (the const enum / union its module exports), so a new member
 * upstream is a compile error here rather than a silent grey pill. Do not add a
 * second badge component; the one deliberate peer is `HealthBadge`, which
 * carries a numeric score beside its level.
 *
 * Colour vocabulary (spec §3): green = good/terminal-success, yellow =
 * waiting/attention, red = failed/overdue, blue = in flight (the console's one
 * sanctioned blue — see console-admin-palette.test.ts), gray = neutral/inert.
 * Every colour keeps its text cue: the label is always rendered.
 *
 * Unknown values (a `string`-typed DTO field carrying something newer than this
 * file) fall back to the neutral style with a humanized label and a
 * `data-unmapped` marker so a test — or an operator with devtools — can see the
 * vocabulary is behind, instead of the raw token passing for a design choice.
 */

const GREEN = 'bg-green-100 text-green-800';
const YELLOW = 'bg-yellow-100 text-yellow-800';
const RED = 'bg-red-100 text-red-800';
const BLUE = 'bg-blue-100 text-blue-800';
const GRAY = 'bg-gray-100 text-gray-700';
const INK = 'bg-gray-900 text-white';

interface Vocabulary<V extends string> {
  labels: Record<V, string>;
  styles: Record<V, string>;
}

function vocabulary<V extends string>(v: Vocabulary<V>): Vocabulary<V> {
  return v;
}

const [OUTBOX_PENDING, OUTBOX_DISPATCHING, OUTBOX_DISPATCHED] = OUTBOX_IN_FLIGHT_STATUSES;
type OutboxStatus = (typeof OUTBOX_IN_FLIGHT_STATUSES)[number] | 'completed' | 'failed';

/** Derived on the client from `deliveredAt`/`failedAt` — no DB column owns it. */
export type DeliveryStatus = 'delivered' | 'failed' | 'pending';

/** Demo generation states (`prospect_demos.generation_status`); `running` pulses. */
type DemoGenerationStatus = 'queued' | 'running' | 'completed' | 'failed';

export const STATUS_BADGE_VOCABULARIES = {
  subscription: vocabulary<SubscriptionStatusValue>({
    labels: {
      [SubscriptionStatus.PENDING_PAYMENT]: 'Pending payment',
      [SubscriptionStatus.ACTIVE]: 'Active',
      [SubscriptionStatus.TRIALING]: 'Trialing',
      [SubscriptionStatus.PAST_DUE]: 'Past due',
      [SubscriptionStatus.CANCELLED]: 'Cancelled',
    },
    styles: {
      [SubscriptionStatus.PENDING_PAYMENT]: YELLOW,
      [SubscriptionStatus.ACTIVE]: GREEN,
      [SubscriptionStatus.TRIALING]: BLUE,
      [SubscriptionStatus.PAST_DUE]: RED,
      [SubscriptionStatus.CANCELLED]: GRAY,
    },
  }),
  tier: vocabulary<SubscriptionTierValue>({
    labels: {
      [SubscriptionTier.COPILOT]: 'Copilot',
      [SubscriptionTier.AUTOPILOT]: 'Autopilot',
    },
    styles: {
      [SubscriptionTier.COPILOT]: GRAY,
      [SubscriptionTier.AUTOPILOT]: INK,
    },
  }),
  outbox: vocabulary<OutboxStatus>({
    labels: {
      [OUTBOX_PENDING]: 'Pending',
      [OUTBOX_DISPATCHING]: 'Dispatching',
      [OUTBOX_DISPATCHED]: 'Dispatched',
      completed: 'Completed',
      failed: 'Failed',
    },
    styles: {
      [OUTBOX_PENDING]: YELLOW,
      [OUTBOX_DISPATCHING]: BLUE,
      [OUTBOX_DISPATCHED]: BLUE,
      completed: GREEN,
      failed: RED,
    },
  }),
  delivery: vocabulary<DeliveryStatus>({
    labels: { delivered: 'Delivered', failed: 'Failed', pending: 'Pending' },
    styles: { delivered: GREEN, failed: RED, pending: YELLOW },
  }),
  suppressionScope: vocabulary<SuppressionScope>({
    labels: { global: 'Global', account: 'Account' },
    // Global is the stronger record (it wins a double match — CONTEXT.md), so
    // it reads as ink rather than as one more grey chip.
    styles: { global: INK, account: GRAY },
  }),
  suppressionSource: vocabulary<SuppressionSource>({
    labels: {
      unsubscribe_one_click: 'One-click unsubscribe',
      unsubscribe_link: 'Unsubscribe link',
      bounce_permanent: 'Permanent bounce',
      complaint: 'Complaint',
      provider_suppressed: 'Provider suppressed',
      admin_manual: 'Admin manual',
      owner_manual: 'Owner manual',
    },
    // Provenance, not severity — every source is a legitimate opt-out, so none
    // of them is coloured as a fault.
    styles: {
      unsubscribe_one_click: GRAY,
      unsubscribe_link: GRAY,
      bounce_permanent: GRAY,
      complaint: GRAY,
      provider_suppressed: GRAY,
      admin_manual: GRAY,
      owner_manual: GRAY,
    },
  }),
  offboarding: vocabulary<AccountOffboardingStatus>({
    labels: {
      pending: 'Pending',
      scheduled: 'Scheduled',
      tearing_down: 'Tearing down',
      purge_scheduled: 'Purge scheduled',
      purged: 'Purged',
      churned: 'Churned',
      reactivated: 'Reactivated',
      failed: 'Failed',
    },
    styles: {
      pending: YELLOW,
      scheduled: GRAY,
      tearing_down: BLUE,
      purge_scheduled: GRAY,
      purged: GRAY,
      churned: GRAY,
      reactivated: GREEN,
      failed: RED,
    },
  }),
  offboardingMode: vocabulary<AccountOffboardingMode>({
    labels: { cancel_only: 'Cancel only', delete_data: 'Delete data' },
    styles: { cancel_only: GRAY, delete_data: 'bg-gray-200 text-gray-900' },
  }),
  demo: vocabulary<DemoGenerationStatus>({
    labels: { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' },
    styles: { queued: GRAY, running: `${YELLOW} animate-pulse`, completed: GREEN, failed: RED },
  }),
  marginRisk: vocabulary<MarginRiskLevel>({
    labels: { none: 'OK', warning: 'Warning', action: 'Action' },
    styles: { none: GREEN, warning: YELLOW, action: RED },
  }),
} as const;

export type StatusVocabulary = keyof typeof STATUS_BADGE_VOCABULARIES;

/** Neutral fallback for a value the vocabulary does not (yet) know. */
const NEUTRAL = GRAY;

/** `some_raw_token` → `Some raw token`; the fallback label, never the primary one. */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? '—' : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function lookup(vocab: StatusVocabulary): Vocabulary<string> {
  return STATUS_BADGE_VOCABULARIES[vocab] as Vocabulary<string>;
}

function isKnown(vocab: Vocabulary<string>, value: string): boolean {
  return Object.prototype.hasOwnProperty.call(vocab.labels, value);
}

interface StatusBadgeProps {
  vocab: StatusVocabulary;
  /**
   * The raw stored value. Typed `string` because every DTO carries these as
   * `string`; the vocabulary maps themselves are keyed on the value's real
   * union, which is where completeness is enforced.
   */
  value: string;
  className?: string;
}

export function StatusBadge({ vocab, value, className = '' }: StatusBadgeProps) {
  const entry = lookup(vocab);
  const known = isKnown(entry, value);
  const style = (known ? entry.styles[value] : undefined) ?? NEUTRAL;
  const label = (known ? entry.labels[value] : undefined) ?? humanize(value);
  return (
    <span
      data-vocab={vocab}
      data-unmapped={known ? undefined : ''}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${style} ${className}`.trim()}
    >
      {label}
    </span>
  );
}

/** The humanized label alone — for `<select>` options and chips that echo a badge. */
export function statusLabel(vocab: StatusVocabulary, value: string): string {
  const entry = lookup(vocab);
  return (isKnown(entry, value) ? entry.labels[value] : undefined) ?? humanize(value);
}

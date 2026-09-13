// Owner Operator consequence line (spec §3.5): a PURE walk over one scope's
// last-30-day reviews under a set of trust dials. It answers "how many would
// have been ELIGIBLE", never "would have posted" — the live gate also needs
// moderation, triage, Judge availability and an active connection, and the
// veto window changes delay, not eligibility, so it is not an input here.
//
// The threshold predicate and the default-cap resolution are the publisher's
// own (`starMeetsThreshold`, `resolveDailyCap` in src/lib/auto-approval/policy.ts);
// this module owns only the ordering and the per-business/day cap counter.
//
// Time is server-owned. The reader supplies `detectedAt` as UTC-canonical ISO
// text and `dayKey` as SQL text computed per row with the publisher's bucket
// (auto-approval.ts: date_trunc('day', <ts> AT TIME ZONE 'UTC') AT TIME ZONE
// 'UTC', with the row's detected_at in place of NOW()). Both are compared as
// text; nothing here builds a Date, reads the clock, or uses a local timezone.
import type { AutoApprovalThreshold } from '@/lib/auto-approval/types';
import { resolveDailyCap, starMeetsThreshold } from '@/lib/auto-approval/policy';

export type ConsequenceReview = {
  readonly businessId: string;
  readonly reviewId: string;
  readonly stars: number | null;
  readonly detectedAt: string;
  readonly dayKey: string;
  readonly imported: boolean;
};

export type ConsequenceDials = {
  readonly threshold: AutoApprovalThreshold | null;
  readonly dailyCap: number | null;
};

export type ConsequenceDay = {
  readonly day: string;
  readonly total: number;
  readonly eligible: number;
  readonly held: number;
};

export type ConsequenceResult = {
  readonly total: number;
  readonly eligible: number;
  readonly held: {
    readonly below_threshold: number;
    readonly cap_reached: number;
    readonly manual: number;
  };
  readonly byDay: readonly ConsequenceDay[];
  readonly busiestDay: number;
};

function compareReviews(a: ConsequenceReview, b: ConsequenceReview): number {
  if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? -1 : 1;
  if (a.detectedAt !== b.detectedAt) return a.detectedAt < b.detectedAt ? -1 : 1;
  if (a.reviewId !== b.reviewId) return a.reviewId < b.reviewId ? -1 : 1;
  return 0;
}

export function simulateRule(
  reviews: readonly ConsequenceReview[],
  dials: Readonly<Record<string, ConsequenceDials>>,
): ConsequenceResult {
  // Imported reviews are never auto-eligible: out of every count. `filter`
  // copies, so the sort never touches the caller's array.
  const ordered = reviews.filter((review) => !review.imported).sort(compareReviews);

  let eligible = 0;
  let belowThreshold = 0;
  let capReached = 0;
  let manual = 0;
  const acceptedByBusinessDay = new Map<string, number>();
  const days = new Map<string, { total: number; eligible: number; held: number }>();

  for (const review of ordered) {
    const dial = Object.hasOwn(dials, review.businessId) ? dials[review.businessId] : undefined;
    if (dial === undefined) {
      throw new Error(
        `simulateRule: no auto-approval dials supplied for business ${review.businessId} (review ${review.reviewId})`,
      );
    }
    let day = days.get(review.dayKey);
    if (day === undefined) {
      day = { total: 0, eligible: 0, held: 0 };
      days.set(review.dayKey, day);
    }
    day.total += 1;

    if (!starMeetsThreshold(review.stars, dial.threshold)) {
      if (dial.threshold === null) manual += 1;
      else belowThreshold += 1;
      day.held += 1;
      continue;
    }

    const key = JSON.stringify([review.businessId, review.dayKey]);
    const accepted = acceptedByBusinessDay.get(key) ?? 0;
    if (accepted < resolveDailyCap({ dailyAutoPostCap: dial.dailyCap })) {
      acceptedByBusinessDay.set(key, accepted + 1);
      eligible += 1;
      day.eligible += 1;
    } else {
      capReached += 1;
      day.held += 1;
    }
  }

  const byDay = [...days].map(([dayKey, counts]) => ({ day: dayKey, ...counts }));
  return {
    total: ordered.length,
    eligible,
    held: { below_threshold: belowThreshold, cap_reached: capReached, manual },
    byDay,
    busiestDay: byDay.reduce((max, day) => Math.max(max, day.total), 0),
  };
}

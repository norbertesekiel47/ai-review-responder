// src/lib/notifications/channels/scheduled-post-time.ts
//
// Single owner of the pending-post notice's "posting at" time copy (WS4 spec
// §2.7). Every surface (email template, Telegram body, WhatsApp template
// variables) phrases the veto deadline BOTH absolute UTC and relative, so the
// wording lives once here rather than three near-clones.
//
// Pure — the caller supplies `now` (send time); tests pass a fixed clock.

export interface ScheduledPostTimePhrase {
  /** "14:30 UTC" — zero-padded 24h clock. */
  absoluteUtc: string;
  /** "in about 30 minutes" — rounded to the nearest minute, clamped ≥ 1. */
  relative: string;
  /** "14:30 UTC (in about 30 minutes)" — surfaces prepend "at ". */
  phrase: string;
}

export function formatScheduledPostTime(
  scheduledPostAt: Date,
  now: Date = new Date(),
): ScheduledPostTimePhrase {
  const hours = String(scheduledPostAt.getUTCHours()).padStart(2, '0');
  const minutes = String(scheduledPostAt.getUTCMinutes()).padStart(2, '0');
  const absoluteUtc = `${hours}:${minutes} UTC`;

  // Clamp to ≥ 1: the dispatcher skips notices whose deadline already passed
  // (context-loader freshness guard), so a sub-minute or negative remainder
  // here is a race, not a state — never phrase a nonsensical "in 0 minutes".
  const minutesUntil = Math.max(1, Math.round((scheduledPostAt.getTime() - now.getTime()) / 60_000));
  const relative = minutesUntil === 1 ? 'in about 1 minute' : `in about ${minutesUntil} minutes`;

  return { absoluteUtc, relative, phrase: `${absoluteUtc} (${relative})` };
}

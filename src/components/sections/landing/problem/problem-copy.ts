/**
 * The problem — section 6 copy.
 *
 * ── Scope: the WHOLE reputation, not reviews (owner direction, 2026-08-24) ─
 * This section deliberately frames the problem at the width of the product's
 * ambition — online reputation, everything a customer finds — not at the
 * width of today's shipped surface. Review-specific problem copy would go
 * stale the day dispute handling or another surface ships.
 *
 * That framing is honest by construction: a PROBLEM claims nothing about the
 * product. The shipped-scope truth anchors stay where they already are — the
 * hero's scope note above this section and the closing CTA's below it. Do
 * not add a capability claim here; the only product claim in the section is
 * the pivot line, and it claims existence only ("built the staff" — true of
 * the shipped fleet).
 *
 * The rule from future-copy.ts applies with double force: the reader is
 * never the punchline. The problem is that the JOB was never staffed — not
 * that the owner falls short. No fabricated statistics; the section argues,
 * it does not count.
 *
 * ── The diagram (owner direction, 2026-08-24 v0.2) ────────────────────────
 * The section carries one decorative diagram beside the essay: the customer-
 * side view of a reputation — a café orbited by what a customer finds
 * (stars, a review, a reply, and one dark card: the silence). Binding rules
 * for any replacement asset: it illustrates the PROBLEM only — no product,
 * no agents, no CRT characters, no readable text, and no fabricated review
 * content (abstract glyphs only). It is `aria-hidden`; the copy carries the
 * meaning.
 *
 * Copy was trimmed 2026-08-24 (owner direction, v0.2 course-correct): same
 * claims, fewer words — the diagram now carries part of the picture.
 */

export const EYEBROW = 'The problem';

export const HEADING_LEAD = 'Your reputation is public.';
export const HEADING_ACCENT = 'Tending it is a job.';

/** Flat string for `aria-label`, since the visible heading is split. */
export const HEADING_PLAIN = `${HEADING_LEAD} ${HEADING_ACCENT}`;

export const BODY_PARAGRAPHS: readonly string[] = [
  'Before anyone calls, books, or walks in, they look you up. Ratings, reviews, replies, silences — all of it is your reputation, working for or against you around the clock.',
  'Tending it is real work: watch what is said, judge what is at stake, answer in the business’s voice, ask the happy customers to speak up, keep the score, and know each Monday what happened. That job was never staffed. It was added to the owner’s.',
] as const;

/** The pivot into "Meet the fleet". Existence claim only. */
export const PIVOT_LEAD = 'Nobody staffed the job.';
export const PIVOT_ACCENT = 'So we built the staff.';

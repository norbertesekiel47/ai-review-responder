/**
 * The closing CTA.
 *
 * ── What this section may and may not say ─────────────────────────────────
 * It is the last thing read before the visitor decides, which makes it the
 * easiest place on the page to overclaim. The rules that bind here are the
 * same ones the rest of the landing copy follows:
 *
 *   - Google is the shipped platform, and on it the fleet does five jobs:
 *     respond, protect, request, brief, measure (jobs/jobs-copy.ts). The
 *     committed-future agents (CRM, Social, disputes, other platforms) stay
 *     future tense, and the closing note says so rather than leaving the
 *     headline to imply otherwise.
 *   - Copilot means the owner approves everything. That is a fact about the
 *     product, and it is the strongest reassurance available at the moment of
 *     decision — so it is stated plainly rather than softened into "you stay
 *     in control", which could mean anything.
 *   - No customer counts, no testimonials, no "trusted by" — none exist.
 *     PRODUCT.md is explicit about that.
 *
 * ── The button label is NOT here ──────────────────────────────────────────
 * It comes from the server as `primaryCtaLabel` and is threaded through
 * LandingExperience. Since RepWorth shut down (2026-10) the page passes the
 * closed door (`CLOSED_NOTICE_CTA` → "RepWorth has closed", `/closed`), so the
 * eyebrow below names the closure instead of an offer that no longer exists.
 */

export const EYEBROW = 'Service closed';

/** Closes on the page's actual argument — supervision — rather than urgency. */
export const TITLE_LEAD = 'Hand your reputation to';
export const TITLE_ACCENT = 'a fleet that answers to you.';

/** Flat string for `aria-label`, since the visible headline is split across
 *  spans and hand-broken lines. */
export const TITLE_PLAIN = 'Hand your reputation to a fleet that answers to you.';

export const SUBHEAD_LINES: readonly string[] = [
  'Start on Copilot, where nothing reaches Google without your say-so.',
  'Move to Autopilot when you want to, not before.',
];

/** The truth anchor, mirroring the hero's. Subordinate by design — it keeps
 *  the claim accurate without arguing with the headline above it. */
export const SCOPE_NOTE_LINES: readonly string[] = [
  'Google reviews today: answered, requested, and measured.',
  'The rest of the fleet arrives as it ships.',
];

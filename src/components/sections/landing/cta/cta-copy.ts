/**
 * The closing CTA.
 *
 * ── What this section may and may not say ─────────────────────────────────
 * It is the last thing read before the visitor decides, which makes it the
 * easiest place on the page to overclaim. The rules that bind here are the
 * same ones the rest of the landing copy follows:
 *
 *   - Google reviews are the shipped surface. Everything else in the fleet is
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
 * It comes from the server as `primaryCtaLabel` ("Get early access", or the
 * trial label when TRIAL_ENABLED is on) and is threaded through
 * LandingExperience. Do not hard-code an "early access" string in this file:
 * the moment the trial flag flips, a literal would be advertising the wrong
 * offer, and invariant #13 keeps flag state server-authoritative for exactly
 * this reason.
 */

export const EYEBROW = 'Early access';

/** Closes on the page's actual argument — supervision — rather than urgency. */
export const TITLE_LEAD = 'Hand your reviews to a fleet';
export const TITLE_ACCENT = 'that answers to you.';

/** Flat string for `aria-label`, since the visible headline is split across
 *  spans and hand-broken lines. */
export const TITLE_PLAIN = 'Hand your reviews to a fleet that answers to you.';

export const SUBHEAD_LINES: readonly string[] = [
  'Start on Copilot, where nothing reaches Google without your say-so.',
  'Move to Autopilot when you want to, not before.',
];

/** The truth anchor, mirroring the hero's. Subordinate by design — it keeps
 *  the claim accurate without arguing with the headline above it. */
export const SCOPE_NOTE_LINES: readonly string[] = [
  'Google reviews today, on one location or many.',
  'The rest of the fleet arrives as it ships.',
];

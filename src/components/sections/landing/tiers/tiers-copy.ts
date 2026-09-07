/**
 * Copilot vs Autopilot — section 8 copy.
 *
 * Drafted from the design of record (§8); wording blessed by the owner on
 * staging, 2026-08-24.
 *
 * ── Accuracy contract ─────────────────────────────────────────────────────
 * The reference's visual metaphor for this section is a DIAL between control
 * and autonomy, never a switch — bounded autonomy is the whole concept.
 * Binding facts, same sources as the closing CTA's copy:
 *
 *   - Copilot: the owner approves everything. Stated plainly, never softened
 *     into "you stay in control".
 *   - Autopilot: bounded autonomy — positive reviews only, inside an
 *     owner-set rating band and daily cap, after a veto window, with the
 *     Judge reviewing 100% of auto-posts.
 *   - The Governor can suspend autonomy per account. Present tense is
 *     correct: the watchdog is built and wired.
 *   - Movement between modes is the owner's act, in both directions.
 */

export const EYEBROW = 'Two ways to run it';

export const HEADING_LEAD = 'A dial,';
export const HEADING_ACCENT = 'not a switch.';

/** Flat string for `aria-label`, since the visible heading is split. */
export const HEADING_PLAIN = `${HEADING_LEAD} ${HEADING_ACCENT}`;

export const LEAD_IN =
  'You set how far the fleet may go on its own, and where it has to stop and ask.';

export interface TierPanel {
  id: string;
  name: string;
  claim: string;
  body: string;
}

export const TIERS: readonly TierPanel[] = [
  {
    id: 'copilot',
    name: 'Copilot',
    claim: 'You approve everything.',
    body: 'Every draft waits for your say-so. Nothing reaches Google without it.',
  },
  {
    id: 'autopilot',
    name: 'Autopilot',
    claim: 'Bounded autonomy.',
    body: 'Positive reviews can post on their own, inside a rating band and a daily cap you set, after a veto window, with the Judge reviewing every auto-post.',
  },
] as const;

export const MOVEMENT_NOTE = 'Start on Copilot. Move the dial when you are ready, and move it back any time.';

export const GOVERNOR_NOTE =
  'And if anything drifts, the Governor can suspend autonomy for the whole account.';

/**
 * The section's door. This is the one place the page compares the two plans,
 * so it is where a visitor decides they want the price — and the nav is
 * absolute over the hero, not sticky (measurements.md §2: its lockup contrast
 * is measured against the hero's top scrim, which no other section has), so
 * the door lives here rather than in the chrome.
 */
export const PRICING_LINK_LABEL = 'See plans and pricing';

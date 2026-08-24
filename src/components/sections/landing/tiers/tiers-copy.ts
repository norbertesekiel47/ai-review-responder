/**
 * Copilot vs Autopilot — section 8 copy.
 *
 * ── PROVISIONAL ───────────────────────────────────────────────────────────
 * Drafted from the design of record (§8) and the narrative spine before the
 * brief's exact §3.4 wording was available in-session. Verify against
 * `RepWorth-website-design-reference.md` before merge and delete this banner.
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
  'Autonomy here is not on or off. It is a dial you set — how far the fleet may go on its own, and where it must stop and ask.';

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
    body: 'Positive reviews can post on their own — inside a rating band and a daily cap you set, after a veto window, with the Judge reviewing every auto-post.',
  },
] as const;

export const MOVEMENT_NOTE = 'Start on Copilot. Move the dial when you are ready — and back, any time.';

export const GOVERNOR_NOTE =
  'And if anything drifts, the Governor can suspend autonomy for the whole account.';

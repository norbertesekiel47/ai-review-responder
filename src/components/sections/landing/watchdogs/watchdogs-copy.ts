/**
 * The supervising agents.
 *
 * ── Accuracy contract ─────────────────────────────────────────────────────
 * The Judge governs AUTO-posting only. On Copilot the owner approves and the
 * Judge is not in that path, so nothing here may say it reviews "everything
 * that goes out". Invariant #3 is precise: JUDGE_ENABLED=false or judge
 * unavailability makes the publisher downgrade unposted auto-policy rows to
 * owner review. That is what STATEMENT claims, and no more.
 *
 * The Governor suspends autonomy per account. It does not delete, refund, or
 * close anything.
 *
 * Neither watchdog is a "tier". The tiers are Copilot and Autopilot only —
 * PRODUCT.md flags this as a naming error that has already appeared in one
 * internal doc. Guardian is a persona, not a watchdog, and belongs in the
 * previous section.
 */

export interface Watchdog {
  id: string;
  name: string;
  /** What it supervises, in one line. */
  tagline: string;
  body: string;
  /** The concrete mechanism, stated as a rule rather than a benefit. */
  rule: string;
}

export const WATCHDOGS: readonly Watchdog[] = [
  {
    id: 'judge',
    name: 'Judge',
    tagline: 'Reviews the machine’s work, not yours.',
    body: 'Every reply that posts without you is independently assessed afterwards by a second model that had no hand in writing it. Verdicts are recorded, and a run of poor ones is what the Governor watches for.',
    rule: 'Reviews 100% of auto-posts',
  },
  {
    id: 'governor',
    name: 'Governor',
    tagline: 'The kill switch that does not wait for you.',
    body: 'If the picture stops looking right for an account, the Governor suspends its autonomy on its own — no support ticket, no waiting for someone to notice on Monday. Everything reverts to needing your approval.',
    rule: 'Suspends autonomy per account',
  },
];

export const EYEBROW = 'The agents that watch';
export const HEADING_LEAD = 'Something is always';
export const HEADING_ACCENT = 'watching the agents.';

export const LEAD_IN =
  'These two never touch your reviews. They exist only to supervise the agents that do — which is the reason trusting any of this is a rational decision rather than a hopeful one.';

/**
 * The pull-quote. The reference doc calls this "the strongest trust statement
 * RepWorth owns" and asks for it to stop the scroll, so it gets a panel of its
 * own rather than a line inside a card.
 *
 * Phrased as a precondition because that is what it is in code: judge
 * availability gates auto-posting (invariant #3). Do not soften "stops" into
 * "pauses" or "may be delayed" — the whole force of the claim is that it is
 * absolute.
 */
export const STATEMENT_LEAD = 'If the supervisor is down,';
export const STATEMENT_ACCENT = 'nothing posts.';
export const STATEMENT_FOOTNOTE =
  'Judge availability is a precondition for posting without you, not a nice-to-have. When it cannot run, replies wait for your approval instead.';

/** Framing above the two cards. */
export const TIER_LABEL = 'Oversight layer';

/**
 * Landing hero copy — the single place to change what the hero says.
 *
 * Split out from the component so the wording can be revised without touching
 * layout or motion code, and so the shipped-vs-future contract below stays
 * reviewable as one block of prose rather than scattered through JSX.
 *
 * ── Shipped-vs-future contract (read before editing) ──────────────────────
 * `RepWorth-website-design-reference.md` §3.2 calls confusing shipped
 * capability with roadmap "the one genuinely damaging mistake available here",
 * and PRODUCT.md Principle 3 reserves present tense for what ships today.
 *
 * This hero is deliberately VISION-forward. It stays honest by construction:
 *
 *   - The headline is two noun phrases with NO VERB. "One fleet of agents.
 *     Your whole reputation." states what RepWorth is and what it is aimed at;
 *     with nothing conjugated, it cannot assert that the whole surface is
 *     covered today. Do not "improve" it into a sentence ("A fleet of agents
 *     RUNS your whole reputation") — that is the overclaim the phrasing exists
 *     to avoid.
 *   - `SUBHEAD` describes architecture (one job per agent, supervising
 *     watchdogs), which is true of the system as built.
 *   - `SCOPE_NOTE` is the truth anchor and the ONLY present-tense scope claim
 *     in the hero. It is deliberately narrow: Google reviews. It must stay
 *     accurate to PRODUCT.md's "Google Business Profile reviews only".
 *
 * Do NOT name Solicitor, CRM, Social, or fake-review dispute agents here.
 * PRODUCT.md records Solicitor as built but inert in every environment
 * ("Correction of record"), and the rest as committed-future only.
 *
 * ── Sizing ────────────────────────────────────────────────────────────────
 * The headline lines are set as blocks at desktop, so they must fit the
 * 44rem (704px) copy column at the 64px display size or a line orphans. These
 * measure 602px and 671px. Re-measure before changing them: character count is
 * a poor proxy, since the previous 20- and 21-character lines came out 676px
 * and 587px.
 */

/** Headline line 1. Rendered in `--rw-lp-hero-text`. */
export const TITLE_LEAD = 'One fleet of agents.';

/**
 * Headline line 2 — the accent phrase, rendered in `--rw-lp-hero-accent`
 * (gold). Mirrors the reference image, where the final phrase carries the
 * accent colour rather than the whole headline.
 */
export const TITLE_ACCENT = 'Your whole reputation.';

/** Plain-text headline for `aria-label` / SEO, since the visible one is split
 *  across spans for the accent treatment and line control. */
export const TITLE_PLAIN = `${TITLE_LEAD} ${TITLE_ACCENT}`;

/**
 * Architecture, not capability — true of the system as built. Deliberately
 * avoids repeating "fleet of agents", which the headline now says first.
 *
 * Hand-broken: one clause per line, so the two halves (what the actors do /
 * who watches them) read as a pair rather than wrapping mid-thought. Measures
 * 185px and 412px against the 480px max-width.
 */
export const SUBHEAD_LINES = [
  'Each agent has one job.',
  'Independent watchdogs supervise the ones that act.',
] as const;

/**
 * The truth anchor. Subordinate to the headline by design (small, muted, set
 * below the CTA) so the vision leads while the claim stays accurate.
 *
 * Hand-broken so today's scope and tomorrow's ambition sit on separate lines
 * and neither can be skim-read into the other. 213px and 252px against the
 * 416px max-width.
 */
export const SCOPE_NOTE_LINES = [
  'Google reviews, end to end, today.',
  'Growing to everywhere else you show up.',
] as const;

/** Scroll affordance label. */
export const SCROLL_LABEL = 'Scroll';

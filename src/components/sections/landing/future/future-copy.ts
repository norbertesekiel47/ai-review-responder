/**
 * Where RepWorth is going.
 *
 * ── Only committed direction appears on this page ─────────────────────────
 * The source material separates the roadmap into two categories with very
 * different standing, and the website design reference §3.2 is explicit that
 * mixing them is "the one genuinely damaging mistake available here":
 *
 *   COMMITTED (§2.1) — direction the team has actually committed to. May be
 *       described concretely, but only ever in future tense.
 *   EXPLORING (§2.4) — "PROPOSED, NOT COMMITTED... treat as directional
 *       texture, NOT as roadmap promises."
 *
 * The EXPLORING tier was cut from the page entirely (owner decision,
 * 2026-08-04): the eight ideas are hypothetical today, so the safest treatment
 * is not to show them. Removing speculation is always safe; the rule that
 * remains binding is the one below, about what happens now that COMMITTED is
 * the only tier on screen. The eight are kept here — as a comment, not an
 * export, so they cannot be rendered by accident — in case the tier returns:
 *
 *     Competitor benchmarks — how you compare on your own street, not nationally
 *     Voice-of-customer themes turned into operational fixes
 *     Review-bombing detection, with a holding response ready
 *     Business-profile optimisation — hours, photos, Q&A kept fresh
 *     Right-moment asks, triggered by your POS or booking system
 *     Staff recognition, surfaced when reviews name people by name
 *     An agency tier, for running many businesses under one roof
 *     A reputation score you can actually share
 *
 * If they come back, they come back as plain text lines under their own label
 * and disclaimer — never as cards. Cards are what this section uses for
 * committed work, and the difference is the whole honesty mechanism.
 *
 * ── The front of a flip card is now load-bearing ──────────────────────────
 * The committed items became flip cards, so the body copy — and with it every
 * "will" that marks these as unbuilt — is hidden until the visitor interacts.
 * A skim now sees four names and nothing else, which reads as four features.
 * `CARD_TAG` is what stops that: every card front carries it, so the roadmap
 * status survives without the body being read. Do not remove it, and do not
 * move the "not available yet" disclaimer off the tier header.
 *
 * Nothing in this file may use present tense. Every committed item is "will",
 * and the section is labelled as future at three separate levels: the eyebrow,
 * the tier label, and the per-card tag.
 */

export interface FutureAgent {
  id: string;
  name: string;
  body: string;
}

/** §2.1 — committed direction. Future tense, concrete. */
export const COMMITTED: readonly FutureAgent[] = [
  {
    id: 'crm',
    name: 'CRM Manager',
    body: 'Will own contacts, follow-ups, and segmentation, so one-off review interactions become an ongoing relationship.',
  },
  {
    id: 'social',
    name: 'Social Media Manager',
    body: 'Will draft and schedule posts, answer comments and DMs, and hold one consistent brand voice across every channel it touches.',
  },
  {
    id: 'disputes',
    name: 'Fake Review Disputes',
    body: 'Will flag fraudulent, fake, or policy-violating reviews and drive the removal process with the platforms. Every owner has been hit by a 1-star that was never a customer.',
  },
  {
    id: 'platforms',
    name: 'Multi-Platform',
    body: 'Will extend past a single review source to more review sites, maps, social, and directories, normalised into one system, one voice, one set of rules.',
  },
];

export const EYEBROW = 'Where this is going';

/**
 * The reference doc calls this "the single most site-ready line in the source
 * material". It lives in §2 — the vision section — so this is its correct
 * home. It was deliberately NOT used in the hero, which needed a claim about
 * what the fleet is rather than what it will become.
 *
 * The accent half was "you could never afford to hire." That framing put the
 * reader's business at the centre of the sentence as the thing that falls
 * short, which reads as a dig at the very people this page is addressed to.
 * The claim being made is about what RepWorth is building, so the sentence now
 * lands on the reader as the beneficiary rather than the punchline.
 */
export const HEADING_LEAD = 'The AI reputation department';
export const HEADING_ACCENT = 'every business deserves.';

export const LEAD_IN =
  'No small business can staff a review team, a CRM, a social manager and a fraud-dispute process. The ambition is to be all of it: one supervised fleet covering everything your business’s reputation touches, not only its reviews.';

export const COMMITTED_LABEL = 'Committed direction';
export const COMMITTED_NOTE = 'Not available yet. This is what the fleet grows into next.';

/** Tells the visitor the cards have a back. Without it the bodies are only
 *  found by accident, and on touch not at all. */
export const COMMITTED_HINT = 'Hover or tap a card';

/** Per-card roadmap marker. See the note above on why the card front cannot
 *  rely on the body copy to carry this. */
export const CARD_TAG = 'Planned';

/**
 * §2.2 — flagged in the source as "the strongest strategic sentence in the
 * whole document". It reframes the roadmap from "more stuff" to "the same
 * trustworthy machine, doing more", which is the entire argument for why any
 * of the above is credible.
 */
export const CLOSING_LEAD = 'Every new agent joins';
export const CLOSING_ACCENT = 'the same supervised fleet,';
export const CLOSING_TAIL =
  'keeping the safety architecture that makes trusting AI with a business’s public reputation defensible.';

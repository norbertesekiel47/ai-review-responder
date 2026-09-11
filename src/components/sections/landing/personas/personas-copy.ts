/**
 * The acting agents, in depth.
 *
 * ── Accuracy contract ─────────────────────────────────────────────────────
 * `publishLabel` is the single most load-bearing field on this page. It is the
 * concrete answer to "will AI post something in my name?", and each value is
 * fixed by architecture, not by copywriting:
 *
 *   Reply     — the ONLY persona that can reach Google, and only after an
 *               approval method is recorded (invariant #3).
 *   Guardian  — never acts publicly. That is its whole identity; softening it
 *               to "handles bad reviews" implies it responds to them.
 *   Insights  — reports only.
 *   Solicitor — sends outbound EMAIL to the business's own customers, in
 *               batches the owner approves; it never posts publicly. Present
 *               tense since 2026-09-06 (owner decision), conditional on the
 *               SOLICITATION_* flags being on in production — PRODUCT.md
 *               "Shipped today" records the flip. The Review QR (one printable
 *               code per location, redirecting to the Google review form) is
 *               live and un-flagged; it belongs in this card too.
 *
 * Source: website design reference §1.1, PRODUCT.md "Shipped today",
 * invariants #3 and #4.
 */

interface Persona {
  id: string;
  name: string;
  /** The one-line characterisation. Reads as a role, not a feature. */
  tagline: string;
  /** The fuller description. Two or three sentences at most. */
  body: string;
  /** What it may publish, stated as a limit. */
  publishLabel: string;
}

/**
 * Each `id` names its clip pair under `public/agents/`: `{id}.mp4` and the
 * `{id}.jpg` that is both its poster and the still shown under
 * `prefers-reduced-motion`. The clips were generated from a frame of the hero
 * video, so every persona is the SAME CRT character as the hero's. That
 * reference master lives in `~/Developer/startups/RepWorth-media/masters/`,
 * not under `public/`, because everything there ships on every deploy.
 */
export const PERSONAS: readonly Persona[] = [
  {
    id: 'reply',
    name: 'Reply',
    tagline: 'Every review gets a response, in your voice.',
    body: 'It drafts a reply to every new review as it lands, not just the easy ones, and it matches how you actually talk. On Autopilot it can post the safe, positive ones by itself, inside the rating band and daily cap you set.',
    publishLabel: 'Publishes inside your bounds',
  },
  {
    id: 'guardian',
    name: 'Guardian',
    tagline: 'The bad ones reach a human. Always.',
    body: 'Guardian reads what comes in and decides what you need to see. It flags negative, risky, or sensitive reviews and escalates them to you rather than answering them automatically.',
    publishLabel: 'Never acts publicly',
  },
  {
    id: 'insights',
    name: 'Insights',
    tagline: 'Every Monday, you know exactly what happened.',
    body: 'A short weekly digest in plain language: what came in, what went out, how the week compares with your recent average, and what needs your eye. A monthly impact report closes each month, and the same brief sits on your dashboard.',
    publishLabel: 'Reports only',
  },
  {
    id: 'solicitor',
    name: 'Solicitor',
    tagline: 'Asking your customers, so more reviews arrive.',
    body: 'Solicitor asks your real customers for reviews by email, in batches you approve first, so volume and recency keep climbing instead of waiting on whoever happens to write in. It checks consent, honours every opt-out for good, and a printable QR code per location catches the walk-ins. It never posts anything publicly.',
    publishLabel: 'Outbound only, never posts',
  },
];

export const LEAD_IN =
  'Four named agents do the work. What separates them is what each one is permitted to do, and what it can never do at all.';

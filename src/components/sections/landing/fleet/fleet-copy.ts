/**
 * Fleet section copy — the named agents and what each one is allowed to do.
 *
 * ── Accuracy contract (read before editing) ───────────────────────────────
 * Every `role` here is a capability claim about a named agent, so each must be
 * true of the system as built. Sources: PRODUCT.md "Shipped today", and
 * architecture invariants #3 (no unapproved posting) and #4 (unsafe drafts
 * held). Specifically:
 *
 *   - Reply is the ONLY persona that can ever publish, and only inside bounds.
 *   - Guardian never acts publicly. That is its whole identity — do not soften
 *     it into "handles negative reviews", which implies it responds.
 *   - Insights reports only.
 *   - Judge reviews 100% of AUTO-posts. It does not review owner-approved
 *     replies, so never write "reviews everything that goes out".
 *   - Governor suspends autonomy per account.
 *
 * `status: 'next'` is load-bearing, not decoration. Website design reference
 * §3.2: "Never place a future agent in the same grid, with the same styling,
 * as a shipped one." Solicitor is built but inert — SOLICITATION_SEND_ENABLED
 * is defined in no environment file, so it cannot send anywhere. It renders
 * dimmed, with a dashed connector and a NEXT tag. Do not promote it to 'live'
 * until that flag is actually on in production.
 */

export type AgentStatus = 'live' | 'next';

export interface FleetAgent {
  id: string;
  name: string;
  /** One line. What this agent does, and what it is not allowed to do. */
  role: string;
  status: AgentStatus;
}

/** The supervising agents. Rendered ABOVE the centre — the oversight layer
 *  sitting over the action layer, per the reference doc's §3.5 metaphor. */
export const WATCHDOGS: readonly FleetAgent[] = [
  {
    id: 'judge',
    name: 'Judge',
    role: 'Independently reviews 100% of auto-posts. If it is unavailable, auto-posting stops.',
    status: 'live',
  },
  {
    id: 'governor',
    name: 'Governor',
    role: 'Suspends an account’s autonomy automatically, without waiting for anyone to notice.',
    status: 'live',
  },
];

/** The acting agents. Rendered BELOW the centre. */
export const PERSONAS: readonly FleetAgent[] = [
  {
    id: 'reply',
    name: 'Reply',
    role: 'Drafts a response to every review. The only agent that can publish — and only inside your bounds.',
    status: 'live',
  },
  {
    id: 'guardian',
    name: 'Guardian',
    role: 'Triages the negative lane and escalates to you. Never acts publicly.',
    status: 'live',
  },
  {
    id: 'insights',
    name: 'Insights',
    role: 'Compiles the weekly digest. Reports only.',
    status: 'live',
  },
  {
    id: 'solicitor',
    name: 'Solicitor',
    role: 'Will ask past customers for reviews, in managed batches, honouring every opt-out.',
    status: 'next',
  },
];

export const EYEBROW = 'The fleet';

/** Accent phrase carries the tail, matching the hero's treatment. */
export const HEADING_LEAD = 'Meet';
export const HEADING_ACCENT = 'the fleet.';

/**
 * Describes the diagram itself, and states the constraint precisely.
 * "posts on its own" is deliberate: on Copilot the owner approves and the
 * Judge is not in that path, so "nothing reaches the public without passing
 * them" would be false. Invariant #3 ties the Judge to AUTO-posting only.
 */
export const LEAD_IN =
  'The two above supervise the ones below — nothing posts on its own without clearing them.';

/**
 * Replaces the reference design's pulsing "LIVE" status pill. That indicator
 * implied a real-time system readout this page does not have; inventing one is
 * the fabricated-proof case the brand's anti-slop rules prohibit. This states a
 * fact instead (invariant #3).
 */
export const CENTRE_PILL = 'Judge reviews 100% of auto-posts';

/** Caption on the central node, mirroring the reference's corner label. */
export const CENTRE_LABEL = 'The run spine';
export const CENTRE_CAPTION =
  'Every action every agent takes is recorded here, so “what did it do, and why?” always has an answer.';

/** Tag rendered on any agent whose status is 'next'. */
export const NEXT_TAG = 'Next';

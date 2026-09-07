/**
 * The five jobs — the section that makes the landing page about a reputation
 * system rather than a reply tool.
 *
 * ── Why this section exists ───────────────────────────────────────────────
 * Before 2026-09-06 the page spent six of nine sections on the reply pipeline
 * and its supervisors. Requesting reviews, the weekly and monthly briefs, and
 * the dashboard were a card, a sentence, or absent. This ledger gives each
 * job of the system the same row, the same type scale, and the same amount
 * of prose, so a skim reads "five jobs" rather than "replies, plus extras".
 *
 * ── Accuracy contract (read before editing) ───────────────────────────────
 * Every row is a present-tense capability claim. Sources: PRODUCT.md
 * "Shipped today" (revised 2026-09-06), `docs/context/review-qr.md`, the
 * solicitation context files, `src/lib/dashboard/rep-pulse.ts`, and the
 * weekly / monthly report workers. Specifically:
 *
 *   Respond — Reply is the ONLY agent that can reach Google, and only after
 *             an approval method is recorded (invariant #3).
 *   Protect — Guardian never acts publicly. The Judge governs AUTO-posts
 *             only; never "reviews everything that goes out".
 *   Request — the Review QR is one identical printable code per location
 *             that redirects to the Google review form (no landing page, no
 *             contact capture). Solicitor sends EMAIL only, in batches the
 *             owner approves, and every opt-out is permanent (suppression
 *             outranks attestation). It never posts publicly. Present tense
 *             here is conditional on the SOLICITATION_* flags being on in
 *             production — the owner committed to that flip on 2026-09-06.
 *   Brief   — the weekly report goes out on Mondays and the monthly impact
 *             report once a month, both by email. Email is the only live
 *             owner channel; do not name Telegram or WhatsApp.
 *   Measure — Rep Pulse is `round(rating/5·70 + responseRate/100·30)` and
 *             shows nothing while an account is ramping. The Restraint tab
 *             lists refusals: decisions the system recorded not to act.
 *
 * No customer counts, no testimonials, no invented numbers anywhere.
 */

export interface Job {
  id: string;
  /** The two-digit index shown in the label font. */
  index: string;
  /** One verb. The row's display word. */
  verb: string;
  /** The claim, one line. */
  claim: string;
  /** Two or three sentences. Present tense; facts only. */
  body: string;
  /** Which named agents own the job. */
  agents: string;
  /** Where the owner meets the result. */
  surface: string;
  /** Whether the row belongs to the acting (gold) or the watching (teal)
   *  temperature. Measure is the run spine's job, so it takes teal. */
  tone: 'gold' | 'teal';
}

export const JOBS: readonly Job[] = [
  {
    id: 'respond',
    index: '01',
    verb: 'Respond',
    claim: 'Every review gets an answer, in your voice.',
    body: 'Reply drafts a response to each new review within seconds, in the language it was written in. You approve it from your inbox, or let Autopilot post the positive ones inside the rating band and daily cap you set.',
    agents: 'Reply',
    surface: 'Your inbox · your Google listing',
    tone: 'gold',
  },
  {
    id: 'protect',
    index: '02',
    verb: 'Protect',
    claim: 'The bad ones reach a human first.',
    body: 'Guardian reads every review of three stars or less, grades how serious it is, and escalates the ones that need you. It never posts. The Judge and the Governor watch everything that posts on its own.',
    agents: 'Guardian · Judge · Governor',
    surface: 'Escalation email · your dashboard',
    tone: 'teal',
  },
  {
    id: 'request',
    index: '03',
    verb: 'Request',
    claim: 'More reviews, from customers you actually served.',
    body: 'A printable QR code for each location sends walk-ins straight to your Google review form. Solicitor asks your past customers by email, in batches you approve first. Every opt-out is honoured for good, and it never posts anything publicly.',
    agents: 'Solicitor',
    surface: 'Your counter · your customers’ inboxes',
    tone: 'gold',
  },
  {
    id: 'brief',
    index: '04',
    verb: 'Brief',
    claim: 'Every Monday, you know what happened.',
    body: 'Insights sends a plain-language weekly report: what came in, what went out, what needs your eye, and one thing worth a look. A monthly impact report closes each month. Nothing to remember to check.',
    agents: 'Insights',
    surface: 'Your inbox, Monday morning',
    tone: 'gold',
  },
  {
    id: 'measure',
    index: '05',
    verb: 'Measure',
    claim: 'The score, always current.',
    body: 'Rep Pulse turns your rating and response rate into one transparent 0–100 score. The dashboard holds rating and volume trends, review velocity, and a Restraint tab listing everything the agents decided not to do, and why.',
    agents: 'The run spine',
    surface: 'Your dashboard',
    tone: 'teal',
  },
] as const;

export const EYEBROW = 'One system, five jobs';
export const HEADING_LEAD = 'It runs a whole';
export const HEADING_ACCENT = 'reputation department.';
/** Flat string for `aria-label`, since the visible heading is split. */
export const HEADING_PLAIN = `${HEADING_LEAD} ${HEADING_ACCENT}`;
export const LEAD_IN =
  'Answering reviews is one job of five. Each job belongs to an agent with a single permission, and every action every agent takes lands on the same recorded run spine.';

/** Column labels for the meta cells, rendered once above the ledger on wide
 *  viewports and as inline labels on narrow ones. */
export const AGENTS_LABEL = 'Who does it';
export const SURFACE_LABEL = 'Where you see it';

/** The closing line under the ledger: the agentic claim, stated as a rule. */
export const CLOSING_LEAD = 'Five jobs, one record.';
export const CLOSING_TAIL =
  'Ask “what did it do, and why?” about any of them and the run spine has the answer.';

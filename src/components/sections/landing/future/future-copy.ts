/**
 * Where RepWorth is going — the route map (2026-09-06 revamp).
 *
 * ── What is on the map, and why ───────────────────────────────────────────
 * The section became a survey chart: one route from what has shipped into
 * what comes next. Three states, and the difference between them is the
 * whole honesty mechanism:
 *
 *   shipped  — recorded in PRODUCT.md "Shipped today". Present tense is
 *              allowed ONLY here. Lit gold.
 *   planned  — the locked order of `docs/roadmap/2026-08-26-forward-roadmap.md`
 *              (owner decision 2026-08-26, Phases 1–5). Future tense, every
 *              sentence. Dim, dashed route, `Planned` tag.
 *   horizon  — sequenced after Phase 5 and "may be re-ordered later" (the
 *              roadmap's Phases 6–8), plus the two former cards that the
 *              forward roadmap does not name (Social media, Fake review
 *              disputes — kept as horizon stops by owner decision 2026-09-06).
 *              Future tense, in fog, no phase number.
 *
 * The EXPLORING tier (website design reference §2.4, "PROPOSED, NOT
 * COMMITTED") is still cut from the page (owner decision 2026-08-04). The
 * eight ideas stay here as a comment, not an export, so they cannot render by
 * accident:
 *
 *     Competitor benchmarks — how you compare on your own street, not nationally
 *     Voice-of-customer themes turned into operational fixes
 *     Review-bombing detection, with a holding response ready
 *     Business-profile optimisation — hours, photos, Q&A kept fresh
 *     Right-moment asks, triggered by your POS or booking system
 *     Staff recognition, surfaced when reviews name people by name
 *     A reputation score you can actually share
 *
 * (The agency tier left this list: the forward roadmap's Phase 8 names it, so
 * it is a horizon stop now.)
 *
 * ── The tag is load-bearing ───────────────────────────────────────────────
 * Every unbuilt stop carries its `marker` beside its name, so the roadmap
 * status survives a skim that never opens a stop. The legend states "Not
 * available yet" on the map itself. Do not remove either, and do not give a
 * planned or horizon stop the lit treatment.
 *
 * ── Coordinates ───────────────────────────────────────────────────────────
 * `x`/`y` are positions on a 1600×900 stage (the chart's 16:9 frame). The
 * lit stops sit in the left third, under the chart's lamp light; the fog
 * starts at `HORIZON_X`. Below 900px the stage is abandoned for a trail and
 * the coordinates are ignored.
 */

export type StopState = 'shipped' | 'planned' | 'horizon';

export interface RoadmapStop {
  id: string;
  name: string;
  /** One or two sentences. Present tense only when `state === 'shipped'`. */
  body: string;
  state: StopState;
  /** The mono tag beside the name: "Shipped", "Phase 1", "Later". */
  marker: string;
  x: number;
  y: number;
  /** Path under /public for the landmark cutout; undefined renders the marker glyph. */
  landmark?: string;
}

export const STAGE_WIDTH = 1600;
export const STAGE_HEIGHT = 900;
/** Where the fog begins. Horizon stops all sit to the right of it. */
export const HORIZON_X = 1255;

export const SHIPPED_MARKER = 'Shipped';
export const PLANNED_MARKER = 'Planned';
export const HORIZON_MARKER = 'Later';

/** The route, in travel order. The lit stretch is every `shipped` stop. */
export const STOPS: readonly RoadmapStop[] = [
  {
    id: 'spine',
    name: 'The run spine',
    body: 'Every action every agent takes is recorded here, so “what did it do, and why?” always has an answer.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 150,
    y: 730,
    landmark: '/future/stops/spine.webp',
  },
  {
    id: 'reply',
    name: 'Review responses',
    body: 'Reply drafts a response to every review. It is the only agent that can publish, and only inside your bounds.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 290,
    y: 655,
    landmark: '/future/stops/reply.webp',
  },
  {
    id: 'solicitor',
    name: 'Review requests',
    body: 'Solicitor asks your past customers for reviews by email, in batches you approve first. Every opt-out is honoured for good.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 425,
    y: 605,
    landmark: '/future/stops/solicitor.webp',
  },
  {
    id: 'qr',
    name: 'The Review QR',
    body: 'One printable code per location sends walk-ins straight to your Google review form. No landing page, no contact capture.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 560,
    y: 615,
    landmark: '/future/stops/qr.webp',
  },
  {
    id: 'restraint',
    name: 'The Restraint tab',
    body: 'The refusal ledger: everything the agents decided not to do, when, and why.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 690,
    y: 575,
    landmark: '/future/stops/restraint.webp',
  },
  {
    id: 'connectors',
    name: 'Connectors',
    body: 'Will connect your booking or job system once, so a finished appointment becomes a review request on its own. No CSV step.',
    state: 'planned',
    marker: 'Phase 1',
    x: 780,
    y: 548,
    landmark: '/future/stops/connectors.webp',
  },
  {
    id: 'recovery',
    name: 'Recovery cases',
    body: 'Will turn a negative review into a tracked case: a private follow-up drafted for your approval, the resolution recorded, the outcome measured.',
    state: 'planned',
    marker: 'Phase 2',
    x: 885,
    y: 462,
    landmark: '/future/stops/recovery.webp',
  },
  {
    id: 'topics',
    name: 'Review topics',
    body: 'Will sort every review into the operational topics of your trade, so the digest can say which one is slipping, and at which location.',
    state: 'planned',
    marker: 'Phase 3',
    x: 992,
    y: 566,
    landmark: '/future/stops/topics.webp',
  },
  {
    id: 'truth',
    name: 'Business Truth',
    body: 'Will hold your facts and your rules, so every draft is factually safe and carries a note on why it was written that way.',
    state: 'planned',
    marker: 'Phase 4',
    x: 1100,
    y: 448,
    landmark: '/future/stops/truth.webp',
  },
  {
    id: 'autonomy',
    name: 'Per-action autonomy',
    body: 'Will let you grant full autonomy or ask-me per action: positive replies, negative replies, review requests, recovery outreach.',
    state: 'planned',
    marker: 'Phase 5',
    x: 1205,
    y: 566,
    landmark: '/future/stops/autonomy.webp',
  },
  {
    id: 'platforms',
    name: 'More platforms',
    body: 'Will extend past Google to more review sites, maps and directories, each with its own rules encoded.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1315,
    y: 520,
  },
  {
    id: 'impact',
    name: 'Impact page',
    body: 'Will show conservative, defensible numbers: reviews received, response coverage, requests converted, customers recovered.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1485,
    y: 300,
  },
  {
    id: 'api',
    name: 'API and agencies',
    body: 'Will open a public API and MCP surface, and an agency tier for running many businesses under one roof.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1495,
    y: 645,
  },
  {
    id: 'social',
    name: 'Social media',
    body: 'Will draft and schedule posts, answer comments and DMs, and hold one brand voice across every channel it touches.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1345,
    y: 720,
  },
  {
    id: 'disputes',
    name: 'Fake review disputes',
    body: 'Will flag fraudulent or policy-violating reviews and drive the removal process with the platforms.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1415,
    y: 400,
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

/** The legend on the chart. The note is the section's disclaimer — it sits ON
 *  the map, so it cannot be scrolled past independently of the stops. */
export const LEGEND_LABEL = 'The route';
export const LEGEND_NOTE = 'Lit stops are live today. Everything past them is not available yet.';
export const LEGEND_SHIPPED = 'Live today';
export const LEGEND_PLANNED = 'Planned, in order';
export const LEGEND_HORIZON = 'Sequenced later';

/** The pin at the end of the lit road. */
export const TODAY_LABEL = 'Today';

/** The fog's own label, stamped on the horizon line. */
export const HORIZON_LABEL = 'Beyond the horizon';

/** Accessible name for the stop list. */
export const STOPS_LABEL = 'The roadmap, in order';

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

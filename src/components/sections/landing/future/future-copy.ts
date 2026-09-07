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
 * ── Unbuilt stops are HINTED, not named (owner decision 2026-09-06) ───────
 * A planned or horizon stop never states the feature. Its `name` is a short
 * tease ("A second chance"), its `body` one sentence that hints at the
 * outcome without describing the mechanism, and its landmark is the only
 * literal clue (a life ring, a cable, a card drawer). The roadmap itself
 * stays in `docs/roadmap/2026-08-26-forward-roadmap.md`; the mapping from
 * each stop `id` to its phase is the `marker` plus this comment:
 *   connectors → Phase 1 event-triggered requests · recovery → Phase 2
 *   recovery workflows · topics → Phase 3 review-topic ontology · truth →
 *   Phase 4 Business Truth + policy · autonomy → Phase 5 per-action autonomy
 *   · platforms → Phase 6 · impact → Phase 7 · api → Phase 8 · social /
 *   disputes → the two former cards, sequenced later.
 * Future tense still binds: every hint body carries "will".
 *
 * ── The tag is load-bearing ───────────────────────────────────────────────
 * Every unbuilt stop carries its `marker` beside its name, so the roadmap
 * status survives a skim that never opens a stop. The legend states "Not
 * available yet" on the map itself. Do not remove either, and do not give a
 * planned or horizon stop the lit treatment.
 *
 * ── Coordinates ───────────────────────────────────────────────────────────
 * `x`/`y` are positions on a 2000×1440 stage (the chart bleeds to the
 * viewport edges — 2026-09-06 owner direction: "use the space on the left
 * and right"). The top ~520 units are the TITLE BAND: from 1280px up the
 * section header (eyebrow, heading, lead, closing quote, legend) sits over
 * the chart there, so the section starts straight under the dial with no
 * ink gap (owner, 2026-09-06: "I really do not like the transition"). Keep
 * every road point at y ≥ 820. The road is a long serpentine — bottom-left, up
 * over a crest, down through a trough, up again to the horizon — so
 * consecutive stops sit ~230 units apart along it instead of ~130 on a
 * flat line (owner: the flat road read "convoluted" and "cramped"). Keep
 * every point in y 300–740: the top and bottom 100 units are fades. The lit
 * stops sit in the left two-fifths, under the chart's lamp light; the fog
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
  /** Which side of the road point the label sits. Chosen per stop so labels
   *  stay on the OUTSIDE of each bend and clear of the top/bottom fades. */
  label: 'above' | 'below';
  /** Path under /public for the landmark cutout; undefined renders the marker glyph. */
  landmark?: string;
  /** The cutout's width ÷ height. The landmark box is sized by it so a wide
   *  cutout (the two joined sets, the gate) fills its box instead of sitting
   *  small at the bottom of a square one with its label floating above. */
  landmarkAspect?: number;
}

export const STAGE_WIDTH = 2000;
export const STAGE_HEIGHT = 1440;
/** Where the fog begins. Horizon stops all sit to the right of it. */
export const HORIZON_X = 1590;

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
    x: 170,
    y: 1240,
    label: 'below',
    landmark: '/future/stops/spine.webp',
    landmarkAspect: 0.35,
  },
  {
    id: 'reply',
    name: 'Review responses',
    body: 'Reply drafts a response to every review. It is the only agent that can publish, and only inside your bounds.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 330,
    y: 1080,
    label: 'below',
    landmark: '/future/stops/reply.webp',
    landmarkAspect: 0.79,
  },
  {
    id: 'solicitor',
    name: 'Review requests',
    body: 'Solicitor asks your past customers for reviews by email, in batches you approve first. Every opt-out is honoured for good.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 490,
    y: 895,
    label: 'below',
    landmark: '/future/stops/solicitor.webp',
    landmarkAspect: 0.76,
  },
  {
    id: 'qr',
    name: 'The Review QR',
    body: 'One printable code per location sends walk-ins straight to your Google review form. No landing page, no contact capture.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 690,
    y: 820,
    label: 'above',
    landmark: '/future/stops/qr.webp',
    landmarkAspect: 0.45,
  },
  {
    id: 'restraint',
    name: 'The Restraint tab',
    body: 'The refusal ledger: everything the agents decided not to do, when, and why.',
    state: 'shipped',
    marker: SHIPPED_MARKER,
    x: 890,
    y: 920,
    label: 'below',
    landmark: '/future/stops/restraint.webp',
    landmarkAspect: 1.42,
  },
  {
    id: 'connectors',
    name: 'Something is plugging in',
    body: 'Your booking system will have something to say, and the ask will take care of itself.',
    state: 'planned',
    marker: 'Phase 1',
    x: 1085,
    y: 1140,
    label: 'above',
    landmark: '/future/stops/connectors.webp',
    landmarkAspect: 1.56,
  },
  {
    id: 'recovery',
    name: 'A second chance',
    body: 'A bad review will not be the end of the story.',
    state: 'planned',
    marker: 'Phase 2',
    x: 1165,
    y: 1265,
    label: 'below',
    landmark: '/future/stops/recovery.webp',
    landmarkAspect: 1.04,
  },
  {
    id: 'topics',
    name: 'What is slipping',
    body: 'Your reviews will start telling you which part of the job is drifting, and where.',
    state: 'planned',
    marker: 'Phase 3',
    x: 1320,
    y: 1200,
    label: 'above',
    landmark: '/future/stops/topics.webp',
    landmarkAspect: 0.68,
  },
  {
    id: 'truth',
    name: 'Facts and rules',
    body: 'The agents will know your business the way you do, and say why they wrote what they wrote.',
    state: 'planned',
    marker: 'Phase 4',
    x: 1450,
    y: 1020,
    label: 'above',
    landmark: '/future/stops/truth.webp',
    landmarkAspect: 0.89,
  },
  {
    id: 'autonomy',
    name: 'Your hand on the dial',
    body: 'You will decide exactly how much rope each agent gets, action by action.',
    state: 'planned',
    marker: 'Phase 5',
    x: 1550,
    y: 840,
    label: 'above',
    landmark: '/future/stops/autonomy.webp',
    landmarkAspect: 0.74,
  },
  {
    id: 'platforms',
    name: 'More than one map',
    body: 'Google will not be the only place the fleet keeps watch.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1700,
    y: 770,
    label: 'below',
  },
  {
    id: 'impact',
    name: 'Numbers you can defend',
    body: 'What the fleet did for you will be counted the conservative way.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1870,
    y: 940,
    label: 'above',
  },
  {
    id: 'api',
    name: 'Doors for other tools',
    body: 'Other software will be able to knock.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1855,
    y: 1290,
    label: 'above',
  },
  {
    id: 'social',
    name: 'Beyond reviews',
    body: 'The fleet will have more than reviews to speak for you.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1690,
    y: 1320,
    label: 'above',
  },
  {
    id: 'disputes',
    name: 'The one that was never a customer',
    body: 'Some reviews will get a second look.',
    state: 'horizon',
    marker: HORIZON_MARKER,
    x: 1770,
    y: 1120,
    label: 'below',
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
export const LEGEND_NOTE = 'Lit stops are live today. The rest are hints of what comes next, not available yet.';
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
  'which is what makes handing your public reputation to AI defensible at all.';

# RepWorth Product Roadmap (folder of record)

This folder owns **product/market sequencing**: what is built, what comes next,
in what order, and why. It sits one layer above the engineering design docs.

It does NOT replace:

- `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` — the
  **design of record** for the agentic platform. Its §8 (as-built) and §9
  (solicitation roadmap) remain authoritative for that subsystem's status.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — per-feature locked specs.
- `docs/runbooks/` — operational procedures (deploys, cutovers, flag flips).

When a phase in this folder starts, it gets its own spec/plan under
`docs/superpowers/` (via the normal grill → spec → `/feature` path). This folder
records the sequence and the decisions; the specs record the mechanics.

## Files

| File | Contents |
|---|---|
| `2026-08-26-current-state.md` | Verified inventory of what is built today, plus the explicit gap list |
| `2026-08-26-forward-roadmap.md` | Phased forward plan (Phases 1–8) in the locked order, with scope sketches and open design questions per phase |
| `2026-08-26-verticals.md` | The three committed verticals: ICPs, trigger events, integration targets, per-vertical review-topic ontologies, compliance notes |
| `2026-08-26-positioning-governed-autonomy.md` | The governed-autonomy positioning: message architecture, proof points, claims to avoid |
| `2026-08-26-brand-story.md` | The brand story of record for campaigns, social media, videos, landing pages, and the website — narrative, pillars, channel playbook, honesty ledger |
| `2026-08-26-agentic-architecture.md` | Agent-architecture principles (as-built invariants), memo→as-built map, sequencing of future agentic work, and the public API/MCP strategy |

## Locked decisions (owner, 2026-08-26)

1. **Vertical commitment.** RepWorth targets three verticals: **Home services**,
   **Food & beverage** (restaurants, cafes, bars), and **Beauty & personal
   care** (salons, facial/skin clinics, massage centers). Details and rollout
   order recommendation: `2026-08-26-verticals.md`.
2. **Build order.** The next four product efforts, in order:
   **event-triggered review requests (CRM/FSM/booking integrations) →
   reputation recovery workflows → review-topic ontology intelligence →
   Business Truth + policy layer.** Rationale: `2026-08-26-forward-roadmap.md`.
3. **Positioning.** Market RepWorth around **governed autonomy** now — the
   Judge/Governor/veto-window/audit-spine trust infrastructure is the shipped
   differentiator, not a future layer. Details:
   `2026-08-26-positioning-governed-autonomy.md`.
4. **QR before launch.** The QR-code review request (customer scans →
   location's Google write-review page) ships **before the production
   launch**, pulled forward out of Phase 1 onto the launch track. Scope:
   `2026-08-26-forward-roadmap.md` Phase 0.

## Open decisions (flagged, not yet made)

- **Pricing.** Current live pricing is Copilot $29 / Autopilot $69 per account
  (founding $19/$49, deadline 2027-01-01; location overage $10/$20). The
  2026-08-26 external research memo recommends $79/$149/$249 **per location**.
  These differ by ~3–5×. Decide before scaled acquisition spend; the
  grandfathering infrastructure (stored prices on `accounts`, invariant #9a)
  makes later repricing safe for existing customers. See
  `2026-08-26-forward-roadmap.md` § Cross-cutting.
- **Vertical rollout order** within the three committed verticals (a
  recommendation is given in `2026-08-26-verticals.md`, not locked).

## Provenance

Synthesized 2026-08-26 from: (a) an external deep-research memo ("RepWorth
Roadmap", owner-supplied, 2026-08-26) covering strategy, competitors, pricing,
and agent/MCP architecture; (b) a code-grounded assessment of that memo against
this repository; (c) the design of record §8/§9. Where the memo assumed
something needed building that already exists, this folder records the
corrected state.

## Maintenance

- Update `current-state.md` when a roadmap phase ships (same PR discipline as
  other docs: fix cross-references in the same change).
- Record new owner decisions in the "Locked decisions" list above with a date.
- Do not fork a second status inventory — link to the design of record for
  agentic-platform detail.

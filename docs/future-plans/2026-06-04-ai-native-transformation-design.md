# RepWorth → SaaS 2.0 / AI-Native Service Company — Transformation Map

**Status:** North-star design (strategic). Approved in brainstorming session 2026-06-04.
**Author:** Brainstorming session (Norbert + Claude)
**Date:** 2026-06-04
**Altitude:** Strategy / roadmap. This sits *above* the execution-level program design and points to it for mechanics.

---

## 0. How to read this doc (single-source-of-truth map)

This is the **strategic transformation map** — the "where are we going and why" across product, pricing, and architecture. It deliberately does **not** restate execution mechanics that already have an owner. When this doc names a capability, the authoritative *how* lives here:

| Topic | Authoritative source |
|---|---|
| Agent substrate, run engine, trust dial, Reply/Solicitation agents, posting adapters, **forced pricing-migration mechanics** | [`docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md`](2026-05-22-saas-2-0-vertical-agent-platform-design.md) |
| Auto-approval runtime (gates, kill-switch, policy resolution) | [`docs/superpowers/specs/2026-05-31-auto-approval-design.md`](../superpowers/specs/2026-05-31-auto-approval-design.md) — shipped in PR #227 |
| Architecture invariants (NEVER-violate list, incl. #3/#4/#11/#14 evolution) | [`.claude/CLAUDE.md`](../../.claude/CLAUDE.md) |
| SaaS-readiness gaps and how to close them | [`docs/sass_ready/`](../sass_ready/README.md) (the original Q&A doc was removed as stale; the specs folder supersedes it) |

**Relationship to the 2026-05-22 program doc:** that doc ([2026-05-22-saas-2-0-vertical-agent-platform-design.md](2026-05-22-saas-2-0-vertical-agent-platform-design.md)) is a *committed program* for converting RepWorth into a vertical AI-agent platform (Reply spine → Solicitation → outcome pricing). This doc is the wider lens: it frames that program as **Phase A ("deepen to autonomous")** of a two-stage journey, and adds the **Phase B ("broaden to managed reputation")** destination, the calibrated-confidence / online-eval capabilities, and the moat/risk framing the program doc treats as given. Where the two ever disagree on mechanics, the program doc and CLAUDE.md win.

---

## 1. The reframe

The shift has a precise market name: **service-as-a-software** — stop selling *access to a tool* and start selling *the work itself, done by AI*. The customer buys an outcome ("my reviews are handled, my reputation goes up"), not a dashboard they operate.

**Two end-states, sequenced (decided in brainstorming):**

1. **Deepen → fully autonomous review responses.** Same job, but the AI owns it end-to-end; the human becomes exception-only. You sell "we handle 100% of your review replies," not a drafting tool. Smaller surface, fastest path to the AI-native model, easiest to price on outcomes. **This is Phase A.**
2. **Broaden → managed reputation.** RepWorth becomes the reputation *function*: responses + solicitation/velocity + multi-platform (Google, Yelp, Facebook, Apple) + listing accuracy + Q&A + sentiment insights + reporting — the retainer service an SMB would otherwise hire an agency for. **This is Phase B**, started only once the autonomous core is trusted and profitable.

**The honest finding: this is an evolution, not a rebuild.** RepWorth already has the load-bearing pieces most teams retrofit.

### 1.1 Asset inventory — what already exists

| AI-native requirement | What RepWorth already has |
|---|---|
| Agentic pipeline | ingest → draft → moderate → approve → post |
| Durable autonomous execution | transactional outbox + `OutboxPoller` (invariant #2 — no silent loss) |
| Safety veto for autonomy | `moderateResponse` absolute veto + `flagged_responses` hold (invariant #4) |
| Human-removal mechanism | auto-approval runtime, PR #227 (16 gates + 3 defensive checks) |
| Trust measurement | `pnpm eval:llm` safety/quality eval harness |
| Margin control for usage pricing | two-phase cost-guard (Redis pessimistic reserve → finalize from actual tokens) |
| Outcome instrumentation | [`src/lib/kpi/`](../../src/lib/kpi/) (star trend, response rate, time-to-respond) + `src/lib/admin/margin-service.ts` |
| Source-agnostic ingest (for broaden) | `NormalizedReview` ReviewSource contract (invariant #7) |
| Reliability | dual-provider LLM with fallback, structured logging, audit log |
| Point-in-time repricing | migration 054 pattern — stored quota/price, grandfathered |

The real question is therefore narrow: **which 5–6 capabilities turn a supervised tool into an autonomous service.**

---

## 2. Technical architecture — the gap to "autonomous"

Six capabilities stand between today and the end-state. A–D are Phase A; E–F enable Phase B. None of these violate an architecture invariant — they **extend** them. The runtime model is unchanged: Vercel = UI only (invariant #1), all agent work on Railway, outbox for durability (invariant #2), moderation stays an absolute veto (invariant #4).

### A. Calibrated confidence / trust score (the central new capability)
Today auto-approval is *rule-gated* (discrete block reasons). Full autonomy needs a *semantic confidence score* per draft that routes auto-post vs. escalate-to-human, **calibrated against real edit/reject outcomes** — not a heuristic. Relationship to existing gates: the gates remain the **hard veto**; confidence is the **soft router** layered on top. This is the single largest *new* modeling effort.

### B. Feedback loop (today's biggest absence)
Owner edits/rejections are currently *recovery flows*, not *learning signal*. To be a service, every edit must improve future drafts:
- per-customer brand-voice memory,
- retrieval of past *approved* responses into the prompt,
- eventually per-segment fine-tuning.

This is also the **moat** (see §5.5): when drafting commoditizes, the per-customer voice model and outcome history are what competitors can't copy.

### C. Evals as the release gate + per-customer golden sets + online judging
`eval:llm` is offline/manual today. For autonomy it must become:
1. a **CI gate** that blocks prompt/model changes that regress quality,
2. **per-customer golden sets** (replay against that customer's approved history),
3. **online eval** — LLM-as-judge sampling a % of *auto-posted* responses in production to catch drift.

You cannot safely raise autonomy without (3). This is the production-readiness backbone of the whole transformation.

### D. Graduated autonomy levels (a trust ladder, not a switch)
Per-customer ladder: `shadow` (draft, don't send — measure agreement) → `suggest` (today) → `auto + undo window` → `full auto`. A customer earns the next rung when measured accuracy clears a frozen threshold. This is the safe, sellable evolution of invariant #3 and aligns with the trust-dial in the 2026-05-22 program doc.

### E. (Phase B) Multi-surface agents + orchestrator
One agent per surface (responses, solicitation, listings, Q&A), coordinated by a "reputation-manager" meta-agent that plans across them. The 2026-05-22 doc already specifies the multi-agent substrate; Phase B is where the *roster* expands beyond Reply + Solicitation.

### F. (Phase B) Platform connectors
Yelp / Facebook / Apple Business Connect ingest + post paths, each terminating on Railway (invariant #6), each normalizing to `NormalizedReview` (invariant #7). The ReviewSource abstraction means new platforms plug in **without touching the prompt builder** — the abstraction already exists.

---

## 3. Product & pricing — tool → service

### 3.1 Positioning shift
- The **dashboard** stops being a workspace and becomes a **report + exception queue**.
- **Onboarding** stops being "connect and configure" and becomes "we learn your voice in ~2 weeks of shadow mode, then take over." The shadow period *is* the onboarding *is* the trust-building — one mechanism, three jobs.

### 3.2 Pricing model
Moving off per-location SaaS tiers (`accounts.locations_included` / `base_price_cents`). Three candidate models:

| Model | Pros | Cons |
|---|---|---|
| Pure usage (per handled response) | scales with value, clean | variable cost exposure; feels like a tool again |
| Managed retainer ($/location/mo) | predictable, *feels* like a service | doesn't capture volume upside |
| Outcome / success-based | strongest positioning | attribution is hard; disputes; hard to defend |

**Recommendation: hybrid — retainer floor + autonomy-tier multiplier + usage overage.** Predictable base (service feel), full-autonomy commands a premium tier, heavy-volume locations pay overage. This matches the "subscription floor + outcome overage" decision already locked in the 2026-05-22 program doc (§1, §8) — this doc affirms it rather than re-deciding it.

**Two hard constraints on whatever model ships:**
- The price meter **must ride the cost-guard** so per-response margin is always known (no blind usage pricing).
- Repricing **must use the migration-054 point-in-time pattern** (store quota/price on the account row, grandfather on change) — the painful part is already solved.

---

## 4. The phased roadmap

### Phase 0 — Foundation (mostly done / finish now)
- Auto-approval runtime landed (PR #227 ✅).
- Add the **outcome instrumentation** you will price and sell on: per-customer edit rate, override rate, % auto-handled, time-to-response, reputation lift. *You cannot price or sell outcomes you don't measure.*

### Phase A — Deepen to autonomous (the proof) ≈ the 2026-05-22 "V1" program
1. Confidence model + calibration (capability A)
2. Feedback loop: brand-voice memory + approved-response retrieval (B)
3. Evals as CI gate + online judge sampling (C)
4. Trust ladder: shadow → full auto, per customer (D)
5. Report + exception-queue UI; per-customer autonomy controls
6. Pilot the hybrid pricing with a founders cohort on full autonomy (mechanics: program doc §8)

**Exit criterion:** a cohort runs at **≥90% auto-handled** with edit rate below a frozen threshold, **profitably**. The thesis is proven on the narrow surface before any broadening.

### Phase B — Broaden to managed reputation (the expansion)
7. Review solicitation / velocity engine (built in V1 per program doc; *customer rollout* here)
8. Second + third platform connectors (Yelp / Facebook / Apple) via ReviewSource
9. Listings accuracy + Q&A surfaces
10. Reputation-manager orchestrator across surfaces
11. Retainer pricing as the default package

**Exit criterion:** customers pay a managed-service retainer and would otherwise hire an agency.

---

## 5. Risks to design against (production-readiness lens)

### 5.1 Public irreversibility *(risk #1)*
Auto-posting wrong content to Google is outward-facing and hard to reverse. The confidence gate + moderation veto + **undo window** must bound the blast radius. The architecture is already shaped for this (invariants #3/#4); the new confidence router must fail **closed**.

### 5.2 Platform ToS — *go/no-go assumption to validate before Phase A*
Confirm Google Business Profile (and later Yelp/Facebook/Apple) permit automated posting at scale without flagging/banning. The current posting bridge is the Zernio adapter (`ZernioPostingAdapter`, program doc §1); GBP arrives later via flag. **This is a gating assumption, not an in-flight discovery.**

### 5.3 Margin under usage/outcome pricing
LLM cost per response must stay well under price. Per-response accounting already exists via cost-guard → turn it into a **live unit-economics view** (extends `margin-service.ts`).

### 5.4 Trust & liability
You're automating an SMB's public voice. The contract is: SLA + audit trail (have it) + one-click override/undo.

### 5.5 Moat
When drafting commoditizes, defensibility is the per-customer voice model + outcome data + the trust/autonomy system — **not** the LLM call. Phase A's feedback loop (capability B) *is* the moat; it is not optional polish. (Aligns with program doc §0.1: "the moat is the vertical, not the pricing model.")

---

## 6. Open decisions / what to validate next

- [ ] **Google/GBP automated-posting ToS** — settled or open? Blocks Phase A go/no-go (§5.2).
- [ ] Confidence model approach: dedicated calibrated scorer vs. LLM self-rating vs. ensemble (capability A).
- [ ] Online-eval sampling rate + judge model + cost ceiling (capability C; must ride cost-guard).
- [ ] Final pricing parameters — handled by program doc §8 shadow-metering; this doc only affirms the hybrid shape.
- [ ] Does Phase B broaden in the order listed (solicitation → connectors → listings → orchestrator), or pull connectors earlier?

---

## 7. Next step

Each phase capability becomes its own spec → plan → implementation cycle (per the brainstorming/writing-plans flow). The natural **first concrete slice** is **Phase 0 outcome instrumentation** — it's low-risk, unblocks pricing, and produces the metrics that gate every later autonomy increase.

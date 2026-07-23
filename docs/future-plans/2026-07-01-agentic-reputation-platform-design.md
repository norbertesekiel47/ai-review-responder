# RepWorth → Agentic Reputation-Management Platform — Design of Record

**Status:** Accepted (grilling session 2026-07-01, Norbert + Claude). Supersedes
[2026-05-22-saas-2-0-vertical-agent-platform-design.md](2026-05-22-saas-2-0-vertical-agent-platform-design.md)
and [2026-06-04-ai-native-transformation-design.md](2026-06-04-ai-native-transformation-design.md).
Where those docs and this one disagree, this one wins. Architecture invariants in
[.claude/CLAUDE.md](../../.claude/CLAUDE.md) still win over everything.
**Altitude:** Fresh analysis + locked decisions. Each build phase below still gets its own
spec → plan → implementation cycle.
**Build status (2026-07-22):** Phase 1 (WS1–WS8) is SHIPPED to `main` and
staging-proven end-to-end — see **§8 As-built status**, which records what was
built, where it diverged from this design, and what remains before production
go-live. §§1–7 are preserved as the accepted design; §8 is the reality overlay.

---

## 0. The reframe that changed everything

**The product is not launched.** That single fact invalidates the center of gravity of both
prior docs: there are no customers to migrate, no tier revenue to protect, no bills to
shadow-meter. The May doc's §8 machinery — forced 60-day migration, founders ring,
two-axis `(execution_path, pricing_model)` state model, rollback preflights, shadow billing —
was designed to protect customers who don't exist. It is deleted from the plan, not deferred.

What survives from the prior docs:

- The May doc's **safety architecture** (deterministic step graphs, single tool chokepoint,
  policy-gated side effects, no LLM in the control path) — right then, right now.
- The June doc's **asset inventory and trust-ladder thinking** — the observation that this is
  an evolution, not a rebuild, is even more true than that doc claimed.

What this doc rejects from the prior docs: forced migration, outcome-metered billing at
launch, substrate-first sequencing, the full four-layer authorization build up front, and
coordination keys in v1.

---

## 1. Architecture reusability assessment

**Verdict: the stack carries over ~90%. Nothing needs replacing.** The paradigm shift from
"trigger a response job" to "agents that monitor, decide, and act" is real at the product
layer and almost illusory at the infrastructure layer.

The load-bearing observation: **every agent in this product is event-driven or scheduled,
with waits measured in hours-to-days.** Reply waits days for owner approval; Solicitation
waits 14 days for attribution; Insights runs weekly. An "always-on agent" is, mechanically,
a trigger + a short burst of LLM/tool steps + durable state + resume-on-event. Holding a
process open across a multi-day wait is strictly worse than parking state in Postgres —
which is exactly the shape of the existing outbox + BullMQ + Postgres substrate.
**Long-running stateful agent processes are the wrong paradigm for this product class**;
they belong to interactive/conversational agents, which are a possible future *surface*,
not the execution substrate.

| Existing asset | Role in the agentic platform |
|---|---|
| Transactional outbox + `OutboxPoller` (invariant #2) | The event substrate for agent triggers and step advancement — unchanged |
| BullMQ + Railway worker fleet | Executes agent step bursts — unchanged |
| Ingest pipeline (Zernio → `NormalizedReview`) | The Reply/Guardian trigger source — unchanged |
| Generate → moderate → approve → post pipeline | Becomes the Reply persona's execution path at launch, later wrapped as graph steps |
| Auto-approval runtime (16 gates, `auto_approval_policies`) | Evolves into the trust dial's hard floor — extended, never rewritten |
| Moderation veto + `flagged_responses` (invariant #4) | Absolute veto above all autonomy — unchanged |
| Cost guard (reserve → finalize) | Mandatory on every new LLM call (triage, judge, insights) |
| `ReviewPublisher` seam (`ZernioPostingAdapter`) | Posting chokepoint; second adapter (`GbpPostingAdapter`) slots in when GBP access lands |
| Notification channels (email/SMS/Telegram/WhatsApp) | Guardian's escalation surface and the veto-window cancel surface |
| KPI/sentiment/weekly-report machinery | Repackaged as the Insights persona |
| Stripe subscription billing + migration-054 grandfathering | Launch billing as-is; tiers re-skinned Copilot/Autopilot |
| `eval:llm` harness | Wired into CI as a release gate |

**New builds (the actual gap):** run-spine tables (`agent_runs`, `agent_run_steps`,
`billable_outcomes` — attribution data, not an engine), triage step, Guardian escalation
branch + resolution tracking, trust-dial policy + settings UI, veto window, online judge
poller, autonomy health governor, persona surfaces. That's it for launch.

**Explicitly rejected:**

- **LangGraph (and agent frameworks generally) as the execution substrate.** Three reasons,
  in strength order: (1) LangGraph is an in-process graph runner — it does not ingest
  webhooks, survive deploys mid-run, or fan out across a fleet; it would sit *on top of*
  the queue/durability substrate we already own, adding a layer rather than replacing one.
  (2) Its checkpointer persists state on its own schedule, which fights invariant #2's
  state-change-plus-follow-up-in-one-transaction discipline. (3) The genuinely hard parts —
  tool authorization, tenant scoping, cost guarding, moderation veto, outcome emission —
  are RepWorth-specific and no framework provides them. Verified 2026-07-01: LangGraph is
  not in this codebase; adopting it would be a new dependency, not leverage.
- **Free-form LLM loops** (the LLM chooses actions at runtime). Disqualified by blast
  radius: side effects here are public posts on a business's Google profile. The LLM fills
  content inside deterministic graphs; it never chooses whether a side effect fires.
- **Durable-execution hosts (Inngest/Temporal) — for now.** Kept as the *named escape
  hatch* with a concrete tripwire: if the in-house run layer exceeds ~2–3k lines or starts
  growing replay/versioned-graph infrastructure, buy durable execution (Inngest first
  look). Do not reach for LangGraph at that point — the thing being rebuilt would be
  Temporal, which LangGraph doesn't solve either.
- **Agent frameworks are reserved for a future conversational surface** ("chat with your
  reputation manager") — a different layer that would call the same gated tools underneath.

**Reversibility hedge (binding):** agent-kind definitions are framework-agnostic data —
plain TS objects declaring steps, each step a typed function, side effects only via the
tool chokepoint. If the runner ever changes (in-house → Inngest → whatever), definitions
and tools survive untouched.

---

## 2. Product scope

### 2.1 Packaging: one platform, tiers gate autonomy

"SaaS 1.0 vs SaaS 2.0" is dead as a product split. One substrate; the tier gates autonomy
level and (later) agent roster:

- **Copilot** — agents draft, monitor, and report; the owner approves every public action.
- **Autopilot** — agents act autonomously inside the owner's policy (rating-band rules),
  behind the hard gates, veto window, caps, and governor. Premium price.
- A third tier slot is reserved for the expanded roster (Solicitation+), not defined now.

**Pricing at launch: flat per-location monthly tiers.** Outcome-*instrumented* from day
one (every agent action emits an immutable outcome row tied to its run), outcome-*billed*
never (for now). No Stripe Meters, no attribution billing, no drift reconciliation at
launch. Usage/outcome pricing is a post-PMF decision made with real data — the outcomes
table is what makes that decision possible later and is also the sales surface
("847 reviews handled this month").

### 2.2 v1 launch roster (personas)

| Persona | What it does | Build reality |
|---|---|---|
| **Reply** | Answers every review; auto-posts in the positive quadrant on Autopilot | Existing pipeline + trust dial + veto window |
| **Guardian** | Triages severity; on negative/flagged reviews: holds the drafted reply, escalates to the owner's channel with context + recommended action, tracks resolution | New but thin: triage classifier + escalation policy + resolution state. **No autonomous recovery actions** (that's v2 Complaint-Recovery) |
| **Insights** | Weekly digest: sentiment trend, KPIs, notable reviews, what the agents did | Repackaging of existing weekly-value-report/KPI machinery |

Three visible agents ≈ credible "agent team" positioning, at ~80% existing code.

### 2.3 v1.1: Solicitation (designed-for now, built after launch)

The review-growth agent ("get more reviews" is the stronger SMB value prop than "answer
reviews," but it's 5–6 weeks of greenfield with its own compliance surface — consent
ledger, suppression, deliverability, CAN-SPAM/TCPA — and does not belong on the launch
critical path). It is a first-class constraint on the substrate design *now*: it is the
only planned agent needing parent/child fan-out, batch-level approval, and long
attribution windows, and it becomes the run engine's first execution tenant (§4).
The May doc's §6 design (Batch + Outreach two-agent shape, consent/suppression schema,
`review_attributed` as the honest headline metric) remains the reference design for it.

### 2.4 Explicitly deferred

- **Multi-platform ingestion (Yelp/Facebook/Apple):** the `NormalizedReview` seam makes
  deferral free; each connector is weeks of API grief; Yelp is hostile to automation.
- **Competitor benchmarking:** `RankingTrackingWorker`/SerpAPI is a natural seed — later.
- **Social mention monitoring, SEO/local-listing management:** different products. No.
- **Conversational agent surface:** future; sits on top of the substrate.

---

## 3. Agent design

### 3.1 Runtime shape: trigger-shaped graphs, personas at the presentation layer

Marketing agents ≠ runtime agent kinds. Reply and Guardian share a trigger
(`review_inserted`) and a subject (one review); running them as independent concurrent
agents buys the cross-agent coordination problem (races on a business's public profile)
for zero benefit. Instead:

- **One `review_handler` run per review.** Early **triage step** (severity/sentiment
  classification — one LLM call, shared by both branches) routes: respond (auto or held
  per policy), escalate-to-owner, or both.
- **One `weekly_insights` run** on cron.
- **v1.1: `solicitation_batch` + `solicitation_outreach` runs** on owner action.

Personas are an explicit, tested **step→persona map** — an `attributed_agent` field on
run steps, the single authoritative answer to "which agent did this" for UI, telemetry,
and outcomes. One review = one run = one audit trail (also the better owner UX).

Consequences: **no coordination keys, no mutual-exclusion index, no supervisor agent in
v1.** The coordination primitive gets built when a future agent genuinely has an
independent trigger on the same subject (v2 Complaint-Recovery's multi-day resolution
workflow) — built against a real consumer, not on spec.

### 3.2 The run spine (launch) vs the run engine (v1.1)

**Launch ships run *data*, not a run *engine*.** Tables (`agent_runs`,
`agent_run_steps`, `billable_outcomes`) are written by the existing workers at their
natural checkpoints (ingest, triage, gate decision, notify, post) **in the same
transactions as the state changes they describe** — outbox discipline, never a
best-effort side log. This powers the persona timeline, outcome instrumentation, and
agreement-rate measurement — the 20% of the substrate that delivers 80% of the product.

**v1.1 builds the executor** (run lifecycle: start/advance/halt/resume; parent/child
fan-out) with Solicitation as its first tenant — greenfield, so no replay burden, and the
one agent that actually needs it. **Reply migrates onto the executor within one cycle
after**, validated by replaying against its own months of recorded real runs (better than
the May doc's synthetic golden replay). The spine is a bridge with a named far bank, not
a parking lot — these two mitigations are binding.

### 3.3 Trust dial: evolution of the shipped auto-approval runtime

- The existing **16 gates are the non-negotiable hard floor** for posting. Never
  rewritten, only extended. Moderation remains an absolute veto above all autonomy.
- On top: per-`(account, location, persona)` policy — **rating-band rules** (e.g.
  "auto-post 4–5★ unflagged; hold ≤3★"), daily auto-post caps, per-account kill switch.
  Schema is scoped by persona + action class so Solicitation's sends slot in at v1.1
  without a redesign; only Reply's posting policy is *built* at launch.
- **Veto window:** Autopilot replies post after a 15–30 min delay the owner can cancel
  from the notification. (`ReviewPublisher.deleteReply` also enables post-hoc undo.)
- **Autopilot grants immediate autonomy in the positive quadrant** (4–5★ unflagged) —
  no earn-in homework for a paying customer on the lowest-stakes public text there is.
  Agreement/edit/veto rates are instrumented from day one; that data is what later
  justifies widening autonomy below 4★ (where earned-trust logic genuinely belongs).
  **Negative-review autonomy is never granted at launch, on any tier** — that is
  Guardian's escalation lane.
- **Calibrated confidence routing is post-launch** — it needs outcome data that doesn't
  exist yet, and an uncalibrated confidence model is less trustworthy than the rule gates.
  When it arrives, it is a soft router *on top of* the hard gates, failing closed.

---

## 4. Build path

**Sequencing principle: launch-first on the hardened pipeline; build the engine for its
first real tenant.** (Inverts the May doc's substrate-first M1 gate, which existed to
serve the now-deleted migration.) Engines built with no consumer are the #1 slop source
in the prior plan; launch day should not ride on week-two substrate code.

| Phase | Scope | Estimate |
|---|---|---|
| **Phase 1 — Launch (v1)** | Run-spine migrations; triage step; Guardian branch (escalate + resolution tracking); Insights reframe; trust-dial policy + settings UI; veto window; online judge poller; autonomy governor; eval-in-CI; persona surfaces (timeline + exception-queue dashboard reframe) | ~4–6 wks |
| **Phase 2 — Run engine + Solicitation (v1.1)** | Run engine (lifecycle, parent/child) with Solicitation as first tenant: consent ledger, suppression, email adapter, batch approval, attribution (shadow-only metric) | ~6–8 wks |
| **Phase 3 — Reply migration (v1.2)** | Reply moves onto the executor; validated against recorded runs; legacy path retired | ~2–3 wks |
| **Phase 4+ — Later** | Confidence router + trust ladder widening; GBP adapter when access lands; third tier + roster expansion (Complaint-Recovery, competitor); coordination primitive when Complaint-Recovery needs it | — |

**Launch-track external items (status as of 2026-07-01):**

1. **Zernio automated posting — ✅ confirmed permitted.** Remaining follow-up: get the
   *limits* on record (volume/cadence caps, if any) so the veto-window delay and cadence
   policy can be tuned to numbers rather than guesses.
2. **GBP API access — application filed, outcome uncertain.** Posture regardless of
   outcome: **GBP-readiness**, so the adapter slots in whenever access lands (now or
   years from now). Concretely:
   - The seam already exists (`ReviewPublisher`); GBP is a second adapter, never a
     rewrite (per CLAUDE.md worker layout).
   - **Persist the Google-native review resource name from ingest onward.** Verified
     (2026-07-01): Zernio's `ZernioReview.name` already carries
     `accounts/{a}/locations/{l}/reviews/{r}` — the exact GBP resource-name format the
     GBP reply endpoint addresses — and `zernio-normalize.ts` parses it for location
     routing (`extractLocationFromReviewName`) then **discards it**, persisting only a
     synthetic `zernio://…` identifier. Action: add a nullable
     `reviews.google_review_name` column, populate from `z.name` at ingest (format-
     validated, fail-open to null). Historical backfill is possible from the raw
     payloads persisted in `inbound_events`. One residual check: confirm against a live
     payload that the account/location segments are Google-native IDs, not Zernio
     remappings.
   - Cadence jitter + caps live in the publisher **policy layer**, adapter-agnostic, so
     they govern any adapter.
   - The run-spine post step (and `responses`) records the **posting adapter slug**, so
     runs stay auditable across an adapter transition.
3. **Posting cadence as a policy variable from day one** — per-location jitter + daily
   caps in the publisher path, as insurance against pattern-detection flagging of
   *customers'* profiles.

---

## 5. Risks & guardrails

### 5.1 Launch-blocking guardrail set (Decision 8)

1. **Eval harness as CI gate** — PRs touching prompts, policy logic, or pinned model IDs
   run `eval:llm` and block on regression.
2. **Online judge on auto-posted replies** — async poller, LLM-as-judge through the cost
   guard; on flag: flips the account's dial to `hold_for_approval`, notifies the owner,
   alerts admin. Post-hoc and advisory-by-default; never in the posting latency path.
   **At launch, sample 100% of auto-posts** — at launch volume this costs pennies and buys
   the strongest claim while trust is thinnest ("every autonomous action independently
   reviewed within minutes"). Sampling is a dial turned *down* with volume.
3. **Autonomy health governor** — per-account rolling edit-rate / veto-rate /
   judge-flag-rate; crossing a frozen threshold auto-downgrades the dial (never silently).

### 5.2 Risk table

| Risk | Position |
|---|---|
| Public irreversibility of auto-posts | Hard gates + moderation veto + positive-quadrant-only + veto window + 100% judge + governor. Every layer fails toward "ask the owner" — degraded mode is a working Copilot product, not an outage |
| Always-on agent cost | Structurally bounded: no long-running processes; event-driven bursts; every LLM call (triage, generation, judge, insights) rides the two-phase cost guard; outcome rows give per-account unit economics from day one |
| Latency | A non-issue by design: review responses are asynchronous, and the veto window deliberately *adds* minutes. Nothing here needs streaming or sub-second paths |
| Zernio SPOF / platform ToS | Automated posting confirmed permitted by Zernio (limits TBD on record); GBP application filed; GBP-readiness items in §4 keep the adapter swap cheap either way |
| Judge/triage infra failure | Fail safe: triage inconclusive → negative/hold lane; judge down → auto-posting pauses, Copilot flow unaffected |
| Run-spine becomes permanent dual-truth | Binding mitigations: same-transaction writes only; Solicitation ships *on* the executor in v1.1 and Reply migrates one cycle later |
| In-house run layer grows into a bad workflow engine | Named tripwire: >~2–3k LOC or replay/versioning urges → buy Inngest/Temporal; definitions survive (framework-agnostic data) |
| Upstash single-instance SPOF (cache/rate-limit/cost-reserve) | Pre-existing, documented in CLAUDE.md; unchanged by this plan; judge/triage add read paths but the retry posture from #255 covers them |

---

## 6. Decision log (grilling session 2026-07-01)

1. **One product, one substrate.** Product unlaunched → all migration machinery deleted.
   "1.0 vs 2.0" survives only as tier packaging.
2. **Flat autonomy-gated tiers at launch** (Copilot/Autopilot, third slot reserved).
   Outcomes instrumented from day one, billed never (for now). Reuse existing Stripe
   subscription billing.
3. **v1 roster: Reply + Guardian + Insights.** Solicitation v1.1 (designed-for now).
   Multi-platform / competitor / social / listings deferred.
4. **In-house run layer on the outbox/BullMQ substrate. No LangGraph.** Framework-agnostic
   agent definitions; Inngest/Temporal escape hatch with a concrete tripwire; agent
   frameworks reserved for a future conversational surface.
5. **Trigger-shaped runtime graphs; personas at the presentation layer** via an explicit
   step→persona map. Shared triage step. Guardian = hold + escalate + track; no autonomous
   recovery. No coordination machinery until a real second-kind consumer exists (v2).
6. **Trust dial = evolution of the shipped auto-approval runtime.** 16 gates as hard
   floor; per-(account, location, persona) rating-band policy; veto window; Autopilot =
   immediate positive-quadrant autonomy; negative-review autonomy never at launch;
   confidence routing post-launch.
7. **Launch-first with a transactional run spine** (attribution + outcomes only);
   executor built in v1.1 for Solicitation; Reply migrates one cycle later against its
   own recorded runs. Two binding anti-dual-truth mitigations.
8. **Launch-blocking guardrails:** eval-in-CI, online judge at 100% initial sampling,
   autonomy governor. All new LLM calls ride the cost guard; everything fails toward
   "ask the owner."
9. **Zernio/Google posture never validated → three launch-track items:** written Zernio
   automated-posting terms; GBP API application filed now; cadence jitter + caps as
   day-one policy variables.

## 7. Assumptions flagged as unverified

- **Zernio automated posting** — confirmed permitted (2026-07-01). Still unverified:
  concrete volume/cadence limits in writing (launch-track item 1 follow-up).
- **Whether `ZernioReview.name`'s account/location segments are Google-native IDs** —
  the *format* is confirmed to be GBP's resource-name shape (verified in
  `zernio-normalize.ts`), but one live-payload check should confirm the embedded IDs are
  Google's, not Zernio remappings (launch-track item 2).
- **Tier price points** — deliberately not decided here; business decision, trivially
  changeable pre-launch. *(Resolved by WS8, see §8.2.)*
- **LangGraph as "existing tooling"** — verified false for this repo (2026-07-01):
  only raw `openai` + `@anthropic-ai/sdk` clients exist. Treated as aspiration, examined,
  and rejected for the execution substrate (§1).

---

## 8. As-built status (2026-07-22)

Reality overlay on the design above. Everything in this section is verified —
either merged to `main` or recorded in the staging evidence files.

### 8.1 Shipped — Phase 1 complete (WS1–WS8)

| WS | Shipped as | PR | Migration |
|---|---|---|---|
| WS1 Run spine | `agent_runs`/`agent_run_steps`/`agent_outcomes` + writer lib + pipeline instrumentation | #459 | 071 |
| WS2 Triage | `TRIAGE_ENABLED`-gated severity classification, cost-guarded, `triage_*` columns on `reviews` | #460 | 072 |
| WS3 Guardian escalation | raise → notify → acknowledge/resolve, `review_escalations` | #461 | 073 |
| WS4 Trust dial | rating bands, daily caps (default 10, ceiling 50), veto window (15/30 min), outcome instrumentation | #464 | 074 |
| WS5 Persona surfaces | run timeline, agent-team dashboard reframe, Insights labeling, escalation discharge | #465 | 075 |
| WS6 Judge + governor | `JudgeSweepPoller` (100% of auto-posts), `judge_verdicts`, `AutonomyGovernorScheduler`, suspension flow + admin `/admin/autonomy` (AAL2) | #466 | 076 |
| WS7 Eval-in-CI | path-filtered `llm-eval` release gate (observed live on PR #520) | #462 | — |
| WS8 Tier wiring | Copilot/Autopilot tiers, expand/contract cutover, `AUTOPILOT_PURCHASABLE` composed gate | #469/#470 | 077+078 |

Post-WS hardening also landed: agent-spine archival (079), scheduler outbox
dedup (080), poller cursors (081), failover indexes (082), owner-unreachable
escalation (083), plus the production-reliability wave (#495–#517).

**Staging proof** (evidence: `docs/runbooks/evidence/2026-07-21-…` and
`2026-07-22-…`): Phases A–D all PASS on a live Google profile — Copilot
full-loop, Guardian triage+escalation, Autopilot autonomy happy path
(auto-approve → veto window → real auto-post → judge verdict 43s later), all
three fail-safe drills, 12/12 WS8 smoke scenarios, real Autopilot checkout +
upgrade, trust-dial UI writes, AAL2 admin unsuspend. **Three launch-blocking
bugs found by live testing and fixed:** trial-checkout `payment_status` (#518),
onboarding page/route flag drift (#519), governor µs-truncation permanent
re-suspension immunity (#520).

### 8.2 Design → reality deltas

- **Prices set (was TBD):** Copilot $29 list / $19 founding; Autopilot $69
  list / $49 founding (monthly, per account; overage Prices $10/$20). Founding
  deadline 2027-01-01.
- **Triage refined:** positive-lane routing stays deterministic star sentiment;
  the LLM triage call runs only on the negative lane (≤3★/unrated),
  cost-bounded (~200 tokens, `gpt-4o-mini` pinned). Matches §3.1's intent with
  a cheaper mechanism than "LLM on every review."
- **Judge is STRONGER than designed:** §5.1 said post-hoc/advisory; as-built,
  judging is still post-hoc but `JUDGE_ENABLED=false` (or judge unavailability)
  **halts auto-posting** — the publisher downgrades unposted `auto_policy` rows
  to owner review. Auto-posting now has a hard dependency on the watchdog.
- **Veto window is an enum** (15 or 30 minutes, DB CHECK), not freeform.
- **`billable_outcomes` shipped as `agent_outcomes`** (Decision 2: instrumented,
  not billed — billing semantics can attach later without a rename).
- **Purchasability is a composed gate:** `AUTOPILOT_PURCHASABLE` AND
  `autoApprovalRuntimeEnabled()`; expansions blocked when closed, contractions
  always allowed. Runtime autonomy additionally requires the **autopilot tier**
  (`tierGrantsAutopilot`).
- **Cadence jitter (§4 item 3) is NOT built.** The veto window + daily caps
  provide spacing; explicit per-location jitter remains an open pre-scale item.

### 8.3 The agent roster as built

Three customer personas over trigger-shaped graphs (Decision 5): **Reply**
(drafts everything; auto-posts positive-quadrant on Autopilot), **Guardian**
(triage + escalate + track; never acts publicly), **Insights** (weekly digest).
Two watchdog automatons above them: the **Judge** (LLM review of 100% of
auto-posts; availability is a posting precondition) and the **Governor**
(autonomous per-account suspension with owner+admin notification; repeat-
offender path fixed in #520). Persona attribution via `attributed_agent` on
run steps, exactly per §3.1.

### 8.4 Go-live gates

| Gate | Status |
|---|---|
| Zernio automated posting | ✅ CLOSED — permitted, **no limits, pay-per-use per account** (`docs/runbooks/zernio-automated-posting-limits.md`; pacing is therefore entirely ours — caps/veto/jitter mandatory; pricing-unit + written-echo follow-ups open) |
| GBP API access | Application filed 2026-07-01, pending; `google_review_name` capture shipping since migration 070 keeps the adapter path open |
| Staging E2E (A–D) | ✅ PASS |
| Governor fix | ✅ merged (#520) |
| Production stack | **Not stood up — deliberate.** Strategy (owner, 2026-07-23): build + staging-prove everything, then one production bring-up at launch (prod Railway worker + Redis + env matrix, webhook endpoints → prod ingress, Vercel prod env, smoke). Prod Supabase migrations stay in lockstep meanwhile (verified through 083). |
| Prod WS8 cutover (`ws8-tier-cutover.md` — prod Stripe Prices + migration 078) | ❌ not run — folds into the production bring-up above; with 0 prod rows it collapses to Prices + env vars + 078 + smoke |
| Migrations 071–083 applied to PROD Supabase | ✅ **verified by introspection 2026-07-22** with ONE expected gap: 071–077 + 079–083 all present; **078 (contract CHECKs on `accounts`/`businesses.subscription_tier`) is deliberately absent** — prod sits in the expand/contract half-state because 078 applies *inside* the prod WS8 cutover, after its controlled smoke (`ws8-tier-cutover.md`). Prod `accounts`/`businesses` have **0 rows**, so the contract step is trivial when the cutover runs. Do not apply 078 out-of-band. |
| Owner UAT (`owner-uat-agentic-staging.md`) | pending |
| Ordered prod flag flip (`TRIAGE` → `ESCALATION` → `JUDGE`+`GOVERNOR` → `AUTO_APPROVAL`; then `AUTOPILOT_PURCHASABLE`) | not started — **all autonomy flags OFF in production** |

**Launch posture (unchanged from §4):** Copilot is launchable now with zero
autonomy flags; Autopilot flips only after the gates above, Copilot-first.

### 8.5 Deliberately still NOT built (per this design)

Run engine/executor (Phase 2, Solicitation is its first tenant), Solicitation
agent (v1.1), calibrated-confidence router, GBP posting adapter (awaiting
access), conversational surface, cross-agent coordination keys, outcome
billing. None of these block launch; all remain sequenced as §4 specified.

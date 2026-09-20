# Unified proposal — Pathfinder 2026-09-12

Ten proposals, ranked at the end. **U1 is the one Run B reads**; everything
else can wait for an owner priority.

---

## U1 — The Owner Operator seams, ruled one by one for Run B

Run B adds **Apply**, **Decline**, **receipts**, and the **Operator screen**,
plus two new POST routes. Each seam below is answered as the intake asked:
*deepen, or fine as-is* — and where Run B would be **forced** to duplicate or
widen, that is named with the `file:line` of the thing it would duplicate.

**Everything in this section is LATENT.** `OWNER_OPERATOR_ENABLED` is unset in
every environment (`docs/currents.md:16`; `readFlag` is
`process.env[name] === 'true'`, `src/lib/config/flags.ts:21-23`). Nothing here
can fire in production today. It can fire on the day Run B ships.

### U1-A · **The one that must be fixed before Run B ships anything that writes** — `/api/operator` is outside the owner-API MFA gate

```
$ rg -n 'operator' src/lib/shared/protected-routes.ts \
                   src/lib/shared/__tests__/protected-routes.test.ts
(no output)
```

`isProtectedOwnerApiRoute` (`src/lib/shared/protected-routes.ts:47-59`)
enumerates `/api/dashboard`, `/api/settings`, `/api/account`, `/api/billing`,
`/api/locations`, plus three explicit Zernio paths and two `Set`s.
**`/api/operator` is in none of them.** Branch 6 of the proxy
(`src/proxy.ts:349-364`) — which applies `getAalGate()` (`:260-271`) to every
owner API route — therefore never runs for an Operator route.

**What the routes DO have.** `POST /api/operator/turns` is not unguarded:
`withSameOrigin()` (`turns/route.ts:101`) and `requireWritableOwner(sql, request)`
(`:37`) give it role + `account_id` + writable-subscription + the
`isProcessingBlocked` offboarding gate
(`route-helpers.ts:133-146` → `writable-subscription.ts:80-135`). **The
missing piece is AAL2/MFA only** — and that is exactly the bar every other
owner mutation surface clears.

**Reachability, stated honestly and twice qualified.** LATENT on two
independent grounds: the flag is off, **and** `getAalGate` short-circuits to
`'ok'` whenever `mfaEnforcementEnabled()` is false
(`src/proxy.ts:261-263`, `src/lib/auth/flags.ts:33-35`). This pass did **not**
read the deployed `MFA_ENFORCEMENT_ENABLED` value. So: **not a live hole
today, and not an incident.**

**Why it still ranks first.** Run B's whole content is two POST routes that
move real owner state — voice configuration now, auto-approval policy later.
Shipping them at a **lower MFA bar than `PATCH /api/settings/voice`, which
changes the same rows**, is the kind of asymmetry that is invisible once it
exists. The fix is **one line plus one test**:

```ts
normalized === '/api/operator' || normalized.startsWith('/api/operator/')
```

→ **H1-A.** Land it with Run B's first route, not after.

### U1-B · `src/lib/agents/operator/proposals.ts` — **deepen, and the schema is already ahead of the module**

The lifecycle vocabulary is **complete and needs nothing**: `PROPOSAL_STATUS`
= `PENDING | APPLIED | STALE | REJECTED | FAILED | SUPERSEDED`
(`src/lib/agents/operator/schema.ts:14-22`), narrowed by `asProposalStatus`
(`:39-45`), and the DB `CHECK` mirrors all six byte-for-byte
(`supabase/migrations/120_owner_operator.sql:105`). **Run B's states need zero
new vocabulary.** That is the pleasant surprise of this review.

**No apply/decline transition exists, not even unused.**
`rg -ni 'applyProposal|declineProposal'` over `src/lib/agents/operator`,
`src/app/api/operator`, `worker/jobs/agent-turn` returns **one** hit:
`__tests__/catalog.test.ts:52`, which *asserts* `apply_proposal` and
`decline_proposal` are **absent** by design (`catalog.ts:1-6`: *"the
Apply/Decline commands are Run B and are deliberately absent"*).
`proposals.ts` exposes only `insertProposals` (`:88-116`),
`supersedePendingProposals` (`:135-159`), the three list functions
(`:209-269`) and the unsupported pair (`:279-313`). **No lock, no version-token
compare, no transition to `applied`/`rejected`/`failed`.**

**The read shape is the gap, and it is narrow.** `StoredRow`/`ProposalView`
(`:161-183`) select `id, operation, contract_version, label_kind, location_id,
status, rationale, input, before, after` and **never** the five columns
migration 120 already provides for Apply: `superseded_by`, `decided_by_user_id`,
`applied_at`, `receipt`, `failure_reason` (`120_owner_operator.sql:106-110`).
**Schema ready; TS module not.**

What Run B is forced to add — and the blast radius of each:

| | Kind | Blast radius |
|---|---|---|
| `src/lib/agents/operator/apply.ts` with `applyProposal`/`declineProposal` | **new file** | none |
| widen `StoredRow`/`ProposalView`/`mapStored` (`:161-207`) with the five columns | **widen** | small — only `reads.ts` and the two GET routes consume `ProposalView` |
| a `SELECT … FOR UPDATE` on `agent_proposals` | **new** | none — nothing in `proposals.ts` takes a row lock today |
| a JSONB parse site for `agent_proposals.receipt` | **new** | follow `schema.ts:211-242`'s `parseJsonbObject`/`parseReplySegments` pattern, **and add the site to the PgBouncer-JSONB allowlist** in lab-notes/postgres.md, per CLAUDE.md's gotcha |
| widen `RenderedSegment` (`render.ts:376-382`) + `renderSegments`'s switch (`:395-435`) for a receipt branch | **widen** | small — `reads.ts:97`, `:213`, tests |

**One efficiency note, not a blocker:** `insertProposals` is a single-row loop
(`for (const row of rows) await tx\`INSERT…\``, `:89-115`). Bounded at ≤ 5
proposals per turn (`schema.ts:206`) and sequential, so it is
`ci:pool-fanout`-clean — but it is an N+1 inside a transaction, and Apply's
receipts will add another. Worth a set-based rewrite **only if** Run B's
receipts push the count up.

### U1-C · The voice writer — **fine as-is, reuse it verbatim. The one seam needing nothing.**

`src/lib/responses/voice-settings.ts`. Its header states the extraction reason:
*"extracted from `src/app/api/settings/voice/route.ts` so the settings route
and the Owner Operator share one lock order and one column map"* (`:1-4`).

- `readVoiceConfig(db, {accountId, locationId})` — `:79-100`. **Four callers
  already:** `settings/voice/route.ts:44`, `operator/reads.ts:245`,
  `operator/context.ts:332`, `worker/jobs/agent-turn/AgentTurnWorker.ts:211`.
- `updateVoiceConfig(tx: TransactionSql, {accountId, locationId, fields})` —
  `:115-156`. Locks `businesses FOR UPDATE` first (`:119-126`), builds a
  partial column-map update (`:129-134`), returns `updated_at::text` as the
  version token (`:147-155`). **Exactly one caller today**
  (`settings/voice/route.ts:165`, inside `sql.begin`).

**It is a deep module, not a pass-through.** It owns the lock order, the
column map (`VOICE_FIELD_TO_COLUMN`, `:29-35`), the shared limits
(`VOICE_FIELD_LIMITS`, `:47-53` — reused by both the route's zod schema **and**
`catalog.ts:108-121`), the no-fields and not-found branches, and the
microsecond-safe `updated_at::text` spelling on **both** sides (`:74-77`,
`:140-146`) — which matters because of CLAUDE.md's `timestamptz` µs-truncation
gotcha.

**Run B's voice executor is:** lock (already inside `updateVoiceConfig`) →
`spec.apply(voice, input)` from `catalog.ts:78` for the new field values →
`updateVoiceConfig(tx, …)` inside Apply's own `sql.begin`. **No signature
change, no new export.** Note that `catalog.ts`'s `apply` (`:78`, used at
`:145/155/163/171`) is a **pure in-memory transform** for the `before`/`after`
preview and persists nothing — that is the correct division.

### U1-D · `getAutoApprovalSettings` is fine; **its writer sibling is the one genuine forced widening** · LATENT

`getAutoApprovalSettings(db: Sql | TransactionSql, {accountId, impersonated})`
— `src/lib/auto-approval/settings.ts:164-167`. Takes `db` explicitly
(invariant #15 clean) and accepts **either** handle via the `SqlExecutor` alias
(`:49`). Four read-only callers: `operator/context.ts:328`,
`operator/reads.ts:241`, `settings/auto-approval/page.tsx:17`,
`api/settings/auto-approval/route.ts:28`. **Reuse verbatim.**

**`patchAutoApprovalSettings(sql: Sql, input)` (`:199-209`) cannot be reused
from inside Apply's transaction.** It is narrowed to `Sql`, not `SqlExecutor`,
and opens **its own** `sql.begin` at `:206`.

```
$ rg -n 'patchAutoApprovalSettingsInTransaction' .
docs/roadmap/2026-09-11-owner-operator.md:397
docs/roadmap/2026-09-11-owner-operator.md:532
docs/superpowers/plans/feat-owner-operator-run-a-intake.json:16
docs/superpowers/plans/feat-owner-operator-run-a-plan.md:19
```

**Four hits, all in specs. Zero in code.** The spec names it as Apply's
executor (`README.md:397`) and prescribes the exact fix (`:532`: *"export
`patchAutoApprovalSettingsInTransaction(tx, input)` (the current private
`updatePolicyInTransaction` plus the settings reload), keep
`patchAutoApprovalSettings` as the thin `sql.begin` wrapper the route uses"*).
`README.md:643` already lists it as an accepted Run A design finding —
**known and planned, not built.**

The transaction-aware building blocks `updatePolicyInTransaction` (`:216`) and
`lockAccount` (`:379`) are **module-private**: `rg -n '^export'
src/lib/auto-approval/settings.ts` lists only the two types, the error class,
`getAutoApprovalSettings` and `patchAutoApprovalSettings`.

**Forced widening, small blast radius, and the spec already chose the shape.**
Two real callers to check (`api/settings/auto-approval/route.ts:57`,
`scripts/ws8-staging-smoke.ts:500`). Do it the spec's way — export the
in-transaction function, keep the thin wrapper — rather than writing a
parallel executor. → **H1-C**

### U1-E · `turns.ts`, `reads.ts`, `render.ts` — **fine as-is**

- **`turns.ts`** (510 lines). `createTurn(sql, input)` (`:90-118`) wraps
  `createTurnInTransaction` (`:120-214`, one `sql.begin`); the worker-side
  fenced functions live at `:239-509`. Apply is a **sibling** transactional
  writer, not something layered on `turns.ts`. Its header (`:1-3`) draws that
  boundary. **No widening.**
- **`reads.ts`** (278 lines). `getTurnForOwner` (`:70-103`) and
  `getConversationForOwner` (`:156-274`) are **account-scoped** — every
  statement filters `account_id` (`:81, :88-90, :164-166, :170-171, :185-186`)
  and resolves the target location internally from the most recent turn
  (`:196`, `:239-248`). The summary is `null`, never zeroed, when there are no
  turns (`:122-144`, `:219-225`) — the right shape. **And it already reuses
  the granular helpers rather than duplicating them**:
  `getAutoApprovalSettings` (`:13, :241`),
  `getPendingApprovalCountsForAccount` (`:14, :236`),
  `getLocationsForAccount` (`:15, :90, :197`), `readVoiceConfig` (`:16, :245`).
  **This is the model Run B should copy for Apply.**
- **`render.ts`** (435 lines). Pure and DB-free by design (`:1-3`).
  `validateModelOutput` (`:264-276`), `materializeReply` (`:334-362`),
  `renderSegments` (`:395-435`). Receipt rendering is a natural additive
  extension; the only cost is widening the `RenderedSegment` union
  (`:376-382`) and its switch — few callers.

### U1-F · The gate helpers — two reusable verbatim, **one does not exist**

| Concern | Canonical helper | Can Run B's two POSTs reuse it verbatim? |
|---|---|---|
| same-origin | `withSameOrigin()` — `src/lib/auth/route-helpers.ts:25-39`. Used at `turns/route.ts:101`, `settings/voice/route.ts:187`, `settings/auto-approval/route.ts:136`. **One implementation, no competitors** | **Yes** |
| writable-owner | `requireWritableOwner(sql, request)` — `route-helpers.ts:133-146`, built on `requireOwnerWithAccount` (`:113-122`) + `assertWritableSubscriptionForAccount`. Used at `turns/route.ts:37` | **Yes** — and the spec agrees (`README.md:265-266`) |
| **impersonation rejection** | **none exists** | **No — see X6** |

The two GET routes use the weaker `requireOwnerWithAccount`
(`turns/[id]/route.ts:25`, `conversation/route.ts:24`), which is correct:
reads stay available to a past-due account.

`requireSettingsOwner` (`route-helpers.ts:167-184`) is a **different gate for a
different route family** — it rejects an `?accountId` parameter before
resolving the owner and checks `isOperationalUIBlocked` rather than
`isProcessingBlocked`. Not a competitor.

**The impersonation gap.** `hasImpersonationCookie` is defined **twice**,
byte-identical, as a private function:
`src/app/api/operator/turns/route.ts:97-99` and
`src/app/api/settings/auto-approval/route.ts:116-118`.
`src/lib/admin/impersonation/cookie.ts` exports the cookie **name** (`:38`)
and sign/verify helpers (`:23-36`) — **no boolean-check export**.

Run B's `apply` and `decline` both need the check (an impersonating admin may
look, never act — `turns/route.ts:40-44`). **Adding them without extracting
makes it four copies.** Extract once, into `route-helpers.ts` or
`impersonation/cookie.ts`, **before** Run B lands. → **H1-B**

### U1-G · The dashboard payload — **the intake's premise is wrong, and Run A already did the right thing**

Run B's summary panel was expected to *"REUSE the dashboard payload."*
Field by field, against `src/lib/dashboard/types.ts`:

| | Verdict | Evidence |
|---|---|---|
| **rating band** | **present-but-shaped-wrong** | `ReputationSummary.averageStar` (`types.ts:33`, metric shape `:19-27`) is `{current, delta, priorSampleSize}`; `RatingBreakdown` (`:58-62`, built `rating-breakdown.ts:26-50`) buckets **all rated reviews** by star. The Operator wants **pending drafts by star** (`catalog.ts:132`). No band **enum** is on the payload at all — `RepPulseBand` (`rep-pulse.ts:34, :52-57`) is computed client-side and never sent. Run A already built the right reader: `readStarBands` (`operator/context.ts:192-232`) |
| **pending count** | **present, already correctly reused** | `getPendingApprovalCountsForAccount(sql, accountId)` — `src/lib/dashboard/pending-count.ts:35-55`, called at `operator/reads.ts:236` with the spec citation in the comment (`:227-232`). **No work needed** |
| **posted count** | **absent** | `ValueSummary.totalReviewsHandled` (`types.ts:66`, built `service-mappers.ts:52`) is all-time cumulative *handled*. `PerLocationKpi.recentReviewCount` (`types.ts:213`, `aggregate-queries.ts:311`) is a capped *received* sample. Neither is `posted_7d`. Run A built `readPosted7d` (`operator/context.ts:241-251`, `status='posted' AND posted_at >= NOW()-7d`), reused at `reads.ts:237` |
| **location list** | **absent from the per-location DTO** | `DashboardDataActive` carries only `business:{name, createdAt}` (`types.ts:107`). The aggregate has `locationKpis: PerLocationKpi[]` (`:207-217`) — a KPI projection, not a roster. The canonical roster is `getLocationsForAccount` (`src/lib/locations/repo.ts:64`), already shared by `aggregate-service.ts:122`, `operator/reads.ts:90, :197`, `operator/context.ts:336`, `settings/voice/route.ts:75` |

**Both builders are plain functions taking `sql`** —
`getActiveDashboardData(sql, businessId, opts)` (`service.ts:129-140`) and
`getAggregateDashboardData` (`aggregate-service.ts:92`). No React
server-component context needed. **That half of the premise holds.**

**The proposal: Run B reuses the granular helpers, not the assembled DTOs, and
the intake is corrected to say so.** Pulling in `DashboardDataActive` or
`AggregateDashboardData` would import a 45-second Redis TTL cache
(`service.ts:64`, `aggregate-service.ts:67`), ranking, velocity and briefs the
Operator does not want, **and** two of the four fields would still be wrong.
Run A's pattern is correct; Run B should extend it. → recorded in **H1-D**, a
documentation change, not code.

### U1-H · One thing Run B must **not** silently inherit

`src/lib/agents/operator/` and `worker/jobs/agent-turn/` use **no run spine**
— `grep -rn 'agent_runs\|agent_outcomes\|run-spine'` over both returns
nothing. This is deliberate (the Operator has its own four tables from
migration 120), but **CLAUDE.md's sentence *"Every persona action is recorded
on the run spine"* describes Reply/Guardian/Insights only**, and a Run B
author applying it literally will look for rows that do not exist. One
clarifying clause in the routing row. → **H8**

---

## U2 — The entropy counter gets one owner and becomes a derivation

The 08-26 pass's H7, unlanded, restated with a bigger number: **21 stated
against 83 measured.** Design unchanged and still right — one owner (the
bottom table), keyed by **merge SHA**, with a `counts` boolean set by
`isProductionFile` (`scripts/ci/merge-ledger-audit.ts:96`), a classifier
`ci:merge-ledger` already computes on every run and discards.

Two additions this window justifies:

1. **The audit already knows the answer and throws it away.** `classifyDiff`
   (`:111-117`) returns `{production, governance}` on every run. Writing
   `counts: production.length > 0` into the required ledger line costs
   nothing and makes the counter a `grep -c`.
2. **Mark the governance-only rows.** 17 of this window's 100 triggering
   merges were required to leave a line and required not to increment. Under
   the SHA + boolean design they classify themselves; under today's design
   they are indistinguishable from counting merges, which is reason 3 of the
   four the log already lists. → **H2**

## U3 — One claim contract for the notice family, and the bounced check moves with it

`delivery.ts` went from **2** claim functions to **5** in one window while the
handoff to consolidate it sat unactioned (`07-handoff-reverification.md` §E).
The two 08-24 bugs are both still present.

**The design has three parts and they must land together**, because the
duplication is *why* the bugs persist:

1. **One claim contract.** Five functions (`delivery.ts:84, :113, :143, :194,
   :278`) differ on exactly two axes: does it reap a stale row, and does it
   distinguish `settled` from `pending`. **Three variants across five
   members** — no reap (2), reap only (1), reap + split (2). Make the reap and
   the split unconditional; take `template` as a parameter. The
   `ON CONFLICT` key columns (`:80-82`) stay per-member — the register
   protects them and they are genuinely different.
2. **Extract `resolveExistingClaim`** (`delivery.ts:249-259` ≡ `:327-337`) as
   the first step — it is a private helper inside one file, touches nothing
   the register protects, and is the cheapest proof the consolidation is
   tractable.
3. **The bounced-owner check moves to the shared context builder.** Eleven
   private gating sites (`07-handoff-reverification.md` §D), and the one
   member with none is the highest-volume one. Five of the six context
   modules already run the same query; put the check where the query is.

→ **H2** (counter) is independent; this is **H2-N**, ranked with H3.

## U4 — Import the Stripe retry-policy owner at the two sites that shadow it

Two byte-identical private copies with the **same identifier** as the shared
export (X3). The fix is two imports and two deletions. The reason it ranks
above other duplication: **it is a live behavioural divergence, not a
maintenance hazard**, and the shadowing-by-name makes it invisible to review.
→ **H3**

## U5 — The three private `boundedErrorClass` copies import the hardened one

X4. Three imports, three deletions. The export is already the better
implementation. → **H4**

## U6 — One `starGlyphs`, one `FeatReceipt` import, one advisory panel

The three cheapest UI unifications (X7, X11, X12), all with the owner either
already written (`FeatReceipt`) or trivially derivable. Bundle them; they
touch disjoint folders and none is on a register. → **H5-B**

## U7 — Name the "five jobs" once

X5. One product taxonomy, four re-cuts, one admitted rename (Protect →
Govern), one invented fifth concept (Record). **This is a product decision
this pass does not make** — the options are (a) one shared constant with
per-page presentation, (b) an explicit documented mapping, or (c) a decision
that the pages address different audiences and the lists may differ. All three
are legitimate; silence is not. → **H5**

## U8 — Give the enumerated-guard class its completeness rule, at last

The 08-26 pass's PR 2, **partially landed**: the `scannedCount === 0` fatal
exists in exactly one guard, locally
(`scripts/ci/pool-fanout-audit.ts:530-539`), not in `ratchet-harness.ts`, and
`SCAN_DIRS` is exported by exactly one of ~13 audits.

**This window produced two new members of the class, which is the argument for
finally doing it:**

- `DELETABLE_BY_BUSINESS` (13 tables, `purge-helpers.ts:61-75`) vs
  `ABSENT_BY_BUSINESS_TABLES` (11, `purge-verification.ts:772-784`) — two
  hand-typed sets that should mirror, with **nothing asserting they do** (X-F7).
- The two `docs/directory/*.md` pages at exactly 3,000 words (X8) — an
  enumerated inventory with a hard cap and **no warning band**.

Design unchanged from 08-26: **step 1** `scannedCount === 0` fatal inside
`ratchet-harness.ts` (one place, every harness user; only 6 of 46 guards
notice an empty scan today); **step 2** export every `SCAN_DIRS` and add one
`ci-audit-wiring` case that fails on a directory covered by zero audits.
**Do NOT collapse the 25 `SCAN_DIRS` into one constant** — the 08-26 register
rules against it and `ratchet-harness.ts:5-7` states why. → **H9**

## U9 — `owner_leads` gets a disposition

Unchanged from 08-26's PR 3, and this window sharpened the case:
`table-disposition.ts` **was edited on 2026-09-12** by #1270, to add the four
Owner Operator tables, and `owner_leads` was not added. One row. The
classification (scrub / delete / consciously retain) is a product decision.
→ **H9-C**

## U10 — Fix the four stale prose claims this pass measured

Four documentation defects, each a one-line fix, each of the same class the
pass's headline describes — a claim with nothing deriving it:

| # | Claim | Truth |
|---|---|---|
| 1 | `.claude/CLAUDE.md:47` — *"18 of 32 topics today"* | **37** topics (`queue-names.ts:12-71`), **19** helpers. The numerator is right by coincidence |
| 2 | `docs/directory.md:39` — `app-admin.md` covers *"overview, jobs, costs, notifications, runbook, businesses/…"* | All deleted. The target file says *"After #1193, five pages remain"* (`app-admin.md:5`) |
| 3 | `docs/directory.md:115` — `useAdminActionForm` serves **five** surfaces | **One** (`rg -ln 'useAdminActionForm' src/`) |
| 4 | `docs/adr/0001-…:41-43` — the admin disconnect route uses a *"bearer-aware same-origin wrapper"* | Deleted by #1266. Plus `nav-counts-service.ts:16` (*"behind `requireRoleOr401(admin)`"* — it is `requireAdminWithAal2`), `purge-stages.ts:757-763` (the inverted D5 ordering), `stripe-error-inspect.ts:9-15` (`stripe-invoices.ts` no longer owns a policy) |

→ **H6**

---

## The combined picture

Three mechanisms produced almost every finding in this pass, and they are the
same mechanism seen from three angles:

**1 — A fact recorded only in prose is not maintained.** The counter (83 vs
21). Four stale doc claims. Six standing obligations at 0-for-6. The
issue-number rule that was itself a prose handoff. **The single cleanest
evidence is now a controlled experiment**: 08-18's H1–H7 got issue numbers
#890–#896 and 3 of 3 tracked items landed; 08-24's and 08-26's got prose and
0 of 6 landed across two windows, one of them 177 merges long.

**2 — An enumerated scope with no completeness rule silently goes stale.**
`table-disposition.test.ts` still cannot see `owner_leads`. `ci:pool-fanout`
still cannot see `contacts-repo.ts:103`. Two purge table sets that should
mirror and nothing checks. Two directory pages at a hard cap with no warning
band. ADR 0029 D5's file list one file short. **The class the 08-18 pass named
has produced new members in every window since.**

**3 — A one-owner extraction is only as good as the grep that finds it.**
#1126 created `stripe-retry-policy.ts` and two sites in the same lane still
shadow it *by the same name*. `FeatReceipt` exists with a docstring saying it
is the owner, and the sibling directory hand-rolls it four times.
`ReviewStars` exists and seven Console sites do not use it. **The owner
existing is not the finish line; the last caller importing it is.**

Against that, three genuine successes worth copying:

- **#1118's popover split** — one core, two layers, each documented with the
  reason the other cannot serve, no third copy anywhere (F5 §3).
- **The Admin contract sharing one route-walk with `ci:admin-aal2`**
  (`admin-contract-audit.ts:6`) — two audits over one subject with one walker.
- **The ten-PR retirement** — one page per merge, parity before deletion, one
  sweep at the end (F3).

---

## Ranked

| Rank | | What | Why now |
|---:|---|---|---|
| 1 | **H1-A** | `/api/operator` joins the owner-API MFA allowlist | **One line. Must precede Run B's first writing route.** LATENT today |
| 2 | **H1-B** | Extract `hasImpersonationCookie` before Run B adds copies 3 and 4 | Cheapest possible fix, and the window to do it closes when Run B lands |
| 3 | **H1-C** | Export `patchAutoApprovalSettingsInTransaction` per spec §10 | Run B is **blocked** on it for the auto-approval executor |
| 4 | **H2** | The entropy counter gets one owner (the 08-26 H7) | Error grew 4 → **62** in 17 days |
| 5 | **H3** | Import the Stripe retry-policy owner at the two shadowing sites | **The only LIVE behavioural divergence in the pass** |
| 6 | **H2-N** | One claim contract for the notice family + the bounced check | Grew 2 → 5 while unactioned; two 08-24 bugs still present |
| 7 | **H6** | Fix the four stale prose claims (+3 code comments) | Four one-line fixes; the pass's own headline class |
| 8 | **H9** | The enumerated-guard completeness rule (08-26 PR 2, finish it) | Two new members this window |
| 9 | **H4** | Three `boundedErrorClass` copies import the hardened export | Observability consistency; three imports |
| 10 | **H5 / H5-B** | Name the five jobs once; the three cheap UI unifications | Product decision + the cheapest wins in the report |
| 11 | **H7** | Seven legacy topic literals; no-store on ~16 admin error bodies | Working-rule compliance, low risk |
| 12 | **H8 / H9-B / H9-C / H10** | Run-spine clarification · directory-page cap warning · `owner_leads` disposition · an `OutboxPoller` heartbeat row | Each small, none urgent |

## Two corrections this pass made to its own findings

1. **The arch log's "six domain terminals emit logs only" is misleading as
   compressed, and the pass nearly repeated it.** All six write the turn row
   **and** complete the outbox row in one transaction. The claim is true only
   about the alerting channel. The genuinely write-nothing exit is the
   lease-lost branch at `AgentTurnWorker.ts:367-372`, which the spec correctly
   excludes from the six. Corrected in F1.
2. **The Run B intake's "reuse the dashboard payload" premise is wrong, and
   the first draft of this section accepted it.** Field-by-field measurement
   (U1-G) shows two of four fields absent and one shaped wrong — and that Run
   A had already chosen the correct pattern. **The seam review's job was to
   confirm a reuse and it refuted one instead.** That is the result.

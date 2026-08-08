# Consented Review Import — Design

**Date:** 2026-08-05
**Status:** Design agreed, not yet implemented
**Replaces:** the unconditional first-connect backfill behaviour in
`worker/jobs/zernio/ZernioBackfillWorker.ts`

---

## 1. Problem

Today, when an owner subscribes and connects Google, `ZernioBackfillWorker` runs
without asking and, on its own initiative, generates up to **75 draft replies**
(25 "gap" + 50 "historical", `ZernioBackfillWorker.ts:192-193`). Three problems
follow from that:

1. **Speculative LLM spend.** Every draft is an LLM call for a reply the owner
   may never look at, let alone post.
2. **The diligent business gets an empty dashboard.** Only *unanswered* reviews
   are drafted. An owner who has been answering their reviews by hand has zero
   unanswered rows in the fetch window, so the backfill produces nothing and
   they land on an empty screen. This is worst for the best-run businesses.
   Confirmed on staging: both real backfill runs recorded
   `gap_processed_count = 0`.
3. **No consent.** Importing an owner's review history is a data-import act
   performed silently.

Additionally the fetch is capped at 4 pages (200 reviews,
`ZernioBackfillWorker.ts:139-143`) and truncates **silently** — unlike the ingest
worker, which raises `ZernioIngestPaginationCapExhaustedError` when it hits its
cap with a `nextPageToken` still set (`ZernioReviewIngestWorker.ts:170`).

---

## 2. Decisions (locked)

| # | Decision |
|---|---|
| D1 | **Ask before importing.** A one-time prompt at the subscribe + connect junction. |
| D2 | **Nothing is auto-drafted.** The import stores reviews; it writes no replies. |
| D3 | **Newest 100 reviews**, count-driven — not a date window. |
| D4 | **12-month floor.** Nothing older than 12 months is imported. The 100 is a ceiling, the 12 months a hard stop; whichever binds first wins. |
| D5 | **Import answered and unanswered reviews alike.** |
| D6 | **One list, unanswered sorted to the top.** No answered/unanswered toggle. |
| D7 | **Per-row action:** `Generate` when unanswered, `Regenerate` when already replied. Owner-initiated only. |
| D8 | **The offer expires after 7 days**, then is permanently unavailable — including via the admin re-enqueue path. |
| D9 | **Fetch happens on Yes**, never before. |
| D10 | Copy says **"This is a one-time import."** Not "not even support." |

### 2.1 Why count, not a time window (D3)

A fixed window applied to variable volume breaks at both ends: a barbershop at
3 reviews/month sees an near-empty list, a busy restaurant at 400/month gets a
flood. A count self-adjusts — the slow business reaches further back, the busy
one stops at recent.

More importantly, **"all your reviews from the past N months" is a completeness
promise the fetch cannot honour.** `listReviews` sends no ordering parameter
(`src/lib/zernio/client/locations.ts:41`) and pagination is a forward walk with
a page cap. "Your 100 most recent reviews" is self-evidently a top-N and
promises nothing that can be falsified.

### 2.2 Why the expiry removes the anchoring problem (D8)

An import offer that persisted (e.g. permanently in settings) would decay into
incoherence: a year later, "newest 100" is mostly reviews RepWorth already
ingested live, and the pre-signup history the owner actually wanted has scrolled
out of the window. That would have required anchoring the window to
`subscription_activated_at`.

Because the offer expires in **7 days**, "newest 100 right now" and "newest 100
from before they signed up" are the same set give or take a week. **No anchoring
logic is needed, and the gap/historical split disappears entirely** — reviews
that landed between subscribing and connecting are simply part of the newest 100
and cannot fall through.

### 2.3 Why the fetch must be lazy (D9)

Pre-fetching means storing the owner's reviews before they have consented — and
storing them *is* the import. The prompt would be asking permission for
something already done. Fetching on Yes is the only version where the question
is honest. (Freshness is a secondary benefit: a click on day 6 against a day-0
fetch would be a week stale.)

---

## 3. User-facing flow

```
subscribe ──┐
            ├──► whichever lands SECOND ──► prompt
connect ────┘                                 │
                                              ├── Yes ──► enqueue import ──► worker fetches
                                              │                                    │
                                              │                              list populates
                                              │
                                              └── No / no answer ──► offer expires at T+7d
                                                                      (permanent)
```

The prompt states, in substance:

> **Import your recent reviews?**
> We can pull in your 100 most recent Google reviews so you can generate replies
> for them. Nothing gets posted — you choose what to reply to.
> **This is a one-time import.**
> New reviews will still be handled automatically either way.

The last line is **required**. Without it, declining reads as "I turned the
product off," which is the one way this design can cause a churn event.

After a Yes, the UI shows an "importing your reviews…" state; the list fills in
when the worker finishes. The click must not block on the fetch.

---

## 4. Data model

New per-location consent record, as columns on the existing `businesses` row
(owner call at charting, map #667; migration 100 / #673):

| Field | Purpose |
|---|---|
| `import_decision` | `pending` \| `accepted` \| `declined` — no stored `expired` value; expiry is derived (§5.3, #670) |
| `import_decision_at` | when the owner answered |
| `import_offer_expires_at` | prompt creation + 7 days |

**Server-side, per location.** Not `localStorage` — a "permanent" dismissal that
resets on a new browser is not permanent, and multi-location accounts connect
each location separately with its own review history (invariant #9).

`zernio_backfill_runs` keeps its role as the run record. Its
`gap_*`/`historical_*` counters lose their meaning under D2/§2.2 and collapse to
`imported_count` + `skipped_count` (map #667). **That collapse lands in two
migrations, not one — see §8a R4:** the ADD is migration 100, the DROP of the
four legacy counters is a later cleanup migration, so that reverting any epic PR
never leaves the worker writing to dropped columns.

---

## 5. The consent gate

Three call sites enqueue `zernio_initial_backfill` today. **All three need the
gate:**

| Path | File |
|---|---|
| Connect callback | `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts` |
| Stripe activation auto-recovery | `worker/ingress/stripe/shared.ts` (`maybeEnqueueBackfillResume`) |
| Location reactivation | `src/lib/locations/archive-location-tx.ts` |

### 5.1 Critical: declined vs. failed

The gate must distinguish two states that both look like "no completed run":

- **Declined / expired** → blocked permanently, admin path included. This is D8.
- **Accepted but never completed** (Zernio outage, worker crash, half-finished
  run) → **still retryable.** Blocking this turns a transient error into
  permanent data loss for a customer who said yes.

The existing `zernio_backfill_runs.completed_at IS NULL` sentinel already models
the second case, so the recovery path stays open for exactly the right one.
The gate predicate is on the **consent record**, not on run existence.

### 5.2 Bug this prevents

`maybeEnqueueBackfillResume` currently re-enqueues on *any* activation event
where no completed backfill exists (`worker/ingress/stripe/shared.ts:66-90`).
Under this design a declined import leaves no completed run — so **the next
`past_due → active` transition would silently import the reviews the owner
refused.** That predicate must consult the consent record.

### 5.3 Expiry mechanism and enforcement locus (locked — #670, 2026-08-05)

Two coupled decisions, resolved together.

**Expiry is derived, never materialised.** "Expired" means
`import_decision = 'pending' AND import_offer_expires_at <= now()`, computed
on read. No poller, and no stored `expired` state — §4's decision enum is
three-valued. Nothing happens *at* the expiry moment (no notification, no side
effect), so a poller would materialise state with no consumer, and every reader
would still need the defensive predicate for the poller-lag window anyway. One
predicate helper owns the derivation (the `suppressionMatchSql` pattern: a
single named owner imported by every call site); the prompt UI, the decision
API, the three §5 enqueue gates, and the worker check all consult it. A late
click — the owner answering after the deadline — is rejected by the decision
API on the same predicate; there is no lazy write-back of an `expired` value.

**The block lives in the worker, fail-closed.** The admin re-enqueue path is
manual SQL — a runbook instruction (`src/app/admin/runbook/page.tsx`), not a
route; `/admin/jobs` is read-only — so no gate at the four PRODUCT enqueue paths
can cover it. A database-level gate at the `job_outbox` insertion boundary
could; that alternative was weighed at #695 and declined (ADR 0016). Among
application-level loci, the one chokepoint every path shares (product enqueues,
admin hand-inserts, future code) is `ZernioBackfillWorker` itself. A consent gate joins the
existing pre-flight guards (`guardZernioJobEligibility`,
`worker/jobs/zernio/job-eligibility.ts`): the run proceeds **only** on
`import_decision = 'accepted'`; declined, derived-expired, and pending all
no-op-complete the outbox row with a logged reason, leaving
`zernio_backfill_runs.completed_at` untouched. Fail-closed rather than
block-listed: under D9 an enqueue exists only after a Yes, so anything other
than `accepted` reaching the worker is a hand-inserted row or a bug — and a
`pending` row that ran would import without consent (D1).

Accepted-but-never-completed stays retryable exactly as §5.1 requires: the
gate passes on `accepted`, and the `completed_at IS NULL` sentinel keeps the
recovery path open.

#676's three enqueue gates import the same predicate helper — written once,
enforced twice: at enqueue time (no pointless rows) and at run time
(authoritative, admin path included).

The runbook instruction ("re-enqueue zernio_initial_backfill outbox row")
becomes conditional and is updated by #679: re-enqueue only when consent is
`accepted` and no completed run exists; declined or derived-expired is
permanent (D8), admin path included.

**Challenged and re-affirmed (2026-08-08, #695).** The adversarial review of #679
proposed the `job_outbox` insertion boundary as an alternative enforcement locus.
Weighed and declined: a trigger needs a second, unenforceable spelling of
`importConsentStateSql` in PL/pgSQL, which this section's single-owner rule exists
to prevent, and it would not remove the worker guard anyway. Full reasoning, the
"For" case, and the operator query for refused rows:
`docs/adr/0016-import-consent-enforcement-locus.md`. A refusal is now separable by
SQL (`job_outbox.completion_reason = 'import_consent_blocked'`), which answers the
observability half of the same review finding — for the **7-day archival window**
only, since `ArchivalPoller` deletes completed `job_outbox` rows past that age. The
marker is an operational signal, not an audit record; the durable consent record
remains `businesses.import_decision`. See the ADR's "Operator query, and its limits".

---

## 6. Code changes

### 6.1 Backfill worker

- **Remove draft generation.** The import stores reviews only.
- **Import answered reviews too** — they become list rows, not drafts.
- **Cap 100, floor 12 months**, replacing `GAP_CAP`/`HISTORICAL_CAP` and the
  activation-date bucketing.
- **Page until the target is met**, not a fixed 4 pages, and **record cap
  exhaustion** the way `ZernioReviewIngestWorker` does instead of truncating
  silently.
- **Selection is bounded above by the live-ingest cutoff** (#675, 2026-08-05):
  the import takes only `createTime < connected_at − grace`, the exact
  complement of the recent poller's `isRecentForConnection`. Lane ownership is
  disjoint by construction, which resolves the #674 "lost draft" hazard
  structurally — a review the live lane owes a draft for can never be stored
  first by the import. No upper bound when `connected_at` is null.

### 6.2 Ingest without generation

`processReview` currently couples insertion and generation — every insert
enqueues `generate_response` (`src/lib/reviews/process-review.ts:93`). Storing a
review as inventory needs a path that inserts and stops. **This is the core code
change.** Sentiment classification still runs at the write site.

### 6.3 Reviews list

- Unanswered-first sort (carries the weight the toggle would have — otherwise a
  business with 90 answered and 10 unanswered buries the actionable rows).
- Per-row `Generate` / `Regenerate`.
- Rate-limit / cost-guard the buttons. 100 rows × a regenerate button is an
  owner-controlled spend surface; clicking regenerate repeatedly on one review
  is normal user behaviour, not abuse. Policy is owned by **#672**, not here.

#### 6.3a The surface (locked — #671, 2026-08-08)

**The Past Replies archive becomes the Reviews list.** `reviews/history` is
widened in place rather than extended-from or duplicated. Seven decisions,
owner-adjudicated against a prototype:

**S1 — Locus: `reviews/history` becomes the list.** Not a new surface, and not
`dashboard/reviews`. Two asymmetries decided it. First, half the import already
lands in history and the other half lands nowhere: `ZernioBackfillWorker.ts:364`
routes answered reviews through `reconcileExternallyAnsweredReview({
consentedImport: true })`, which writes a `posted` response with
`external_reply_ingested_at` — exactly what `load-replies.ts:117` selects — so
imported *answered* rows are already visible there today, while imported
*unanswered* rows appear on no surface at all. Second, `dashboard/reviews` is an
action queue, not a list: `ReviewFeedCard.tsx:59-66` filters client-side to
`pending_approval` plus live auto-post deadlines ("History owns settled
replies"), fed by the Redis-cached `/api/dashboard` payload at `LIMIT 10`. An
imported review can never appear there under any status, and extending it would
mean a new query, a new paginated API, and the loss of the queue's "what is
waiting on you" identity. History already carries pagination, search + star
filters, the review-beside-reply card, and the `EditReplyDrawer` that #669
certified as the Regenerate lane.

**S2 — `Needs Action` survives; the two tabs keep distinct jobs.** `Needs
Action` stays the approval queue (unchanged: `pending_approval` + veto windows).
`All Reviews` is the inventory. A review whose draft is pending appears in
**both** — in the list it renders a `Draft ready` cross-link to `Needs Action`
and **no `Generate` button**, since a draft already exists. Hiding it from the
list was rejected: a row that vanishes and reappears as its draft lands makes
"All Reviews" a lie.

**S3 — The `gap` / `historical` bucketing is deleted.** The two section headers
(`From your active period` / `From before you joined`, derived from
`subscription_activated_at`) are replaced by the D6 grouping: `Unanswered` then
`Answered`. The activation fact survives as a **per-row provenance badge** on
answered rows — `Posted by you before joining` / `Auto-approved` / `You
approved` — so an owner never wonders why RepWorth is showing a reply it did not
write, or offering to replace it. This retires the last consumer of the
gap/historical vocabulary that CONTEXT.md already marks dead for the Import
window.

**S4 — `PAST_REPLIES_VIEW_ENABLED` is retired at #678.** Once this surface is
the import's only destination, the flag would let `import_decision='accepted'`
coexist with the imported reviews landing on a `notFound()`. Deleting the gate
matches §8a's "the old path is deleted, not gated" posture and is safe on the
same grounds: prod holds 0 businesses, so there is no external consumer.
`EDIT_REPLIES_ENABLED` is **kept** — it gates the live-Google mutation, which is
a different and larger risk. Both env-var registry entries move in that same
change.

**S5 — `PAGE_SIZE` stays 50.** A fresh import lands as 2 pages; the S6 sort puts
every actionable row on page 1 regardless. Raising it to 100 was rejected as a
number that stops meaning anything at real volume.

**S6 — Sort: unanswered first, then newest-first within each group.** D6 locks
only the grouping; within each group the existing `ORDER BY r.review_date DESC`
is unchanged, so the leading key is the only addition. Rating-ordering inside
`Unanswered` was rejected — it buries a scathing review from last week under an
old one — as was a pinned negatives band, which is the third grouping level D6
declined.

**S7 — `Generate` is inline; `Regenerate` opens the drawer.** A never-replied
review has nothing live on Google to compare against, so its row expands in
place to a draft with `Approve & post`; a two-pane drawer would render an empty
left pane and overstate the risk. `Regenerate` opens the existing
`EditReplyDrawer` (#669) for the §6.4 treatment below. Collapsing both into one
affordance was rejected in both directions: it makes replacing a live Google
reply feel identical to writing a first draft, which is the distinction §6.4
exists to preserve.

**Implementation notes for #678** (guidance, not contract): the list change is
principally `JOIN responses resp … status='posted'` →
`LEFT JOIN` in `load-replies.ts:117`, plus `ORDER BY (resp.id IS NOT NULL),
r.review_date DESC` (`false` sorts before `true`, so unanswered lead). The
`Draft ready` state needs a second LATERAL for the live non-posted response —
a pending draft leaves `resp.id` NULL under the posted-only join, so it
correctly groups as unanswered but must not offer `Generate`. The two `COUNT(*)`
totals and the orphan query must move with the JOIN or the denominators go
wrong. Prototype the decisions were taken against: `#671` comment thread.

#### 6.3b Rate limit and cost policy (locked — #672, 2026-08-08)

**The mechanism already exists; #672 changes one number and locks the rest.**
The four layers below are already composed in
`src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` — the same route
#669 named as the Generate door's target — so the on-demand list inherits them
by wiring, not by new machinery:

| Layer | Redis key | Limit | On Redis failure | Enforced at |
|---|---|---|---|---|
| Per-owner-account **rate** | `dashregen:owner:{acct}:burst` / `:hour` | **10**/60s + 30/hr | **open** | `src/lib/shared/dashboard-regen-rate-limit.ts` |
| Per-review daily cap — sync UX peek | `regen:{reviewId}:{date}` (GET) | 3/day | **open** | `enforceRegenBudgetForReview` (same file) |
| Per-review daily cap — **authoritative** | `regen:{reviewId}:{date}` (Lua INCR) | 3/day | terminal | `worker/jobs/response-generation/generate-draft.ts:109` |
| Per-business **spend** + global + concurrency | `cost:daily:{bizId}:{date}`, `cost:global:{date}`, `gen:active:{bizId}` | tier cents / $100 / 3 | terminal (budget), retryable (transport) | `withCostGuard` → `reserveCost` |

The ticket's "per-review cap, per-account cap, or both?" resolves to **both, and
both already exist** — with the per-account axis denominated in **cents, not
clicks**, which is the correct axis because it bounds margin directly rather
than by proxy.

**C1 — The first `Generate` on a review is free by construction; do not change
the `version > 1` guard.** `generate-draft.ts:106` charges the per-review regen
budget only for `version > 1`. A `Generate` on a never-replied imported review
is version 1, so it consumes no regen budget — but it is still rate-limited and
still cost-reserved. The per-review axis **self-arms**: discard that draft and
the next attempt is version ≥ 2 and charged, so the sequence is one free draft
then three charged regenerations per review per day. Dropping the guard was
rejected outright — it exists to stop the live lane's own auto-draft from eating
the owner's regen budget, and removing it would charge every ingested review.

**C2 — `BURST_MAX` 5 → 10; `HOUR_MAX` stays 30.** The hourly layer is the spend
bound (30 × the 15¢ pessimistic reserve ≈ $4.50/hr worst case); the burst layer
only exists to stop a click-storm. At 5/60s an owner deliberately working
through a freshly imported 100-row list is 429'd every few clicks, which reads
as broken rather than as policy. Raising only the burst layer keeps worst-case
hourly spend **unchanged**. Raising the hourly cap too was rejected: it is the
one number that actually bounds spend.

**C3 — The `Generate` door shares the existing per-owner counter.** It becomes
the third caller of `enforceDashboardRegenRateLimit`, alongside
`/api/dashboard/reviews/[reviewId]/regenerate` and the `mode:'regenerate'`
branch of `/api/dashboard/past-replies/draft`. Separate counters were rejected
because alternating `Generate` and `Regenerate` would then double effective
throughput past a limit both are meant to respect.

**C4 — Live-lane starvation is a ceiling-sizing constraint, not new machinery.**
On-demand generation and the live-ingest lane share
`cost:daily:{businessId}:{date}`, and exhausting it **terminally drops** a draft
— `alertCostCapExhausted` (`generate-draft.ts:72`) pages Sentry rather than
retrying (beta-launch gate B3). So an owner working through their import can
starve the draft for a genuinely new 1★ review that afternoon. This is real, and
it is bounded: C2/C3 cap the on-demand lane at 30 drafts/hr ≈ $4.50/hr, so a
two-hour triage session costs ≈ $9 of headroom. `DAILY_COST_LIMIT_CENTS_COPILOT`
/ `_AUTOPILOT` are required-with-no-default and **still unset** — they must be
chosen before GA regardless, so the constraint is recorded there (see
`.claude/reference/env-vars.md`) rather than enforced by a second reservation
path. A reserved live-lane floor was rejected as a percentage nobody can tune
without production data, for a load with 0 accounts behind it.

**Not changed by #672**: rate limits still **fail open** by design and must not
be "fixed" to strict; the pre-LLM Redis cost reservation remains what keeps
spend safe; pre-LLM Redis **transport** failures stay retryable
(`CostInfraUnavailableError`) while **budget-exceeded** stays terminal. Upstash
remains a single-instance SPOF across cache + rate-limit + cost-reserve +
regen-budget. Full matrix: lab-notes "Cost-guard fail-open/retry matrix".

### 6.4 Regenerate on an already-answered review

Publishing here **edits the owner's live reply on Google** (`findReply` →
replace), not appends. Requirements:

- Show the existing reply beside the proposed one before publishing.
- **Never reachable by `auto_policy` approval.** An autonomous system silently
  rewriting a human's own words is the failure mode that ends customer
  relationships. Invariant #3 governs; this path is owner-approval-only.

Locked at #671: the comparison is a **two-pane drawer** — `On Google now` beside
`Proposed replacement` — carrying an explicit warning that publishing *replaces*
rather than appends, and that RepWorth never does this on its own. The primary
action reads `Replace reply on Google`, never a bare "Publish"; the decline
action reads `Keep my reply`. Both panes are always rendered, so the owner
cannot approve a replacement without having seen what it destroys.

Related existing surfaces (already built, behind flags): the Past Replies
archive at `src/app/(authenticated)/dashboard/reviews/history/`,
`src/lib/past-replies/load-replies.ts`, gated by `PAST_REPLIES_VIEW_ENABLED` +
`EDIT_REPLIES_ENABLED` — the first of which S4 retires.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Fewer than 100 reviews in 12 months | Import what exists. |
| Zero reviews in window | Import succeeds, empty state reads "no recent reviews found" — not an error. |
| Owner never answers the prompt | Expires at T+7d, same as declining. |
| Import fails mid-run | Retryable (§5.1). Consent stays `accepted`. |
| Re-connect after declining | Stays declined. Consent is per location and permanent. |
| Reviews already ingested live | `processReview` dedupes on provider identity via `ON CONFLICT` — no duplicates. |
| Multi-location account | Prompt and decision are per location. |

---

## 8. Non-goals

- No permanent import affordance in settings (considered, rejected — §2.2).
- No auto-generation of any drafts, not even a small eager batch.
- No answered/unanswered toggle.
- No handling of the account-created-but-never-subscribed case.

---

## 8a. Rollout posture (locked — #668, 2026-08-05)

Reasoning and evidence live in **ADR 0015**
(`docs/adr/0015-consented-import-unflagged-replacement.md`), which owns this
decision. Binding summary:

| # | Decision |
|---|---|
| R1 | **No feature flag.** The old auto-drafting path is deleted, not gated. No new `*_ENABLED` var, no `env-vars.md` entry. |
| R2 | **Ordering replaces the flag:** #677 (prompt UI + decision API) lands **before or with** #676 (consent gate). A gate that precedes its prompt blocks owners with no way to consent. |
| R3 | **No existing-rows clause.** Production held zero businesses; staging was fully reset 2026-08-05 (no Google mutations). Consent columns are `NOT NULL DEFAULT 'pending'` against an empty table. Backdating consent to `accepted` was considered and rejected — it writes a consent that was never given. |
| R4 | **Backout is `git revert`.** To keep that sufficient, **migration 100 is additive-only**: ADD `imported_count`/`skipped_count`, keep `oldest_skipped_create_time`, and DROP the four `gap_*`/`historical_*` counters in a **separate cleanup migration** after staging proves the epic. The locked collapse is split in two, not reopened. |

R1's standing risk: `main` is briefly incoherent between #675 and #677 (import
runs, drafts nothing, no prompt explains it). Acceptable only while production
has no customers — **if GA is scheduled before this epic completes, ADR 0015
must be revisited.**

---

## 9. Appendix — Zernio review ordering (verified 2026-08-05)

The design depends on "newest 100" meaning what it says. `listReviews` sends **no
ordering parameter**, so ordering is Zernio's undocumented default. Verified
empirically against staging (`kubdiqdhqbhwmqfditeg`):

**Method.** The backfill's reconcile loop (`for (const z of answered)`) iterates
in Zernio's **raw fetch order**, unlike the processing loops which sort first.
So for already-answered reviews, DB insertion sequence preserves the API's
ordering.

**Result.** Two independent backfill runs, a day apart:

- Run 2026-07-23 — 14 reviews, `createTime` **strictly descending**, no inversions
- Run 2026-07-22 — 12 reviews, replicated, same

**Discriminating test (`createTime` vs `updateTime`).** Compared fetch order
against reply timestamps:

| fetch_seq | createTime | reply posted |
|---|---|---|
| 2 | 2026-06-23 | 2026-06-26 |
| 3 | 2026-06-15 | **2026-07-13** |
| 4 | 2026-05-20 | 2026-05-21 |

Under `updateTime` sorting, seq 3 (replied July 13) would sort above seq 2
(replied June 26). It does not. Order tracks `createTime` and violates
`updateTime` at that pair.

**Conclusion:** Zernio returns reviews **newest-first by `createTime`**. The
failure mode where an owner's reply sweep bumps reviews around and shuffles them
out of the window **does not occur**.

**Caveats.**
- One staging location (~169 reviews), so pagination ended naturally — behaviour
  exactly at the page cap is inferred, not observed.
- Zernio sandbox account; one dataset.
- This is an undocumented default that could change without notice. **Keep the
  defensive re-sort** in the worker (`ZernioBackfillWorker.ts:172-174`) and add a
  warning log when a fetched page arrives non-descending, so a silent Zernio
  change surfaces as a warning rather than a mystery.

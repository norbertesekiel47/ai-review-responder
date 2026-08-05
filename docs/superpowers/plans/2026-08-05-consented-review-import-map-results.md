# Consented Review Import — map results collection

**Map:** [#667](https://github.com/RepWorth/ai-review-responder/issues/667)
**Spec (binding):** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`

Paste each ticket's outcome under its heading below. Nothing needs to be
formatted — raw notes, a pasted agent report, or two sentences all work.

**What happens to what you paste:** the tracker stays canonical, so for each
result I post a resolution comment on the issue, close it, add a one-line gist
to the map's *Decisions so far*, and graduate any fog the answer sharpened into
new tickets. This file is the collection point, not the record — it can be
deleted once the map absorbs it.

---

## Wave 1

### #674 — KEYSTONE: `processReview` store-without-generate  ·  `wayfinder:feature`

Add a path that inserts a review and stops — no `generate_response` enqueue.
Hard requirement: zero behaviour change for existing callers.

**Result:**

<!-- branch, PR, what changed, anything surprising -->

---

### #668 — Rollout posture  ·  `wayfinder:grilling`  ·  **highest leverage**

1. Flag, or replace the backfill outright?
2. What happens to businesses already backfilled under the old auto-drafting
   behaviour (two exist on staging, each carrying 50 unconsented drafts)?
3. What is the backout — flag flip, revert, or data cleanup?

Unblocks #673, #676, #677, #679.

**Result:** ✅ **RESOLVED 2026-08-05.** Absorbed into the map; owned by
**ADR 0015** (`docs/adr/0015-consented-import-unflagged-replacement.md`) with the
binding summary at spec **§8a (R1–R4)**.

1. **No flag.** Delete the old path, don't gate it — a flag would keep two import
   semantics live across seven tickets plus a retirement PR. Decided on verified
   facts, not vibes: production holds 0 accounts / 0 businesses / 0 reviews, GA is
   gated behind #286–#290, and the old path has no external consumer.
   **Ordering does the flag's job:** #677 lands before or with #676.
2. **Nothing survives, either environment.** No production cohort existed. The
   staging cohort turned out to be *two connections to one real GBP* holding 114
   never-posted drafts, 32 ingested owner replies and 2 live RepWorth replies —
   resolved by a **full staging reset** (executed; admin login preserved;
   **nothing mutated on Google**). #673 therefore gets `NOT NULL DEFAULT 'pending'`
   and no backfill clause. Backdating to `accepted` rejected as a recorded lie.
3. **Backout = `git revert`**, kept sufficient by making **migration 100
   additive-only** — the DROP of the four legacy counters defers to closing
   ticket **#680**. The locked collapse is split, not reopened.

Standing risk recorded: `main` is briefly incoherent between #675 and #677.
**If GA is scheduled before the epic completes, ADR 0015 must be revisited.**
Collateral: the reset took #617's staging fixtures — flagged on #633, evidence
already committed, so the loss is reproducible work rather than proof.

---

### #669 — Reuse audit: past-replies draft/publish lane  ·  `wayfinder:research`  ·  **AFK**

Can `src/app/api/dashboard/past-replies/{draft,draft-status,publish}/` serve the
new list's Generate and Regenerate actions? Deliverable is a reuse map —
reuse as-is / extend / build new, per action, with the seam named.

**Result:**

<!-- -->

---

### #670 — Expiry mechanism + admin block location  ·  `wayfinder:grilling`

Computed-on-read vs poller. Where the admin re-enqueue block lives such that
*declined/expired* is permanent while *accepted-but-failed* stays retryable.
Includes updating `src/app/admin/runbook/page.tsx`, which currently tells ops to
re-enqueue `zernio_initial_backfill` by hand.

**Result:**

<!-- -->

---

### #671 — Reviews list surface  ·  `wayfinder:prototype`

New page, extend `dashboard/reviews`, or merge with `reviews/history`?
Plus pagination for 100 rows, the unanswered-first sort, and how the per-row
buttons read. Also settles the map's "fate of the Past Replies archive" fog.

**Result:**

<!-- -->

---

### #672 — Rate limit + cost policy  ·  `wayfinder:grilling`

Per-review cap, per-account daily cap, or both — and which existing mechanism
owns it (cost-guard reservation / API limiter / regen budget). Rate limits fail
open by design and must not be "fixed" to strict; the Redis cost reservation is
what actually protects spend.

**Result:**

<!-- -->

---

### #673 — Migration 100  ·  `wayfinder:feature`  ·  **blocked by #668**

Consent columns on `businesses`; collapse the four `zernio_backfill_runs`
gap/historical counters into `imported_count` + `skipped_count`, keeping
`oldest_skipped_create_time`. Update the tenant-scope allowlist entry at
`scripts/ci/tenant-scope-allowlist.ts:2223`.

Cannot start until #668 answers what consent state existing rows receive.

**Result:**

<!-- -->

---

## What unblocks after wave 1

| Ticket | Waits on | Notes |
|---|---|---|
| #675 — backfill selection | #674, #673 | runs parallel to #676 |
| #676 — consent gate ×3 paths | #673, #668 | contains the live `maybeEnqueueBackfillResume` bug |
| #677 — import offer + prompt | #673, #675, #668 | |
| #678 — reviews list + buttons | #675, #669, #671, #672 | parallel to #677 **only if** #671 puts them on separate pages |
| #679 — expiry + admin block | #673, #668, #670 | disjoint from #677/#678 |

Critical path: **#674 → #675 → #677/#678**.

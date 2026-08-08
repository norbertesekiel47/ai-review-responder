# Deviations — feat-678-reviews-list-generate

Every entry is something the plan or intake did not anticipate. Step 6 requires an
ACCEPT / RE-PLAN verdict on each before review agents see this file.

---

## D1 — Surface amendment #1 of 2 (owner-approved, 2026-08-08)

**Trigger:** plan review round 1, finding F8. Collapsing `flags.ts` to a single
function — the owner's grilling decision — requires editing six files outside the
originally locked `allowed_edit_surface`, whichever of the two names survives.

**Added to `allowed_edit_surface`:**

| Path | Why |
|---|---|
| `src/lib/reviews/process-review.ts` | calls `replyEditingFlagEnabled()` |
| `worker/jobs/publisher/ResponsePublisherWorker.ts` | calls `replyEditingFlagEnabled()` |
| `worker/jobs/publisher/failed-hook.ts` | calls `replyEditingFlagEnabled()` |
| `src/app/api/dashboard/past-replies/**` | 3 routes call `editRepliesEnabled()` |
| `scripts/ci/process-env-baseline.ts` | env-baseline audit references the retired flag |
| `src/components/dashboard/__tests__/**` | the existing `PastReplyCard.test.tsx` lives here, **not** under `components/dashboard/reviews/` — the original surface missed it |
| `.claude/reference/review-ingestion.md`, `.claude/reference/lab-notes.md` | live (non-`docs/`) references to the retired flag |

**Amendment budget: 1 of 2 used.** A second amendment trips the abort criteria.

**SCOPE FENCE — read before editing `process-review.ts`:** `src/lib/reviews/process-review.ts`
is in-surface **for the flag rename ONLY**. The owner explicitly deferred F2's
in-flight `job_outbox` guard to #680 (see D2). Adding that guard here is out of
scope even though the file is now editable — do not let proximity turn a deferred
fix into a silent one.

**Verdict:** ACCEPT.

---

## D2 — F2 race deferred to #680 (owner decision, 2026-08-08)

**Finding:** a `Generate` racing the live-ingest content-change path in
`process-review.ts:325` enqueues a **second** `generate_response` job — that path
re-derives the version and never checks `job_outbox` for in-flight work, and
`enqueueGenerateResponse` has no in-flight dedup.

**Blast radius is smaller than the reviewer credited:** the partial unique index
(migrations 023+026+029) permits at most one non-terminal response per review, so
the losing job **fails to persist** rather than producing two drafts. The cost is
a wasted LLM call, not corruption.

**Decision:** test it here, fix it in #680. This branch adds
`Generate racing live-ingest regeneration for the same unanswered review leaves
exactly one in-flight generate_response version` so the behaviour is pinned and
measured; if it confirms wasted spend, that becomes a #680 item rather than
widening this branch into worker ingest.

**Verdict:** ACCEPT.

---

## D3 — 13 test titles added to `tests_to_add` (not an amendment)

Per the workflow, a `tests_to_add` change is an owner-approved deviations-file
entry, not a surface amendment — no budget burned. 37 → **50** titles, from plan
review findings F1–F9. Both intake copies updated and verified byte-identical.

The largest single gap: **zero** of the original 37 titles tested
`GET draft-status`, while Task 3 referred to "the poller titles" as if they
existed. That is the #643 fabricated-citation class, caught by the mandatory
cited-artifact check.

**Verdict:** ACCEPT.

---

## D4 — Estimates deliberately NOT re-padded

Scope grew (13 tests, 6 files) but `estimated_prod_lines` / `estimated_test_lines`
stay at the owner-ruled **900 / 1100**. The owner explicitly rejected padding on
the grounds that a loose estimate makes the re-classification trigger useless.
If the actual diff exceeds 2× either bucket, the trigger firing is the control
working as designed, not a surprise — re-run step 0 at that point.

(The orchestrator raised these to 1000/1500 mid-session and reverted it; recorded
here because a silent estimate change would have quietly disarmed the trigger.)

**Verdict:** ACCEPT.

---

## D5 — Plan cited two stale line numbers inherited from the spec

- The `version > 1` regen-budget guard is `generate-draft.ts:**107**`, not `:106`.
  Ticket #678's unblocking comment and spec §6.3b both say 106 — the spec is one
  line stale. Cite 107; do not "correct" the code to match the doc.
- `past-replies/draft/route.ts` is 253 lines, not 254 (cosmetic; plan prose only).

**Verdict:** ACCEPT.

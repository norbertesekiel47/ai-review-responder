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

## D6 — F5's prescribed `hasOpenFlag` is not usable on the read paths (round 2)

**Trigger:** applying round-2 findings. Round 1's F5 fix said "use `hasOpenFlag`
(`src/lib/moderation/held-draft.ts`) — already the owner of this fact". Its actual
signature is `hasOpenFlag(tx: postgres.TransactionSql, responseId)` — an in-tx,
post-`FOR UPDATE` **release gate**, documented as such in the module header.

Neither new site is a transaction: the `draft-status` poller is a `sqlRead`, and
the list check must live inside a single SQL statement (a LATERAL). Wrapping
either in `sql.begin` purely to read a boolean would add a transaction round trip
to a poll endpoint hit every few seconds.

The clean fix — export a composable predicate fragment from `held-draft.ts` —
is **blocked**: that file is outside `allowed_edit_surface`, and it is the LAST
amendment (1 of 2 already used by D1), which per the abort criteria means
post-mortem + teardown. Not worth spending on a refactor.

**Decision:** both new sites spell `EXISTS (SELECT 1 FROM flagged_responses f
WHERE f.response_id = … AND f.status = 'open')` inline, each carrying a comment
naming `held-draft.ts` as the semantic owner. Three spellings of the predicate
exist after this branch (`hasOpenFlag` + 2). Consolidating them into one exported
fragment is a **#680 item**, where `held-draft.ts` can be in surface.

**Verdict:** ACCEPT.

---

## D7 — Two-round pattern: review fixes landed as prose, not as steps

**Not a scope change — a process finding, recorded so it is not rediscovered.**

Round 1 accepted 9 findings and wrote them into a `# Round-1 revisions` appendix,
but patched only F3 and F7 into the task steps — and F3 only partially (caught
pre-round-2 by the orchestrator; see `plan-round1.md`). Round 2 then found F5, F8,
and F9 in the same state: described in the appendix, absent from every checkbox a
subagent executes.

**Root cause:** an appendix entry reads as "addressed" at every subsequent
checkpoint — including to the reviewer who wrote the finding — because the plan
demonstrably *discusses* the fix. Nothing distinguishes "described" from "applied"
without opening the task the fix belongs to.

**Correct approach:** a review fix is applied when the **checkboxed step** changes.
The appendix is a changelog, never the carrier. Round-3's brief (and every future
`/feature` review brief) asks: *if a subagent executes only the checkboxes of the
owning task, does the fixed behaviour result?*

**Promote to lab-notes at step 8** — this is not #678-specific.

**Verdict:** ACCEPT.

---

## D8 — 2 test titles added (50 → 52; not an amendment)

Per the workflow a `tests_to_add` change is an owner-approved deviations-file
entry, not a surface amendment — no budget burned (D3 precedent).

- `an orphan row keeps its failed_response_id and superseded text after the single-query merge`
  — pins round-2 Defect A. Without it, F3's single-query merge silently drops the
  field `PastReplyCard:157,201` needs to offer recovery at all, and every existing
  orphan title still passes (they assert grouping and non-duplication, not fields).
- `the Reviews list renders a moderation-held draft as held with no Generate, no draft text, and no cross-link`
  — pins round-2 Defect B at the surface. The locked F5 title covers only the
  poller; nothing covered the list row.

Both intake copies updated and verified byte-identical.

**Verdict:** ACCEPT.

---

## D9 — `held` is a sixth row state, and a new user-visible behavior (OWNER: ratify)

**Trigger:** round-2 Defect B. Round 1's accepted F5 fix requires a held review to
sit in `Unanswered` "with no affordance", but the locked five-state union cannot
express that. With the draft filtered out, `deriveRowState` falls through to
`generate` — offering an LLM spend the partial unique index (023+026+029) would
then reject, since a held draft is itself a live non-terminal response. With the
draft kept, the row reads `draft_ready` and surfaces held text plus
`Approve & post`. **Both violate invariant #4**, so the five-state model had no
correct configuration.

**Decision:** add `held` to `ReviewRowState`, carry `draft_held` from the query,
and branch it on the same test as `draft_ready` so no held draft can reach
`generate`. The row renders the review text and a muted `Under review` marker —
no button, no draft text, no cross-link (Needs Action does not surface held drafts
either, so the `draft_ready` cross-link would lead nowhere).

**Why this needs owner ratification:** it adds a user-visible state that the
owner-signed intake does not name. The intake's declared behavior — *"A review
with a pending draft shows a `Draft ready` cross-link"* — is unconditional, and a
held draft **is** a pending draft, so the signed contract as written mandates an
invariant #4 violation. That is a contract defect F5 exposed, not an
implementation choice, and the surviving question is only how the state presents.

`user_visible_behavior` updated in both intake copies (an intake-field correction,
not a surface amendment). **Flagged to the owner in the round-2 summary; veto or
relabel at any point before step 8.** The label `Under review` is the one piece
genuinely open to preference.

**Verdict:** ACCEPT (owner ratification pending — no work blocks on it).

---

## D5 — Plan cited two stale line numbers inherited from the spec

- The `version > 1` regen-budget guard is `generate-draft.ts:**107**`, not `:106`.
  Ticket #678's unblocking comment and spec §6.3b both say 106 — the spec is one
  line stale. Cite 107; do not "correct" the code to match the doc.
- `past-replies/draft/route.ts` is 253 lines, not 254 (cosmetic; plan prose only).

**Verdict:** ACCEPT.

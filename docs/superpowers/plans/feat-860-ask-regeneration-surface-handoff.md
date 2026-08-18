# feat-860 — handoff (step 8, awaiting merge approval)

**Issue:** #860 — per-ask **Ask regeneration** surface. Resolves #629 deviation **D3**.
**PR:** https://github.com/RepWorth/ai-review-responder/pull/873 → `main`
**Follow-up filed:** #872 (post-approval per-ask withdrawal)
**Branch:** `feat-860-ask-regeneration-surface` @ `1ff09871` · base `f28451ee` · 24 commits
**Phase:** `reviewed` · gate GREEN at `1ff09871` · plan rounds 3/3 (closed) · branch rounds 2/3
**Lane:** RISK = high · SURFACE = mixed · SIZE = normal

## Where this stopped and why

**Step 8, awaiting the owner's explicit merge approval** — the RISK = high lane
requires it and it has NOT been given.

Done: rode `staging` (fast-forward `f28451ee..1ff09871`, full stack auto-deploying),
PR #873 opened against `main`.

**Do not merge without the owner saying so.**

## The one thing that must not happen

**Do NOT flip `SOLICITATION_SEND_ENABLED`.** The feature ships INERT — the flag is
unset in every environment, the route 404s, `sendLane` is null, no control renders.
`assertSolicitationSendEnv` requires four vars that do not exist in staging and the
boot assert would crash the staging worker. The sending identity is #633, still open.

**Staging verification is therefore a NEGATIVE one:** the Requests screen must stay
**byte-identical to watch-mode**. If anything changed visibly, that is a defect.

## Read these, in this order

1. `docs/reviews/feat-860-ask-regeneration-surface/TRIAGE.md` — round 1 + round 2
   verdicts, the three REJECTED findings with reasoning, and the round-2
   verification matrix. **Start here.**
2. `docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md` — D1–D15,
   every one carrying a step-6 ACCEPT verdict.
3. `docs/adr/0020-regeneration-refused-after-approval.md` — the decision, and its
   § "Cost, as verified" amendment.
4. `CONTEXT.md` → **Ask regeneration** (coined here), **Owner approval** (its
   conditional dropped), **Ask exclusion**, **Halt latch**.

## Three things that will look wrong and are not

1. **`readRegeneratingAskId` carries no tenant predicate** (`batch-view.ts:381-411`).
   Correct — `job_outbox` is absent from `scripts/ci/tenant-tables.ts`. Joining
   `solicitation_batches` to "look scoped" is the defect. Confirmed empirically:
   `ci:tenant-scope` entries stayed at 381 under #859's new parser, and a test
   asserts the query text contains no tenant table.
2. **`requestAskRegeneration` enqueues BEFORE it validates**, and refusals throw
   `RegenRequestAbort` rather than returning. Deliberate deadlock avoidance —
   postgres.js commits on a normal return. Round-2 confirmed the R5 tenant fix did
   NOT disturb it: outbox INSERT is still statement one, `outboxAt < advisoryAt`
   still asserted.
3. **The exclusion set keys on `askId`, not `outreachId`; there is no
   `pruneExclusions`.** The intake's `edge_cases` prose on pruning is STALE —
   round-1 finding 6 reversed it because pruning silently re-selected a deselected
   contact. `tests_to_add` already encodes the corrected behaviour.

## After merge — the step-8 tail, none of it done yet

1. `git pull --ff-only` on local `main` (squash-merge lag).
2. **Re-sync `staging` to `main`.** This branch RODE staging, so after a squash
   merge the two have genuinely diverged and `git merge --ff-only main` WILL abort.
   The runbook's answer is `git reset --hard origin/main` + `--force-with-lease`
   (`deployment-guide.md` §"Re-sync staging"). **Do NOT substitute a sync merge** —
   that is what put staging 101 commits ahead by #719.
3. `bash scripts/feature-cleanup.sh` from the MAIN checkout (dry run first, then
   `--apply`).
4. **Promote deviations lessons** into `.claude/reference/lab-notes.md` or the
   CLAUDE.md gotchas. The high-value ones: D9 (`git add -A` is unsafe under
   parallel task execution in one worktree), D15 (estimate a rework allowance on
   high-RISK UI features or `reclassify` fires on every branch whose review
   worked), and round-2 R17 (a fail-open guard needs an oracle for the OPEN half,
   not just the closed one).
5. Invoke `document-feature`, then a final `domain-modeling` sweep.
6. Increment the merge counter in `.claude/reference/arch-review-log.md`.

## Coordination

**Merge order: this branch merges BEFORE `feat-865-admin-halt-surface`** — owner
decision, confirmed this session. #865 carries the whole rebase obligation and
re-runs its verify gate on the rebased tree. #865 does not modify anything this
branch changed; the collision is a shared file header and a shared append point in
`approval.ts` / `batch-view.ts`.

## Open, not blocking

- `docs/directory.md:127` (`AskList`) and `:128` (`ApprovalActions`) carry claims
  `a094cc0e` falsified. Found in round 2's standards appendix; out of scope for
  this branch's rounds. Hand to #865's docs pass or a standalone sweep.
- `_shared/scoped-batch-route.ts`'s header says "three POST routes"; it is now four
  (D12). Out of `allowed_edit_surface` — deliberately deferred rather than spend the
  second surface amendment on prose. **Amendment budget ended at 1 of 2.**

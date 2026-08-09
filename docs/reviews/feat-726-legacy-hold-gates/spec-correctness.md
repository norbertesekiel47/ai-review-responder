# Spec & correctness review — feat-726-legacy-hold-gates

Reviewer: SPEC & CORRECTNESS agent · 2026-08-09
Subject: `git diff bea12e68..HEAD` (8 commits, 11 files) — invariant-#4 hold
gates on the three legacy Past Replies draft routes (4 handlers).
Inputs read: `.feature/intake.json`, deviations D1–D5 (all ACCEPT, treated as
sanctioned), `docs/reviews/feat-726-legacy-hold-gates/blast-radius.md`, plan
`docs/superpowers/plans/feat-726-legacy-hold-gates.md`.

Verification run during review: the three touched test files — 62/62 pass;
`pnpm ci:tenant-scope` — passed, 412 entries (baseline 412).

## 1. Contract check — `.feature/intake.json` field by field

### user_visible_behavior — 4/4 implemented exactly

| Item | Evidence | Verdict |
|---|---|---|
| GET draft-status: completed + held → `{ status: 'failed', error: 'held_for_review' }` (200), never `response_id`/`response_text` | `src/app/api/dashboard/past-replies/draft-status/route.ts:149-154` — returns exactly the two-field body, HTTP 200, before the success shape is built | MATCH |
| POST /draft: existing non-terminal draft held → 409 `{ error: 'held_for_review' }`, NO existing payload | `src/app/api/dashboard/past-replies/draft/route.ts:153-155` — refusal before the `draft_already_exists` payload is constructed; body is the single-field shape | MATCH |
| DELETE: held pending_approval → 409 `held_for_review`, not superseded; idempotent-204 preserved for every non-held case | `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts:245-247` — gate is inside the `pending_approval` branch only; missing row (line 229-231) and terminal statuses (branch skipped, line 262) still 204 | MATCH |
| PATCH: held → 409 `held_for_review`, not updated | `.../draft/[responseId]/route.ts:164-166` — gate after status check, before the UPDATE at line 170 | MATCH |

No behavior outside these four was added. The one non-listed semantic change —
`FOR UPDATE` on the POST existing-draft SELECT (`draft/route.ts:146`) — is
named in the intake's own invariants ("in-tx and post-FOR-UPDATE") and
sanctioned by D1(a); it changes lock behavior, not any response shape.

### invariants — 5/5 held

1. **Invariant #4 for every handler in `past-replies/`** — six route files
   exist: `publish` (pre-existing gate, line 159), `draft` POST, `draft-status`
   GET, `draft/[responseId]` PATCH+DELETE (all four now gated), and
   `[responseId]/retry` + `[responseId]/restore-original`. The two recovery
   routes hard-require `status === 'failed'` (retry:96, restore-original:95); a
   held draft is by construction `pending_approval` with an open flag and can
   never reach `failed` (publish is gated, `requires_regeneration` closes the
   flag when it supersedes), so the invariant holds vacuously there. HOLDS.
2. **No text in any response body while a flag is open** — all four held
   branches return fixed literal bodies containing only status/error
   vocabulary; asserted by whole-body `toEqual` + sentinel-absence tests. HOLDS.
3. **hasOpenFlag in-tx, post-FOR-UPDATE (POST/PATCH/DELETE); poller inline
   EXISTS per D6** — POST: gate at line 153 after the `FOR UPDATE` SELECT
   (146); PATCH: line 164 after response lock (145-148); DELETE: line 245 after
   response lock (223-227). Poller spells the correlated EXISTS inline
   (draft-status route 124-127) with the semantic-owner comment (109-115).
   HOLDS.
4. **Tenant scoping unchanged** — the poller lookup gained only a correlated
   subquery on `responses.id` inside the same tenant-guarded query; the POST
   SELECT gained only `FOR UPDATE`; `hasOpenFlag` runs on a response id already
   tenant-locked. `ci:tenant-scope` green at baseline 412 (allowlist
   fingerprints updated per sanctioned amendment #1 / D5, no entries
   added/removed). HOLDS.
5. **Closed flag → byte-compatible behavior** — poller: `held=false` falls
   through to the identical pre-change success shape; POST: `hasOpenFlag`
   false → identical `draft_already_exists` payload; PATCH/DELETE: identical
   204 paths. Green characterization tests 2 and 4 plus all reconciled
   pre-existing tests (62/62) lock this. HOLDS (response-shape identical; the
   POST row lock is the sanctioned D1 semantic addition).

### edge_cases — 6/6 handled

- **Non-terminal statuses beyond pending_approval on POST** — the SELECT
  filters `status = ANY(NON_TERMINAL_STATUSES)` and the gate applies to any
  returned row; the fc property test iterates all four members of
  `NON_TERMINAL_STATUSES` imported from `@/lib/shared/response-status`. ✓
- **Poller: completed + resolved + held → failed/held_for_review; row missing
  → 404 response_not_found** — route lines 135-137 unchanged. ✓
- **Poller: both tenant guards BEFORE held branching** — payload guard at line
  94 (before any status branch), response `business_id` re-check at 141, held
  branch at 149 — strictly after both, and only inside the
  `outbox.status === 'completed'` path. Green characterization test 4 pins the
  ordering (held+cross-tenant seeds → 403 body with no sentinel and no 'held'
  substring). ✓
- **DELETE held: refusal before the superseding UPDATE, row untouched** —
  gate at 245 precedes UPDATE at 254; test asserts no executed tx template
  contains `UPDATE responses`. ✓
- **PATCH held: refusal after the response FOR UPDATE, before UPDATE** — gate
  at 164 between lock (145) and UPDATE (170). ✓ (See appendix A1 on what the
  queue mock can and cannot pin.)
- **Flag closed between poll ticks → next tick returns draft normally** —
  heldness is computed per-request from the EXISTS; no server-side state. The
  EXISTS also cannot be stale relative to the response row: flag + response
  are persisted in one worker tx and read here in one snapshot. ✓

### tests_to_add — 8/8 titles verbatim, assertions match titles

All eight titles appear character-for-character (draft-status.test.ts:452,
474, 496, 525; draft.test.ts:520, 552; draft-id.test.ts:551, 573) and each
asserts what its title claims — whole-body `toEqual` for refusal shapes,
`JSON.stringify` sentinel-absence for leak checks, SQL-text assertions for
`FOR UPDATE` and the flagged_responses bound id, no-`UPDATE responses` sweeps
for the mutation refusals, and the fc property over `NON_TERMINAL_STATUSES`.
One assertion-strength gap on test 3 — see finding F1.

### allowed_edit_surface — clean

Changed implementation files: the three routes, the three test files, and
`scripts/ci/tenant-scope-allowlist.ts` (sanctioned surface amendment #1, D5).
The remaining diff files are `/feature` workflow artifacts under
`docs/superpowers/plans/` (plan, deviations, handoff, intake copy) — process
docs, not implementation surface. The two intake copies are identical except
the D4 bracket-escaping of `[responseId]` in the gitignored `.feature/` copy
(sanctioned, D4). Nothing else touched.

## 2. Correctness concerns a spec reader would raise

- **Gate ordering** — verified as specified: tenant-before-held in the poller
  (both guards); held-before-offboarding in DELETE (245 vs 249);
  held-after-lock-and-status-check in PATCH. All earlier-winning refusals
  (tenant 403, offboarding 403, optimistic 409, rate limit) are text-free, so
  invariant #4 holds under every precedence, per the plan's clarification.
- **Right id into hasOpenFlag** — POST passes `existingDraft.response_id`
  (the resolved draft, not the review id); PATCH and DELETE pass the
  path-param `responseId` that the same tx just locked. Tests bind-check both.
- **No text leak in held paths** — all four held bodies are fixed literals;
  no `existing`, no `last_error`, no snippet fields. The poller's generic
  `failed` branch (line 167-170) still surfaces `last_error`, but that branch
  is only reachable when the outbox itself failed — no response row was
  persisted, and the worker never puts draft text in error strings (plan
  Review appendix, sanctioned rejection).
- **Deadlock safety of the new POST row lock** — lock order review→response
  matches PATCH and publish. `hasOpenFlag` reads `flagged_responses` without
  a lock, so no cycle against the admin disposition path (which locks
  `flagged_responses` then, for `requires_regeneration` only, the response
  row); plain reads don't block on `FOR UPDATE`. The residual
  approve/dismiss race is fail-safe (refuse a just-released draft; owner
  retries), as documented in the route comments.

## 3. Blast radius — callers vs. the new semantics

The blast-radius file's importer lists are vitest-module-graph noise (every
route test in the repo); the real consumers are the client modules. Checked
each against the four semantic changes:

- **`src/components/dashboard/reviews/edit-reply/useEditReplyDraft.ts`** (the
  only client of all three legacy routes, via `EditReplyDrawer`):
  - Poller `{ status: 'failed', error: 'held_for_review' }` → line 188-196
    routes any `status === 'failed'` to the terminal-closable `error` state.
    No trap: closing and re-opening hits POST /draft → 409 `held_for_review`
    → also terminal-closable `error`. Tolerates the new shape. (But see F2 —
    the comment justifying that branch is now factually stale.)
  - POST 409 without `existing` → `handleHttpError` (line 242) requires BOTH
    `error === 'draft_already_exists'` AND `body.existing` before entering
    `draft_conflict`, so the held 409 falls through to the closable `error`
    state — it can never build a conflict panel from a missing payload.
  - DELETE 409 → `cancelDraft` (line 429-435) and `discardExistingDraft`
    (line 537-543) ignore the response entirely (best-effort catch-and-close),
    so a held DELETE degrades to a no-op close. Additionally unreachable in
    practice: flags are only opened at generation-persist, before any owner
    surfacing, so a draft the drawer can see was never held.
  - PATCH 409 → `submitManual` → `handleHttpError` → closable `error`. Same
    unreachability argument.
- **`DraftConflictPanel.tsx`** — renders only the `draft_conflict` state,
  which a held draft can no longer reach (POST refuses first). No reliance on
  removed shapes.
- **`useInlineGenerate.ts`** — polls the NEW per-review route
  (`/api/dashboard/reviews/:id/draft-status`, gated since #678), not the
  legacy poller. Unaffected.
- **`scripts/ci/tenant-scope-allowlist.ts`** — the two updated sqlSnippet
  fingerprints verified against the audit: green, baseline unchanged.

## 4. Findings table (≥80% confidence only)

| Severity | Location | Finding | Failure scenario |
|---|---|---|---|
| LOW | `src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:521-523` | The SQL-shape test (test 3) asserts `EXISTS` + `flagged_responses` + `status = 'open'` but NOT the correlation predicate `f.response_id = responses.id`, though the title and plan (D1c) specify a *correlated* EXISTS | A refactor that drops the correlation (`EXISTS (SELECT 1 FROM flagged_responses f WHERE f.status = 'open')`) passes all tests; every poll then reads held whenever ANY open flag exists anywhere in the DB — fail-safe direction (over-refusal, no leak), but a silent behavior regression the SQL-shape backstop was built to catch |
| LOW | `src/components/dashboard/reviews/edit-reply/useEditReplyDraft.ts:188-196` | Client comment now factually wrong: "body.status === 'failed' — ResponseGeneratorWorker did NOT insert a response row … no orphan can materialize" — the new held branch returns `failed` precisely when a pending_approval row DOES exist server-side. Behavior stays safe (re-open → gated 409, terminal-closable), and the file is deliberately out of surface (intake non-goal), but the close-safety argument documented there no longer covers all `failed` responses | A future maintainer trusts the comment and builds cleanup/auto-dismiss logic on `failed` assuming no server row exists, silently stranding held drafts out of the owner's sight |

No HIGH or MEDIUM findings. The implementation matches the intake contract,
the sanctioned deviations, and the plan's locked behavior table exactly; all
sanctioned gates and orderings are in place and test-pinned.

## 5. Low-confidence appendix (speculative — NOT findings)

- **A1 — queue-mock ordering fidelity (tests 7/8):** the tx-queue mock cannot
  detect a gate moved BEFORE the response lock — `hasOpenFlag` would consume
  the `[{ status: 'pending_approval' }]` entry, still return non-empty, and
  the test would still see 409 + a `flagged_responses` call. The post-lock
  placement is therefore pinned by code comment and review, not by the unit
  test. This is exactly the mock-fidelity tradeoff D1 triaged (live-DB matrix
  rejected; SQL-text assertions adopted instead) — recorded, not re-litigated.
- **A2 — precedence asymmetry:** PATCH checks offboarding before the tx (so
  offboarding-403 wins over held-409), DELETE checks held before offboarding
  (held-409 wins). Both refusals are text-free and the plan's precedence
  clarification sanctions any ordering; noted only as a mild surprise for a
  future reader diffing the two handlers.
- **A3 — `FOR UPDATE` + `ORDER BY … LIMIT 1` under READ COMMITTED:** the
  classic re-evaluation caveat (a concurrently-updated row can be returned
  out of version order) is mitigated here because every competing writer to
  this review's responses takes the review-row lock first, serializing the
  flows; the generator worker only INSERTs new rows, which no `FOR UPDATE`
  could have locked anyway. The route comment's "locks the one returned row"
  claim is correct in this topology.
- **A4 — owner-facing copy:** the drawer renders `body.error` verbatim, so a
  held poll/mutation shows the raw string "held_for_review" as the error
  message. Sanctioned by the intake ("client shows its terminal-closable
  failure state"; client untouched by design) — a #727-adjacent polish item,
  not a defect of this diff.

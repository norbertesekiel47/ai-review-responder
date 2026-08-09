# Standards & Maintainability Review — feat-726-legacy-hold-gates

- **Branch**: `feat-726-legacy-hold-gates`, reviewed since fork point `bea12e68c9d4fc7514347beb1bc31d9d2aff4092`
- **Reviewer lens**: `thermo-nuclear-code-quality-review` skill + repo standards (CLAUDE.md Working rules / gotchas), codebase-design deep-module discipline, CONTEXT.md glossary, test quality
- **Scope**: 5 code files (3 routes under `src/app/api/dashboard/past-replies/`, their 3 test files) + the approved `scripts/ci/tenant-scope-allowlist.ts` snippet amendment. Plan/intake/deviation docs read as context, not reviewed as code. D1–D5 accepted deviations and the allowlist amendment were treated as sanctioned and not re-litigated.
- **Date**: 2026-08-09

## Verdict

**APPROVE — NO ≥80%-confidence findings.**

This is a disciplined, minimal diff that consumes the existing deep module at the documented locus instead of growing new machinery. Verification evidence:

| Gate | Result |
|---|---|
| `vitest run` on the 3 modified suites | 3 files, **62 passed** |
| `pnpm typecheck` | clean |
| `pnpm eslint` on all 6 changed code/test files | clean |
| `pnpm ci:tenant-scope` | passed — entries 412 (baseline 412, amendment absorbed with no entry add/remove) |

## Findings table (≥80% confidence only)

NO FINDINGS

## Axis-by-axis analysis

### 1. Thermo-nuclear structural review

- **No new abstraction, no interface widening.** `src/lib/moderation/held-draft.ts` is untouched by the branch. All three tx call sites (`draft/route.ts:153`, `draft/[responseId]/route.ts:164` and `:245`) are one-line `hasOpenFlag(tx, …)` gates followed by the two-line refusal — the same shape as the pre-existing publish gate (`publish/route.ts:159`). This is the correct "use the canonical helper" move; there is no cleaner code-judo reframing available, because the gates *are* the minimal expression of the plan's locked behavior table.
- **No spaghetti growth.** Each gate sits at exactly the documented locus (post-`FOR UPDATE`, matching `hasOpenFlag`'s contract), guarded by comments that state the serialization constraint rather than narrate. The poller's held branch is a clean early return added to an existing linear status ladder.
- **File sizes**: `draft-status/route.ts` 175 lines, `draft/route.ts` 266, `draft/[responseId]/route.ts` 268; test files ~550–600. Nothing near the 1k boundary.
- **Lock-order comment verified accurate**: `draft/route.ts:126-130` claims review→response order "matches publish/PATCH — no deadlock"; confirmed against `publish/route.ts:104-147` (review lock at step 1, response lock at step 3) and PATCH steps 1/3.
- **Atomicity**: the new `FOR UPDATE` on the POST existing-draft SELECT (D1a) closes the check-then-act gap between the existing-draft read and the held gate; the gate and refusal live inside the same `sql.begin` as the lock. Correct direction — more atomic, not less.

### 2. Repo standards (CLAUDE.md Working rules / gotchas)

- **No `any`**: diff introduces none. Test casts use `as unknown as unknown[]` / `as TemplateStringsArray`, matching the files' pre-existing idiom.
- **String-literal statuses**: the banned categories (subscription status, tier IDs, job names, review status) are untouched. `NON_TERMINAL_STATUSES` is imported (both in `draft/route.ts`, pre-existing, and newly in `draft.test.ts` for the fc property — correct, not re-spelled). `'held_for_review'` is API error vocabulary, not a status enum, and follows the publish-route precedent (see appendix item 2). `'open'` inside the poller's EXISTS matches the semantic owner's own spelling and the sanctioned D6 precedent (`reviews/[reviewId]/draft-status/route.ts`).
- **Comment discipline**: every new comment states a constraint (invariant #4, post-lock serialization, tenant-before-held precedence, D6 rationale) with pointers to the semantic owner and plan §Serialization note — and I verified the comments against the plan text and the admin-flagged route's actual lock topology claims. Accurate, not narrative.
- **Route-handler orchestration**: the routes in this family carry in-handler tx logic as pre-existing structure; the diff adds delegating gate calls only, which is the conforming move, not a new violation.
- **Tenant-scope allowlist**: the two `sqlSnippet` fingerprints were updated to the new query text with no entry additions/removals and unchanged (still-accurate) reasons; audit green at baseline 412. Matches D5's sanctioned single amendment.

### 3. codebase-design deep-module discipline

- `held-draft.ts` remains the sole semantic owner. The only heldness predicate spelled outside it in this diff is the poller's correlated EXISTS (`draft-status/route.ts:124-127`) — the explicitly sanctioned D6 spelling, with the semantic-owner comment pointing back at the module, byte-shape-identical to the on-demand precedent. No other re-spelling anywhere in the diff (verified by grep across `src/` and `worker/`).
- No interface widening: `hasOpenFlag(tx, responseId)` consumed as-is; `HeldForReviewError` untouched.
- No abstraction created for a single caller; no wrapper around the refusal response (the inline two-line refusal matches the publish precedent and keeps failure mapping in the route layer per invariant #12).

### 4. Glossary (CONTEXT.md vocabulary)

- "moderation-held draft" and `held_for_review` used verbatim in all new comments, doc headers, and test titles; the invariant-#4 quotation ("surfaces neither its text nor any button") is reproduced exactly. No renames or synonyms introduced. (One trivial "moderation-held row" in the `[responseId]` doc header — appendix item 4.)

### 5. Test quality

- **Queue-mock reconciliation is minimal and correct.** Each pre-existing test that now crosses the gate gains exactly one `[]` rowset (hasOpenFlag → not held) plus an updated tx-queue comment; the DELETE offboarding test's call-count assertion moves 2→3 to match. Nothing else touched. I traced the tx queues against the route control flow (including the text-routed vs queue-consumed offboarding lookup difference between top-level and in-tx mocks) — they reconcile.
- **No weakened assertions.** Refusal bodies are asserted **exact** (`toEqual({ error: 'held_for_review' })`), sentinel non-leak checks run against the whole serialized body, and the no-mutation guarantee is asserted structurally (no `UPDATE responses` across all tx calls). The offboarding test kept its `FROM account_offboardings` last-call assertion.
- **Regression-detection genuinely works under the mock**: in the held DELETE/PATCH tests the queue is exhausted after `hasOpenFlag`, so a route that skipped the gate would fall through to `[]` rowsets and execute the UPDATE — tripping the no-UPDATE assertion. The real `hasOpenFlag` is deliberately unmocked and its bound response id asserted.
- **Mock-fidelity gap closed per D1(c)**: the poller suite's SQL-shape test asserts the correlated EXISTS + `status = 'open'` lives *in* the response lookup (regex verified against the actual SQL: only the EXISTS matches `= 'open'`), and the POST suite asserts `FOR UPDATE` on the existing-draft SELECT and the bound sentinel id on the flag query.
- **No copy-paste divergence in held-test idioms.** The three files share the same section-comment structure, sentinel technique (where draft text is in play — PATCH/DELETE return no payload, so sentinels are correctly absent there), and `joinTemplate` idiom; per-file sentinel suffixes are deliberately unique. Green characterization tests (poller release path, tenant-before-held) are labeled as such per D1(e).

## Low-confidence appendix (speculative / style preferences — NOT findings)

1. **D6 spelling count is now three** (`load-replies.ts` LATERAL, on-demand `reviews/[reviewId]/draft-status`, and this poller). `load-replies.ts:232` already earmarks "consolidating the spellings into one exported fragment is a #680 item", but the new poller comment doesn't cross-reference that earmark. A one-line pointer would keep the third site discoverable when the consolidation lands. (~60%)
2. **`'held_for_review'` vocabulary string** is now spelled inline in four route files plus `HeldForReviewError`'s message. Exporting a `HELD_FOR_REVIEW` constant from `held-draft.ts` would give the vocabulary a single owner. The publish route set the inline precedent and the CLAUDE.md literal ban doesn't cover error vocabulary, so this is a preference, not a violation. (~50%)
3. **Duplicated serialization-rationale comment**: the ~6-line "Post-lock placement serializes against the requires_regeneration disposition…" block appears near-verbatim at `draft/[responseId]/route.ts:158-163` and `:237-244` (and in condensed form in POST). If the admin-disposition lock topology ever changes, several comment blocks need lockstep edits; a single file-header note with short per-site pointers would be tighter. (~45%)
4. **Glossary micro-drift**: `draft/[responseId]/route.ts:16` says "moderation-held row" where the locked term is "moderation-held draft". The row *is* the draft; cosmetic. (~30%)
5. **Adjacent pre-existing debt (untouched by this diff)**: `draft-status/route.ts:98-102` hand-spells the outbox in-flight set as JS comparisons, while the on-demand route imports `OUTBOX_IN_FLIGHT_STATUSES` and documents that as the right tool for JS comparisons. Worth aligning whenever this file is next touched for behavior. (out of diff scope)
6. **Test idiom micro-inconsistency**: `joinTemplate` is defined at describe scope in `draft-id.test.ts` / `draft.test.ts` but inside the it-block in `draft-status.test.ts`. (~25%)
7. **fc property sampling**: `fc.constantFrom(...NON_TERMINAL_STATUSES)` under default `numRuns` re-samples a small finite domain ~100 times; `fc.assert(…, { numRuns: NON_TERMINAL_STATUSES.length })` would be exact-cover at lower cost. `it.each` was explicitly rejected in D1, so only the run-count is worth a thought. (~35%)

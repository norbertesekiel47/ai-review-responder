# Round-2 spec & correctness verification — `feat-860-ask-regeneration-surface`

Verification-only. Scope: the fix commits `c5a7606f`, `e77a7215`, `13fd7a8b`,
`40161961`, `db89a700` (plus `156b3457`, the docs commit that landed after the
brief). Round-1 material is not re-litigated; findings about unchanged code are
in the appendix, untriaged.

Nothing was edited in this worktree. Mutation checks were run in a throwaway
`git archive` copy under the scratchpad (deleted afterwards); the reviewed tree
was verified clean (`git status --short`) before and after.

---

## Verification matrix

| ID | Verdict | Evidence |
|---|---|---|
| **R1** | **CONFIRMED FIXED** | `LaneRefresh = 'replace' \| 'in_place' \| 'none'` (`ApprovalPanel.tsx:573`); `regenerate` passes `'in_place'` (`:675`); `refetch` sets `phase: LOADING` only for `'replace'` (`RequestsClient.tsx:530-536`). Mutation-checked: forcing `refetch` back to always-LOADING fails all three regenerate-lane cases. Stalled arm verified separately (below). |
| **R2** | **CONFIRMED FIXED** | Both titles moved verbatim to `requests-client.test.tsx` (no duplicate left in the panel suite) and now drive the real POST → refetch → poll loop. Mutation-checked: both fail with the old always-LOADING `refetch` (`expected 'Writing a new version. It will replac…' to match /could not write a new version.*uncha…/i`). The mount boundary is genuinely exercised. |
| **R3** | **CONFIRMED FIXED** | The `MGET` left `readLatestBatch`'s `sql.begin` and now runs in `attachRegenBudgets`, after the transaction closes (`batch-view.ts:731-746`, `:768-827`). `readSendLane` returns `regenBudgets: {}`. Fail-open contract byte-identical (same `peekAskRegenBudgetBatch`, same empty-map-on-failure, absent key still UNKNOWN, present `used: 0` still a known zero). Mutation-checked: moving the peek back inside the block fails the new lifetime-oracle test. |
| **R4** | **CONFIRMED FIXED** | New live-DB case `refuses an exhausted per-ask budget and leaves no outbox row behind` asserts the refusal AND a status-unfiltered `SELECT` over `job_outbox` returning zero rows, plus zero `ask_regeneration_requested` steps. Mutation-checked: `throw` → `return` fails on the surviving row. |
| **R5** | **CONFIRMED FIXED** | The dedup arm is now read at the enqueue and **answered after** `lockBatchForAction` (`approval.ts:578-604`), throwing `RegenRequestAbort`. Deadlock NOT reintroduced: the outbox `INSERT` is still the transaction's first statement and the advisory lock is still second; the ordering assertion (`outboxAt < advisoryAt`) in `does not deadlock when a worker completion races a second regeneration request` is untouched and passes. Mutation-checked: restoring the pre-ownership `return` fails the new foreign-tenant case (`already_in_flight` vs `not_found`). |
| **R6** | **CONFIRMED FIXED** | `NOT_REGENERABLE_COPY` is total over `Exclude<SendLaneView['batchState'],'built'>` (7 arms) with `NOT_REGENERABLE_FALLBACK` for an unknown state; `state` is now carried on `LaneOutcome.refused` and branched in `refusalCopy`. Mutation-checked: collapsing back to one sentence fails `names the state a refused regeneration was actually in`. |
| **R7** | **CONFIRMED FIXED** | The `stalled` arm renders `BuiltBatch` for a built view (`RequestsClient.tsx:214-224`), same element type at the same slot as the `ready` arm; the stalled note is a conditional child *inside* `BuiltBatch`. Mutation-checked: forcing the ghost fails `keeps a built batch approvable when polling gives up on a regeneration`. |
| **R8** | **CONFIRMED FIXED** | `regenerateControlName(regenerating, contactName)` builds the accessible name FROM the visible label (`AskList.tsx:74-78`), so WCAG 2.5.3 holds in both label states; assertions moved to accessible-name queries. Mutation-checked: restoring the static `aria-label` fails 7 panel cases + 3 client cases. |
| **R9** | **CONFIRMED FIXED** | `docs/directory.md:900` now reads "The three OWNER verbs"; `:706` enumerates all four regenerate entrypoints instead of "both". (Standards axis — verified opportunistically.) |
| **R10** | **PARTIAL** | The manufactured "rewrite" carve-out at `dashboard-regen-rate-limit.ts` is rewritten as an explicit known deviation with a do-not-cite clause; `ApprovalPanel`/`ApprovalActions` comments cleaned; the module's entrypoint count corrected. **One branch-introduced `_Avoid_` term survives** — see the table below. The three `re-roll` hits in `ask-generation.ts` are pre-existing (blamed to `a3f4ddb4`, #628, an ancestor of `main`) and out of scope. |
| **R11** | **CONFIRMED FIXED** | `askRegenBudgetKey` lower-cases the ask id (`tracker.ts:72-89`); it is the single owner of the key, so the worker's authoritative `checkAskRegenBudget` (`tracker.ts:358`) folds identically. The returned map is still keyed by the caller's id, so the route's `.get(input.askId)` and the panel's `regenBudgets[row.askId]` lookups are unaffected. Mutation-checked: dropping `.toLowerCase()` fails the new canonicalisation case. |
| **R12** | **CONFIRMED FIXED** | ADR 0020 now names `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` and states "There is **no** `regenerate_solicitation_ask` topic", reconciling with `CONTEXT.md`'s LOCKED entry. (Standards axis.) |
| **R13** | **CONFIRMED FIXED** | `rejects a cross-origin regenerate post` asserts 403 + `{error:'forbidden'}` + that `requireRole`, the Redis peek and the domain call were all skipped (`withSameOrigin` is the outermost wrapper). |

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| Low | `src/app/api/dashboard/solicitation/batch/regenerate/route.ts:34` | R10's sweep missed one branch-introduced `_Avoid_` term: the new route's only docstring calls the ask "being **re-rolled**". |

**Failure scenario.** `re-roll` is on **Ask regeneration**'s LOCKED `_Avoid_` list
(`CONTEXT.md:74`). `git blame` puts this line on `1b632563` — this branch — so it
is not inherited drift; it is the same class of drift R10 was accepted to stop,
sitting on the feature's HTTP entry point, which is the first file a newcomer
reads. Every other surviving occurrence in branch-changed production code either
cites the ban (`AskList.tsx:54-55`, `dashboard-regen-rate-limit.ts:133`), is the
one documented known deviation (`dashboard-regen-rate-limit.ts:141`), or is
pre-existing #628 text (`ask-generation.ts:10,1286,1377`). This one is
undefended. Cost to close: one word.

---

## Regression checks

| Check | Result |
|---|---|
| All 40 `tests_to_add` titles present verbatim | PASS (no `MISSING:` output) |
| `grep -rn 'it\.todo' src` | none |
| `it.skip` / `describe.skip` across the touched surfaces | none |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `ci:static-policy` · `ci:directory-map` · `ci:tenant-scope` · `ci:db-imports` · `ci:outbox-seam` · `ci:outbox-status` · `ci:live-db-suites` | all PASS |
| `pnpm test` (live-DB lane enabled: `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` exported) | **12588 passed, 11 skipped, 0 failed** (971/972 files) |
| Worktree clean after review | yes — only this report and the sibling round-2 standards report are untracked |

### Intake contract, re-checked after the fixes

- **`user_visible_behavior[6]`** ("says nothing changed on a worker-side refusal")
  is now **reachable in production**. `pendingRegen` survives the regenerate
  refetch because the panel is no longer unmounted; the settle effect fires and
  reports through `onChanged(..., 'none')`, which announces without triggering a
  further read. Proven by the two moved tests failing against the old
  composition.
- **`edge_cases[7]`** ("another batch or another tenant answers the uniform 404")
  is strictly stronger after R5: the in-flight branch no longer escapes it.
- **`invariants`**: #2 (outbox atomicity) is now positively asserted for the
  `budget_exhausted` arm as well as `not_regenerable`; #8, #13, #15 re-verified
  by the CI audits above; the cost-guard direction ("advisory peek fails OPEN")
  survived the R3 move unchanged, including the `used: 0` vs absent-key
  distinction; "at most one regeneration in flight per batch" is unchanged —
  R5 deferred only the *answer*, not the `ON CONFLICT` probe.

### Panel-remount verification, in detail

The brief asked specifically whether the panel can still unmount on the
regenerate path, "including via the `stalled` arm, which previously returned a
different element type at the same position".

1. **Accept path.** `refetch('in_place')` bumps `attempt` only; `phase` stays
   `ready` with the previous view until the new read lands, so `Screen` keeps
   returning `BuiltBatch` and `ApprovalPanel` is reused.
2. **`ready` → `stalled` transition.** Both arms of `Screen` now return
   `BuiltBatch` at the same position. The stalled note is a conditional child
   *above* `ApprovalPanel` inside `BuiltBatch`; React's array reconciliation
   tracks `fiber.index`, so a slot that goes from `false` to an element does not
   shift the following children. Verified empirically rather than argued: a
   throwaway probe deselected a contact, advanced past `POLL_CEILING_MS`, and
   asserted the checkbox was still unchecked under the stalled note — it passes.
3. **`onCheckAgain`** on the built-stalled arm calls `onReload('in_place')`, not
   `'replace'`, so asking again does not cost the owner their exclusions either.

The remaining unmount doors are `error` and `unavailable` — a failed *read*, not
a regeneration. Those were pre-existing and are unchanged by these commits.

### R5 lock-order re-derivation

The concern was that answering the dedup arm later means the dedup path now also
takes the advisory lock, which it previously skipped.

- The ABBA the enqueue-first order exists to prevent needs this transaction to
  hold the advisory lock while waiting on the worker's uncommitted outbox row.
  The probe is still statement one and the advisory lock still statement two, so
  that cycle remains unconstructible. `outboxAt < advisoryAt` still asserted.
- `ON CONFLICT … DO NOTHING` takes no row lock on a committed conflicting row, so
  the dedup path enters `lockBatchForAction` holding nothing.
- The added wait is bounded: `regenerateAsk` generates entirely **outside** any
  transaction (`ask-generation.ts:1394-1405`, "decision 7") and acquires the
  advisory lock only inside the short swap transaction (`:1409-1416`). No LLM
  call is ever inside the lock's scope.

---

## Appendix — not triaged, outside this round's scope

Recorded so a later reader does not mistake these for unnoticed. None is a
finding against the fix commits.

- **`refetch` failure still unmounts the panel.** An `in_place` refetch that
  returns 5xx or fails in transport sets `phase: 'error'` → `FailureCard`, which unmounts
  `ApprovalPanel` and discards `excludedAsks` with no loading card in between.
  Pre-existing behaviour of the read loop, unchanged by these commits, and a read
  failure has to render *something*. Only noting that the R1 fix closes the
  success path, not every path.
- **Built-stalled batches keep Approve disabled.** In the R7 arm the last-read
  view still carries `regeneratingAskId`, so Approve stays disabled until "Check
  again" returns a settled read. That is `user_visible_behavior[3]` working as
  specified, and it matches pre-#860 behaviour for a built batch read once with a
  regeneration in flight — but it is the one state where the owner's only route
  forward is the new affordance.
- **R11's cosmetic half was not in R11's accepted scope.** Round-1 finding 5 also
  noted that `readRegeneratingAskId` returns the outbox payload's ask id verbatim,
  so an upper-cased `askId` still makes `regeneratingAskId === row.askId` false and
  no row shows "Writing a new version…". TRIAGE scoped R11 to the budget bypass
  only, and that half is closed. The display half is untouched and remains open.
- **`ask-generation.ts:10, 1286, 1377`** carry `re-roll` from #628, before the term
  was coined and banned at #860. Unchanged code; a vocabulary sweep for it is a
  separate change, not this branch's debt.

---

## VERDICT

**PASS with one Low residual.** Every accepted round-1 finding in scope landed as
described and is backed by a test that fails against the pre-fix behaviour — each
verified by explicit mutation rather than taken on the commit message's word. The
R5 fix does not reintroduce the deadlock. R10 is the only partial: one
branch-introduced `_Avoid_` term in the regenerate route's docstring.

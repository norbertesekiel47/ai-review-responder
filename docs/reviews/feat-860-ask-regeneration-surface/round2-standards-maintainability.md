# feat-860 — round 2, standards & maintainability (verification only)

Scope: the six fix commits `e77a7215`, `c5a7606f`, `13fd7a8b`, `40161961`,
`db89a700`, `156b3457`. This is **not** a fresh review. Round-1 material is not
re-litigated; findings about unchanged code are in the appendix, untriaged.

Round-1 report: `standards-maintainability.md`. Triage: `TRIAGE.md`.

---

## Verification matrix

| ID | Verdict | Evidence |
|---|---|---|
| **R6** — refusal copy names the real state | **CONFIRMED FIXED** | `ApprovalPanel.tsx:344` `type RefusedState = Exclude<SendLaneView['batchState'], 'built'>`; `:360` `NOT_REGENERABLE_COPY` is a total `Readonly<Record<RefusedState, string>>` over all seven; `:380` `NOT_REGENERABLE_FALLBACK` for an unknown state; `:423` `toRefusedState` narrows against the record's own keys; `:493` `postLaneAction` now reads `result.state` instead of discarding it; `:511` `refusalCopy` branches on it. Totality is `tsc`-enforced — a new **Batch state** is a compile error, not a wrong sentence. Halt-latch copy rules hold: only "stop"/"stopped" appear (`:362`, `:366`, `:368`); no `pause`, `resume` or `cancel batch` in any arm, and `approval-panel.test.tsx:912` asserts `not.toHaveTextContent(/pause\|resume\|cancel/i)` on every one of the eight cases. |
| **R8** — accessible name matches visible label | **CONFIRMED FIXED** | `AskList.tsx:74` `regenerateControlName(regenerating, contactName)` builds the name **from** the visible label (`` `${REGENERATE_LABEL} the message to …` `` / `` `${REGENERATING_LABEL} of the message to …` ``), so WCAG 2.5.3 Label in Name holds by construction in both states and the in-flight swap moves the accessible name. Tests use accessible-name queries throughout: `approval-panel.test.tsx:192` defines `REGEN_CONTROL_NAME` and every control is found via `getByRole('button', { name })` (`:195`, `:200`); `:674`, `:777`, `:780` assert with `toHaveAccessibleName`. `requests-client.test.tsx:632` does the same. No surviving `toHaveTextContent` on the control. |
| **R9** — `docs/directory.md` drift | **CONFIRMED FIXED**, and the corrected premise is right | I re-grepped: `enforceDashboardRegenRateLimit` has exactly **four** production call sites — `reviews/[reviewId]/generate:50`, `reviews/[reviewId]/regenerate:23`, `past-replies/draft:102`, `solicitation/batch/regenerate:81`. The Past Replies site is gated `mode === 'regenerate'` (`draft/route.ts:100`), exactly as both the module header (`dashboard-regen-rate-limit.ts:8-23`) and `docs/directory.md:706` now say. `enforceRegenBudgetForReview` is Reviews-only (2 sites), as the row claims. `approval.ts`'s row (`:900`) now says three verbs and records that B11 is incomplete for an outbox-owning writer. Both are ENUMERATED, not counted — the right remedy for a fact that drifted twice. |
| **R10** — glossary `_Avoid_` terms | **CONFIRMED FIXED** for every site round 1 enumerated | All five fixable sites cleared: `CONTEXT.md` **Owner approval** now reads "never new bytes"; the **Ask regeneration** entry itself now says "regenerating a `withheld` row" / "an automatic re-attempt"; ADR 0020's `rewrite` is gone; `ApprovalActions.tsx:39` → "waits on a regeneration"; `ApprovalPanel.tsx:293` → "a regeneration supersedes the row". `dashboard-regen-rate-limit.ts:132-140` no longer manufactures a carve-out — it records a KNOWN DEVIATION and ends "Do not cite this comment as licence for the word anywhere else," which is the opposite of what round 1 objected to. The LOCKED 429 test title (`approval-panel.test.tsx:847`) is byte-identical. Four further `_Avoid_` occurrences round 1 never enumerated survive; all pre-date the fix commits → appendix A1. |
| **R12** — ADR 0020 phantom topic | **CONFIRMED FIXED** | `docs/adr/0020-…:39-57`: the enqueue is now named as `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` (`generate_solicitation_asks`) with an `ask_id` discriminator, followed by an explicit "There is **no** `regenerate_solicitation_ask` topic" paragraph that states *why* the sharing is load-bearing and reconciles the ADR with `CONTEXT.md`'s LOCKED claim. It also correctly records the two places the string does survive (a `requireAttempt` diagnostic label, a fictitious fixture topic). |
| **R14** — false comment in `ask-generation.integration.test.ts` | **CONFIRMED FIXED** | `:169-183` now states the real reason: `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` **does** exist and the sibling suite imports it; the literal is raw because one caller deliberately passes a fictitious topic to sidestep migration 091's `job_outbox_generate_solicitation_asks_inflight` partial unique index, and the comment names that as an acknowledged fixture shortcut. Its parenthetical claim is also true: `ci:outbox-topics` walks with `ratchet-harness`'s `DEFAULT_SKIP_DIRS`, which includes `__tests__` (`scripts/ci/lib/ratchet-harness.ts:26-28`), so nothing flags it. |

Incidental confirmation of the other axes' accepted findings (spot-checked while
reading the same diffs, not re-reviewed): **R3** peek hoisted to
`attachRegenBudgets` outside `sql.begin` (`batch-view.ts:692-745`, `:826`) with a
lifetime-not-ordering oracle (`batch-view.test.ts:685-734`); **R4** live-DB
`budgetRemaining: 0` case asserting the outbox row is gone *unfiltered by status*
(`approval.integration.test.ts:1328-1364`); **R5** `already_in_flight` deferred
one statement past `lockBatchForAction` and now throwing, with a foreign-tenant
conflict case (`approval.ts:598-621`, `approval.integration.test.ts:1287-1325`);
**R11** `askRegenBudgetKey` lower-cases in the single owner of the key
(`tracker.ts:91`) with a both-doors test; **R13** cross-origin 403 pinned
(`approval-routes.test.ts:528-543`).

---

## Findings

Both are about code introduced by a fix commit.

| Severity | file:line | Finding |
|---|---|---|
| Low | `docs/directory.md:125` | The `RequestsClient.tsx` row (added by `db89a700`) states the signature `refetch(mode: LaneRefresh)` and then explains all three members as `refetch`'s, but the exported hook is `refetch: (mode: RefetchMode) => void` with `RefetchMode = Exclude<LaneRefresh, 'none'>` (`RequestsClient.tsx:68`, `:530`); `refetch('none')` is a `tsc` error and the skip lives in `onLaneChanged` (`:121`). Same drift class as R9, in the commit that fixed R9. |
| Low | `src/lib/solicitation/approval.ts:660` | Round-1 R4's remedy named two live-DB cases; one landed. No test anywhere passes `budgetRemaining: null` to `requestAskRegeneration` — every live-DB case passes `3` or the new `0`, and `approval-routes.test.ts` mocks the domain — so the documented fail-OPEN half of the gate is unpinned. Rewriting it as `(input.budgetRemaining ?? 0) <= 0` type-checks and leaves the whole suite green while flipping the lane fail-CLOSED during the exact Upstash outage CLAUDE.md's "API rate limits fail OPEN by design" and `batch-view.ts:717-728` say must leave every control enabled. |

---

## The new abstraction, on the `codebase-design` lens

Asked explicitly, so a verdict rather than a finding.

**`LaneRefresh` as a required third argument — right seam, parent's vocabulary.**
The *fact* being carried is the panel's own and belongs on the write: approve and
halt end the panel, regeneration returns to it, the settle report reads a view
already in hand. Putting that in the parent would be the parent guessing, and the
guess is precisely what shipped broken. **Required rather than optional is
correct** and is the strongest part of the fix: any default silently reintroduces
R1 for verb four, and there is no safe default because the two live members
disagree about the harm.

The reservation is naming altitude, not structure. `replace` / `in_place` are
named for the parent's *render mechanism* (show `<LoadingCard/>` or don't), and
that type is exported from `ApprovalPanel.tsx` — the callee publishing the
caller's rendering vocabulary. The tell is `RefetchMode = Exclude<LaneRefresh,
'none'>` at `RequestsClient.tsx:68`: the parent has to carve one member off the
union it was handed, because `none` answers a different question ("fetch at
all?") from the other two ("how to render while fetching?"). A verb-level
vocabulary (`terminal` / `returns` / `reporting`) would need no `Exclude` and
would survive a change to how the parent renders a pending read. That is a
rename, both ends carry ~20 lines of prose explaining the current names, and no
call site is wrong today — so it is below the bar for the table.

**`BuiltBatch` is earned.** Two real callers (`ready` and `stalled`), a genuine
varying axis (the optional `onCheckAgain`), and it exists to make a structural
guarantee rather than to shorten a file: returning the same element type at the
same slot is what keeps `ApprovalPanel` mounted across `ready` ↔ `stalled`. I
verified the reconciliation actually holds — the stalled note is child index 0 of
a static three-slot fragment, so its `false` → `<div>` swap does not shift
`ApprovalPanel` at index 1 (`RequestsClient.tsx:286-330`).

**Junk-drawer question, re-asked.** `approval.ts` is still one coherent module —
`requestAskRegeneration` gained only comments and a moved statement, and the
directory row now carries the lock-order caveat that used to live only in the
docstring. `ApprovalPanel.tsx` grew 728 → 854. It is still inside its stated
interface (the additions are all "the resulting error copy"), but the copy
catalogue is now 21 keys across four server unions plus two narrowing helpers,
and it is the largest single thing in the file. Round 1 called this the file to
watch on verb four; the fix moves it closer to that line without crossing it. No
finding — recording it so the next round does not have to rediscover it.

---

## Regression checks

- **40 intake titles verbatim** — `jq -r '.tests_to_add[]' … | grep -rqF … src`:
  all 40 present, none missing.
- **`it.todo`** — none in `src`.
- **`any` / silent catch / bare status-topic-job literals** — `git diff
  a094cc0e..HEAD -- src` adds none. The one `catch`-adjacent line added is the
  *explanatory* "NO catch here, deliberately" block moved with the R3 hoist.
  `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` is spelled through the constant in the
  new R4 assertion.
- **`pnpm typecheck`** — clean.
- **Affected suites** (`dashboard/requests`, `src/lib/costs`, `batch-view.test.ts`,
  `api/dashboard/solicitation`) — 13 files, 228 tests, all passing.
- **`pnpm ci:directory-map`** — passed (555 files, no stale rows).
- **`pnpm ci:static-policy`** — passed.
- **Comment/doc drift introduced by the fixes** — one, in the table
  (`docs/directory.md:125`). Everything else I checked held: the
  `RefetchMode` docstring's "`none` never reaches here" is true; the
  `LANE_REFUSAL_COPY.not_regenerable` entry is load-bearing for `toLaneStatus`'s
  `Object.hasOwn` narrowing despite `refusalCopy` short-circuiting past it; the
  `ci:outbox-topics` claim in R14's new comment is accurate; the
  `docs/directory.md` `ApprovalPanel` row's quoted owner copy matches
  `ApprovalPanel.tsx:240` verbatim; the four-call-site enumeration matches the
  code.

---

## Appendix — untriaged, unchanged code (NOT findings)

Round-1 material my own round-1 report did not enumerate, recorded so round 3
does not rediscover it. None of it was introduced or touched by a fix commit.

**A1 — four further `_Avoid_`-term sites round 1 missed.** Round-1 finding 7
enumerated six violations; the repo actually carries ten. The four not listed,
therefore not fixed, all pre-dating the fix commits:
`src/app/api/dashboard/solicitation/batch/regenerate/route.ts:34` ("the one ask
being **re-rolled**" — production code, `1b632563`);
`src/lib/solicitation/__tests__/approval.integration.test.ts:1232`
("**Re-rolling** it would launder…", `1b632563`);
`src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx:670`
("**re-rolling** a withheld row…", `a094cc0e`);
`src/lib/solicitation/ask-generation.ts:1286` and `:1377` (inherited from #628,
the sibling of the `:10` line round 1 noted parenthetically). Cheap to sweep in
one pass with the enumeration above.

**A2 — two `docs/directory.md` rows the branch falsified and neither round
caught.** `docs/directory.md:127` (`AskList.tsx`) describes the file's two
components and never mentions `RegenerateControl`, the budget counter or
`regenerateControlName`, all of which now live there. `docs/directory.md:128`
(`ApprovalActions.tsx`) still ends "No edit and no regenerate affordance (D22) —
adding one would have to widen `ApprovalVerb` here and add an arm there"; a
regenerate affordance *was* added, in `AskList.tsx`, without widening
`ApprovalVerb` — so the sentence's second half is now a false prediction about
where such a control must go. Both were falsified by `a094cc0e`, before the fix
commits; `db89a700` swept the `RequestsClient` and `ApprovalPanel` rows and
stopped there.

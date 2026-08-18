# feat-872 — branch review round 2 — standards (verification-only)

Verified the three fix commits — `062439fd` (S3, S4, S10, S11: comment/doc only), `6a284617`
(S5–S9 + one added test) and `0e3966b1` (the mobile `@media` mirror for `.rq-ask-withdraw`) —
against the round-1 triage in `branch-round1-standards.md` (3–11 ACCEPTED; 1 and 2 REJECTED with
reasoning, not re-opened here). Method: `git show` of each commit; HEAD read of every touched region;
the S7 markup compared mechanically (`6a284617^` inline JSX vs HEAD `WithdrawControl`, indentation
stripped — identical apart from the `if (!armed) {` line); the S8 CSS compared declaration-by-
declaration (7 deleted `.rq-ask-withdraw*` rules vs the merged selector lists); the S3/S4/S5/S9
docblock claims checked against the code (`classifyWithdrawal` consumer, the property-test title,
`panelMode → haltable → askDisplay`, `withdrawAsk`'s `not_found` return, `read_only` = `halted` +
`nothing_to_send`, `count` = `settled`) and by grep (no test imports `isWithdrawableState` or
`BATCH_STATES` under `requests/__tests__/`; no `pendingAskId` left anywhere in `src/`; no `useEffect`
in the new hook — the one at `ApprovalPanel.tsx:907` is `usePendingRegeneration`'s, pre-existing).
Runs in the worktree: `pnpm vitest run "src/app/(authenticated)/dashboard/requests/__tests__/"
src/lib/solicitation/__tests__/approval.test.ts` → 4 files, **90/90** (83 + 7); `pnpm eslint` on the
five changed source/test files → clean; `pnpm typecheck` → exit 0. No owner-facing copy changed;
no _Avoid_-list word (unsend / cancel one / remove / veto ask / un-approve / exclude-post-approval)
was introduced by any fix — the "exclude"/"excluded" hits in the fix diffs all name the pre-approval
**Ask exclusion**, and the owner-facing word stays "Withdraw".

## Verification table

| round-1 # | fix commit | status (ADDRESSED / NOT ADDRESSED / REGRESSED) | note (file:line) |
|---|---|---|---|
| 3 | `062439fd` | ADDRESSED | `src/lib/solicitation/approval.ts:710-721` — docblock now names the real consumers: `classifyWithdrawal` (`:790` calls it) and the property test (`approval.test.ts:139` "withdrawable states are exactly the halt-cancellable states of an approved batch" — title verified verbatim; `:174`/`:204` call it). "The panel does NOT import it" — grep confirms the only `src/` importer is the test. "derives the same three **Batch states** by hand through `panelMode → haltable`" — `ApprovalPanel.tsx:169-185` routes `veto_window`/`approved`/`sending` to `haltable`, `askDisplay(haltable) = 'withdrawable'` (`:228-233`). "no test ties that mirror to this list" — TRUE: `approval-panel.test.tsx` example-checks five states by hand (built/halted/closed → none; veto_window/sending → present) and imports neither `isWithdrawableState` nor `BATCH_STATES`. |
| 4 | `062439fd` | ADDRESSED | `approval.ts:22-23` "All four verbs here do"; `:105-106` "the shared opening of all four owner verbs"; `:111-112` "`approveBatch`, `haltBatch` and `withdrawAsk` return `{ status: 'not_found' }`" — TRUE at `:216`, `:431`, `:841` (and `withdrawAsk` again at `:874` for the missing-ask arm); `:115` "four failures". `requestAskRegeneration` still THROWs (`:606`). |
| 5 | `6a284617` | ADDRESSED | `ApprovalPanel.tsx:938-985` — new file-local `useArmedWithdrawal(rows)` owning the `live` memo, the `armedAskId` state, `arm`/`disarm`; called at `:1026` and wired at `:1074-1080` (`onArm={arm}`, `onWithdraw` → `disarm(); withdraw(askId)`, `onKeep={disarm}` — same semantics as the inlined `setArmedAskId(null)`). The render-time disarm stays GUARDED at `:977-979`: writes only when a non-null armed id is no longer among the live rows, no write on ordinary passes, no `useEffect` (the hook body has none; `:907` is `usePendingRegeneration`'s). Header docblock `:28` restores "one file-local hook each" (the pre-branch `d89c112f` wording, widened THREE → FOUR); `useExcludedAsks` docblock `:398` "the first of the four". Precedent order (interface → docblock → hook, banner `── The armed withdrawal ──`) matches the three sibling hooks. `live` had no other consumer in the panel body (checked at `6a284617^`), so the move is lossless. |
| 6 | `6a284617` | ADDRESSED | `AskList.tsx:269` prop is `armedAskId`; panel passes `armedAskId={armedAskId}` (`ApprovalPanel.tsx:1074`). `rg pendingAskId src` → 0 hits (only the historical plan file and round-1 report still carry the old name — see appendix). |
| 7 | `6a284617` | ADDRESSED | `AskList.tsx:305-320` — row map reads `live && <WithdrawControl …/>`; `WithdrawControl` at `:335-391` (docblock `:328-334` cites `RegenerateControl`, which exists at `:208`; same after-the-list placement). Markup/aria/labels/disabled byte-identical to the two deleted guards at `6a284617^:301-337` (mechanical diff after indent-strip: only the added `if (!armed) {` differs). Both `<span>` roots, `role="group"` on the armed one, three `aria-label`s, `disabled={disabled}`, class strings — unchanged. React reconciles the same `<span>` root in place now (component at one child slot vs two sibling `&&` slots before), but the index-0 child changes type in both directions so the clicked button unmounts either way — no observable focus/behaviour difference; 10/10 `withdraw control` cases green. |
| 8 | `6a284617` | ADDRESSED | `requests.css:353-411` — every `.rq-ask-regen*` rule is now a selector list with its `.rq-ask-withdraw*` twin: container `:365-370` (display/align-items/gap/flex-wrap), `-btn` `:376-380` (padding/font-size/min-height), `:focus-visible` `:382-385`, `:disabled` `:394-399` (background/color/border-color/cursor), `:disabled:active` `:401-402`, `-count`/`-prompt` `:407-411` (font-size/color/white-space). Diffed against the seven deleted `.rq-ask-withdraw*` rules: no declaration lost, no value changed; the no-op `.rq-ask-withdraw-armed` rule (4 declarations already on `.rq-ask-withdraw`, which the armed span also carries — `AskList.tsx:367`) is deleted as triaged. Rule order relative to `.rq-ask-message` unchanged, so no cascade change. No markup change (S7 check). |
| 9 | `6a284617` | ADDRESSED | `AskList.tsx:25-44` — the header now says "An approved batch is NOT yet a **Settled batch** — that needs no `rendered`/`queued`/`sending` row left" (matches the LOCKED term); `AskList` "serves the screens where the choosing is over … a batch the Halt latch has stopped, and one that was ready with nothing sendable" — TRUE (`askDisplay`: `halted` + `nothing_to_send` → `read_only`; `settled` → `count`, i.e. "no list, only a count"; `expired` is a pre-approval state, so "past the live states" correctly excludes it). `WithdrawableAskList` docblock `:288-291` "must stay that way for the halted screen" (dropped the wrong "and settled"). |
| 10 | `062439fd` | ADDRESSED | `withdraw/route.ts:25-27` — cites "the halt and approve routes' `toWire` precedent (#629 round-2 finding F10)" plainly; the aside about those files' ADR 0012 misattribution is gone. F10 is real (`docs/reviews/feat-629-owner-approval-lane/branch-round2-standards.md:218`); the regenerate route already cites it the same way (`regenerate/route.ts:34`). halt/approve untouched, as triaged (outside the surface; D3 follow-up). |
| 11 | `062439fd` | ADDRESSED | `docs/directory.md:126` — "the four writes (approve, halt, regenerate, withdraw) in the file-local `useLaneWrites` hook"; matches the hook's return at `ApprovalPanel.tsx:1028`. |
| media mirror | `0e3966b1` | ADDRESSED | `requests.css:590-591` — `@media (max-width: 720px) { .rq-ask-regen, .rq-ask-withdraw { flex: 1 0 100%; } }`. Deliberate behaviour change on narrow viewports (the withdraw seat now drops to its own line like the regenerate seat — with the armed state's prompt + two buttons this is the intended layout, and it makes the S8 comment "every declaration below is shared … neither can drift" true for the media block too). Flagged by the fix agent, applied by the orchestrator, recorded in the commit subject. |

## Defects introduced by a fix

| # | severity | file:line | finding | triage |
|---|---|---|---|---|
| — | — | — | none at ≥ 80% confidence — every fix landed as triaged and each rewritten docblock/comment was checked against the code it describes | |

## Appendix (untriaged, out of scope)

- `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` is now **1,109** lines (was 1,076 at round 1): the S5 hook extraction adds an interface + docblock (+33). Consistent with the triage that REJECTED finding 1 as a blocker on this branch (the `── The write ──` extraction is the recorded follow-up after feat-865 and #872 both land) — noted only because it moves the number the follow-up will start from.
- `AskList.tsx:367` — the armed span still carries `rq-ask-withdraw-armed`, which after the S8 consolidation has **no CSS rule and no test selector** (`rg` finds it only in the markup and the plan). Byte-identical markup was the triage's own constraint, so this is the accepted consequence; it is a harmless styling hook, but a future reader will look for a rule that does not exist.
- `AskList.tsx:244-245` (`AskList` component docblock, **unchanged by the branch**, pre-dates it at `d89c112f:213`) still says "The same list once the batch is settled" — the same **Settled batch** paraphrase S9 fixed in the header, one component down; the `docs/directory.md` AskList row's "names and statuses once the batch is settled" mirrors it. Both are outside the fix's scope; a one-line follow-up alongside the D3 halt/approve cite fixes.
- `6a284617` adds one test beyond the accepted findings ("disables every withdraw control while a lane write is in flight", `approval-panel.test.tsx:1101-1124`) — pins the `disabled` prop the S7 extraction carries through both control states; its "pending-fetch technique" citation is accurate (`requests-client.test.tsx:251`, `:361`). Harmless; the promised-tests gate checks the 18 titles land, not that no others do.
- `docs/superpowers/plans/feat-872-ask-withdrawal.md:1850-2051` still shows the plan-era `pendingAskId` prop and the standalone `.rq-ask-withdraw-armed` rule (`:2069`); `…-deviations.md` D4 quotes the then-current "9/9 `withdraw control` … 82/82" counts. Historical plan text, not a doc of record — no action unless the deviations file gains a "review-round fixes" note at step 8.

VERDICT: APPROVED

---

## Triage (orchestrator, step 7 round 2)

Defects introduced by a fix: NONE — nothing to triage. 9/9 + media mirror ADDRESSED; `VERDICT: APPROVED` stands.
Appendix acted on (cheap, in surface): the read-only `AskList` docblock (`AskList.tsx:245`) and the `docs/directory.md` AskList row still paraphrased **Settled batch** ("once the batch is settled") one level below S9's fix — corrected in the round-2 commit to "read-only halted / nothing-left-to-send screens; a closed **Settled batch** shows a count". Not acted on: `rq-ask-withdraw-armed` marker class without a CSS consumer (byte-identical markup was the S7 constraint; harmless hook for future styling); `ApprovalPanel.tsx` at 1,109 lines (the REJECTED-as-blocker #1 follow-up); plan-era `pendingAskId` in the plan file (historical artifact — the plan is not re-edited after lock; deviations record the rename).

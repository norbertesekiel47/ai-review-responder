# Spec & correctness review — `feat-727-row-state-axes`

Reviewed diff: `ae110dfd...HEAD` (9 commits) in worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-727-row-state-axes`.
Inputs: `.feature/intake.json` (locked contract),
`docs/superpowers/plans/feat-727-row-state-axes-deviations.md` (all ACCEPT — treated
as locked context), `docs/reviews/feat-727-row-state-axes/blast-radius.md`.

## Verdict summary

**PASS — no findings at ≥80% confidence.** The branch implements the locked
axes + action projection faithfully: every intake field checks out, all 17
`tests_to_add` titles are present verbatim with bodies that assert what the
titles claim, the edit surface is respected, no `row_state`/`ReviewRowState`/
`deriveRowState` remnant survives anywhere in `src/`, `worker/`, or `e2e/`, and
the `groupReplies` row set is provably identical to the pre-change grouping for
every possible input. Verification evidence gathered during review:

- `pnpm typecheck` — clean
- `pnpm lint` (eslint .) — clean
- 7 changed unit suites — 150/150 pass
- `load-replies.integration.test.ts` run directly against the live test DB
  (`repworth-testdb`, `TEST_DATABASE_POOL_URL` from `.env.local`) — 3/3 pass

## Field-by-field intake table

| Intake field | Verdict | Evidence |
|---|---|---|
| `goal` — axes + action projection; `reply_state` + `row_action` on the wire; `draft_state` server-internal; posted×held stops rendering Regenerate | MET | `deriveAxes`/`deriveRowAction` in `src/lib/past-replies/replies-view.ts:114-162`; wire fields on `PastReplyRow` (`src/components/dashboard/reviews/PastReplyCard.tsx:37,45`); `deriveRowAction('posted','held') === 'none'` (`replies-view.ts:147`) |
| non_goal: #726 server gates | RESPECTED | No route files in the diff; changed-file list touches only past-replies lib, reviews components, history page tests, CONTEXT.md, ADR 0018, plan docs |
| non_goal: Generate route orphan exclusion | RESPECTED | `src/app/api/dashboard/reviews/**` untouched |
| non_goal: item-5 maintainability bundle beyond forced changes | RESPECTED | `toCardRow` keeps its `isOrphan` ternaries (`replies-view.ts:237-255`), only re-keyed from `reply === 'orphan'` |
| non_goal: EditReplyDrawer behavior | RESPECTED | `EditReplyDrawer.tsx` not in the diff; drawer reachable only via `onEditClick`/`onRecoveryClick`, which render only for `regenerate`/`recover` |
| non_goal: Needs Action / admin/flagged / D-H,D-F,D-C re-litigation | RESPECTED | No files under those surfaces in the diff |
| uvb 1: posted×held — live reply + badge visible, silent withdrawal | MET | Card `'none'` branch, `reply_state === 'posted'` arm (`PastReplyCard.tsx:255-271`): `ReplyBody` + `Provenance` + self-gating `RecoveryControl`; no button/counter/lock/held copy. Pinned by `past-reply-card-states.test.tsx:152,167` |
| uvb 2: none×held — unchanged "Reply on hold" panel from (none,'none') | MET | New panel (`PastReplyCard.tsx:277-289`) is byte-identical to the old `case 'held'` render (verified against `git show ae110dfd`: shield / "Reply on hold" / "We are double-checking…" / clock "Under review"). Reached only when `row_action==='none' && reply_state!=='posted'` |
| uvb 3: orphan×{generating,ready,held} → recover, total derivation | MET | `deriveRowAction` `case 'orphan': return 'recover'` (all four draft states); pinned at `replies-view.test.ts:308` and the 12-cell oracle |
| uvb 4: every other cell renders exactly as today | MET | Cell-by-cell comparison against `ae110dfd` card: `generate`/`generating`/`draft_ready`/`regenerate`/`recover` renders are unchanged; only posted×held differs (intended). 12-cell oracle pins the new presentation (`past-reply-card-states.test.tsx:312`) |
| uvb 5: posted + delete_failed sidecar keeps recovery in every draft state incl. held | MET | held: `'none'` branch renders `RecoveryControl` (`PastReplyCard.tsx:266`); none/generating/ready: `regenerate` → `AnsweredControls` → `RecoveryControl` when `failed_response_id` (unchanged). Pinned at `past-reply-card-states.test.tsx:341` |
| inv: #4 — held surfaces no text/affordance; draft axis never on wire | HELD | `PastReplyRow`/`ReviewsListRow` carry no `draft_*` key; exact key-allowlist test (`replies-view.test.ts:335`); integration suite asserts serialized view lacks the held draft's text (`load-replies.integration.test.ts:276`) |
| inv: live reply visible in every posted×* cell | HELD | Both posted renders (`regenerate` and the withdrawn `'none'` arm) mount `ReplyBody`; pinned at `past-reply-card-states.test.tsx:152,201` |
| inv: Answered/Unanswered split identical | HELD | Old: `row_state === 'regenerate'` ⇔ `!is_orphan && response_id !== null`. New: `reply_state === 'posted'` ⇔ same predicate. Equal for all inputs; pinned by the 12-cell grouping test (`replies-view.test.ts:315`) |
| inv: intra-axis precedence held > ready > generating > none | HELD | `deriveAxes` tests `draft_response_id` before `generation_in_flight`, `draft_held` on the same branch as ready (`replies-view.ts:124-131`); pinned at `replies-view.test.ts:287` |
| inv: card renders, never computes (D-D) | HELD | `ReplySide` dispatches on `row.row_action`; the `'none'` arm and `Provenance` read `row.reply_state` — both server-derived facts, no derivation client-side |
| inv: derivation total over 12 cells, exhaustive switch, no default fallthrough | HELD | Outer switch over `ReplyState` + inner over `DraftState`, no defaults; `RowAction` return type makes a missing branch a tsc missing-return error; fast-check totality property at `replies-view.test.ts:269` |
| inv: tenant scoping untouched, no query predicate changes | HELD | `load-replies.ts` diff is comments only; all four queries unchanged; `reviews-list.test.ts` scoping title still pins `business_id =` on all data queries |
| edge: posted×held + regen budget entry → no counter | MET | Counter renders only inside `AnsweredControls`; pinned at `past-reply-card-states.test.tsx:167` (budget passed, counter absent) |
| edge: posted×held + canEdit false → no lock | MET | Lock lives only in `AnsweredControls`; second render in the same test (`:189-198`) pins its absence |
| edge: posted×held + delete_failed sidecar → RecoveryControl stays | MET | `past-reply-card-states.test.tsx:341` (recovery is the only button; no held copy) |
| edge: none×none with editRepliesEnabled false → Generate panel | MET | `generate`/`generating` case renders `InlineGeneratePanel` unconditionally of the flag (`PastReplyCard.tsx:292-307`) |
| edge: `row_action 'none'` weakly inferable | ACCEPTED as designed | Documented in ADR 0018 Consequences |
| edge: fixtures lose `row_state`, gain typed fields | MET | All seven fixture files updated; `reply_state`/`row_action` are required non-optional members so tsc catches stragglers; typecheck clean |
| edge: `resumeGenerating` keys off `row_action === 'generating'` | MET | `PastReplyCard.tsx:304`; identical row set to the old `row_state === 'generating'` (both ⇔ none-reply + in-flight generation) |
| `tests_to_add` (17) | ALL PRESENT, bodies match | See table below |
| `allowed_edit_surface` | RESPECTED | Every changed file is inside the surface or the exempt workflow paths (`docs/superpowers/plans/**`, `.feature/**`); no `supabase/migrations/`, no `worker/`, no route files |
| `dependencies_added: []` | HELD | No `package.json` change in the diff |
| `rollback_plan` | PLAUSIBLE | No migration in the diff; wire shape derived per request; one revert restores the six-valued enum end-to-end |
| `observability` — staging proof | NOT VERIFIABLE IN-BRANCH | Ships in the PR description per intake; the wire-leak test surrogate exists (`replies-view.test.ts:335` + integration `:276`) |
| `verification_commands: []` | n/a | Reviewer ran typecheck/lint/unit/integration (see verdict) |

### `tests_to_add` — title-by-title

| # | Title (verbatim) | Location | Body asserts the claim? |
|---|---|---|---|
| 1 | never offers a draft affordance for a held draft in any reply state (invariant #4) | `replies-view.test.ts:259` | Yes — fast-check over all reply states; action ∉ DRAFT_AFFORDANCES; exact expected value per state |
| 2 | derives a defined action for every cell of the 3x4 cross-product | `replies-view.test.ts:269` | Yes — fast-check totality |
| 3 | withdraws Regenerate from an answered row whose replacement draft is moderation-held (posted x held) | `replies-view.test.ts:298` | Yes |
| 4 | keeps Regenerate for an answered row with a pending or in-flight replacement (posted x ready, posted x generating) | `replies-view.test.ts:302` | Yes (also pins posted×none — superset) |
| 5 | dominates recovery over every draft state on an orphan row | `replies-view.test.ts:308` | Yes — loops all four draft states |
| 6 | groups by the posted-reply axis — the Answered set is exactly the rows with a live posted reply | `replies-view.test.ts:315` | Yes — all 12 cells, exact answered set, 8+4 partition |
| 7 | never carries draft state or held onto the wire shape | `replies-view.test.ts:335` | Yes — exact key allowlist, not a blacklist |
| 8 | keeps the live posted reply and provenance badge visible for an answered row with a held replacement draft | `past-reply-card-states.test.tsx:152` | Yes — reply text + badge label |
| 9 | renders no Regenerate button, no counter, and no held indication for an answered row with a held replacement draft | `past-reply-card-states.test.tsx:167` | Yes — zero buttons of any name, no counter, no hold/under-review/lock copy; canEdit=false variant included |
| 10 | renders the live posted reply with Regenerate for an answered row without a held replacement draft | `past-reply-card-states.test.tsx:201` | Yes |
| 11 | renders the held panel with no draft text and no affordance for an unanswered review with a held draft | `past-reply-card-states.test.tsx:212` | Yes — panel copy present, no buttons, no links ("no draft text" is enforced structurally; see appendix L2) |
| 12 | returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held | `load-replies.integration.test.ts:258` | Yes — live query end-to-end; also key + serialized-value wire pins |
| 13 | maps every cell of the 3x4 cross-product onto the two axes | `replies-view.test.ts:279` | Yes — exhaustive nested loop |
| 14 | a settled ready or held response outranks an in-flight generation | `replies-view.test.ts:287` | Yes — four coexistence combinations |
| 15 | renders the locked presentation for every cell of the 3x4 cross-product | `past-reply-card-states.test.tsx:312` | Yes — raw facts → toCardRow → render → sole-permitted-affordance oracle per cell |
| 16 | keeps the delete-failed recovery control while withdrawing Regenerate for an answered row with a held replacement draft | `past-reply-card-states.test.tsx:341` | Yes — recovery is the ONLY button; held copy absent |
| 17 | distinguishes an open-held replacement from unflagged and closed replacements | `load-replies.integration.test.ts:279` | Yes — open flag vs no flag vs `dismissed_false_positive`, all against the live `flagged_responses` LATERAL |

Both intake copies (`.feature/intake.json`, `docs/superpowers/plans/feat-727-row-state-axes-intake.json`) are byte-identical (verified by diff after json normalization).

## Specific correctness probes

1. **posted×held.** Live reply + `Provenance` render; `RecoveryControl` self-gates
   on `editRepliesEnabled && failed_response_id` (`PastReplyCard.tsx:467`) — same
   gating the old `AnsweredControls` path applied. No button, counter, lock, or
   held copy is reachable in this arm. The only behavioral deltas from
   `ae110dfd` in this cell are exactly the intake's: Regenerate withdrawn, lock
   withdrawn, counter withdrawn.
2. **none×held panel.** Reachable only via `row_action==='none'` with
   `reply_state !== 'posted'`. Server-side, `'none'` is produced solely by
   posted×held (goes to the posted arm) and none×held (this panel); orphan rows
   always project `recover`. So no other server-derivable cell reaches the
   panel. Render is byte-identical to the pre-change `case 'held'`.
3. **Orphan cells.** All four → `recover`. `toCardRow` keys `isOrphan` off the
   axis (`reply === 'orphan'`, which is `r.is_orphan`, which the SQL defines as
   `orphan_sidecar.id IS NOT NULL AND resp.id IS NULL`); orphan field mapping
   (`response_id`/`failed_response_id` ← `orphan_failed_response_id`,
   `approved_text` ← `superseded_text`, nulled `posted_at`/`approval_method`/
   `version`) is unchanged from the old `rowState === 'recover'` keying and is
   pinned by `replies-view.test.ts:178` and `reviews-list.test.ts:455`.
4. **Wire carries no draft facts.** `PastReplyRow` has no draft member;
   `ReviewsListRow` adds only `provenance_badge` + nullable `response_id`;
   `PastRepliesPageView` carries `ReviewsListRow[]` + regen budgets/counts;
   `page.tsx` → `PastRepliesClient` → `PastReplyCard` passes rows through with
   no augmentation. Enforced by the exact-key-allowlist test and the
   integration suite's `JSON.stringify(view)`-lacks-held-text pin.
5. **groupReplies row-set equivalence.** Old answered predicate
   `row_state === 'regenerate'` and new `reply_state === 'posted'` both reduce
   to `!is_orphan && response_id !== null`; equal on every input, including
   posted×held (Answered in both worlds). Pinned by the 12-cell grouping test.
6. **Integration fixtures exercise the LATERAL.** Three answered rows each
   seed a live `posted` response + a version-2 `pending_approval` replacement
   (`pending_approval` ∈ `NON_TERMINAL_STATUSES`), then: open flag → `'none'`;
   no flag → `'regenerate'`; `dismissed_false_positive` flag → `'regenerate'`.
   Executed against the live schema in this review — 3/3 pass.
7. **No `row_state` remnants.** `rg "row_state|ReviewRowState|deriveRowState"`
   over `src/`, `worker/`, `e2e/` returns nothing — including string literals in
   tests. The only e2e "Regenerate" reference is the `/approve` page's button
   (different surface, unaffected).

## Caller-by-caller blast-radius notes

| Caller | Old-semantics reliance? | Note |
|---|---|---|
| `src/app/(authenticated)/dashboard/reviews/history/page.tsx` | No | Pure pass-through of `PastRepliesPageView`; grouping is server-side |
| `src/app/(authenticated)/dashboard/reviews/history/PastRepliesClient.tsx` | No | Never branches on any axis; drawer opens only via card callbacks, which only mount for `regenerate`/`recover` — posted×held can no longer open the drawer (intended) |
| `src/components/dashboard/reviews/EditReplyDrawer.tsx` | No | No axis reference; reads `review_content_hash`/`version`/`approved_text` — unchanged fields. Drawer-vs-RSC-refresh race is the deviations-log REJECTED scope (#726 gates are the defense) |
| `src/components/dashboard/reviews/edit-reply/useEditReplyDraft.ts` | No | Same unchanged fields; its test fixture updated to the two typed fields |
| `src/components/dashboard/reviews/InlineGeneratePanel.tsx` / `useInlineGenerate.ts` | No | `resumeGenerating` now keyed on `row_action === 'generating'` — identical row set to the old `row_state === 'generating'` (none-reply + in-flight). Poll cadence/keying (by `reviewId`) untouched. The held-settles-to-idle window is the locked #672 design, documented as ADR 0018 consequence |
| `src/lib/past-replies/load-replies.ts` | n/a (changed file) | SQL byte-identical; comments only |
| Test importers (5 files) | Updated | Fixtures migrated to `reply_state`/`row_action`; required non-optional typing catches any future straggler |
| `src/components/dashboard/settings/LocationsPanel.tsx` | False positive | `LocationRowAction`/`LocationRowState` are unrelated local reducer types |

## Findings

None at ≥80% confidence.

## Low-confidence appendix

- **L1 — type-representable but server-unreachable (orphan, 'none') renders the
  held panel.** The card's `'none'` arm is a two-way ternary on
  `reply_state === 'posted'`, so a hand-built row with `reply_state:'orphan'`,
  `row_action:'none'` would render "Reply on hold". No server derivation
  produces that pair (`orphan` always projects `recover`), and D-D forbids the
  card second-guessing the server, so this is a convention-guarded dead branch,
  not a defect. A three-way switch on `reply_state` with a never-default would
  make it structurally dead. Cosmetic robustness only.
- **L2 — test title 11's "no draft text" clause is not directly asserted in
  that body.** The unit body pins the panel and the absence of affordances; the
  draft-text claim is enforced structurally (the wire shape cannot carry it —
  key-allowlist test) plus the integration suite's serialized-value pin, where
  the text actually exists in the DB. The suite's own comment acknowledges the
  split. Coverage is real, just distributed.
- **L3 — `provenance_badge` stays loosely typed** (`?: string | null` on
  `PastReplyRow` vs `ProvenanceBadge | null` on `ReviewsListRow`). Pre-existing;
  the owner-locked "proper union types end-to-end" deviation named only the two
  NEW wire fields, which do carry unions. Out of this ticket's scope.
- **L4 — the 12-cell oracle's provenance is not part of the per-cell
  assertion.** `assertOnlyAffordance` checks affordances only; badge visibility
  for posted×held is pinned separately (title 8). A cell-level snapshot would be
  stronger but the intake's locked presentation claims are all covered by the
  combination.
- **L5 — integration suite ordering/avg assertions are fixture-count coupled**
  (7 reviews, avg exactly 3). Any future seeded row changes two assertions; the
  comments flag this. Maintenance note only.

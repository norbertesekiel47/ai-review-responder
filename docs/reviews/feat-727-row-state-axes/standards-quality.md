# Standards & Maintainability Review — `feat-727-row-state-axes`

- **Scope**: `git diff ae110dfd...HEAD -- src/` (13 files, +711/−202). Docs out of scope.
- **Process**: thermo-nuclear-code-quality-review skill; dimensions per the review brief
  (repo standards, deep-module discipline, Fowler smells, CONTEXT.md glossary, test quality).
- **Verification run**: `npx eslint` on all changed production + key test files — clean.
- **Verdict**: **APPROVE with findings.** The remodel itself is well executed — the old
  six-valued enum is fully deleted (zero `row_state`/`ReviewRowState`/`deriveRowState`
  references survive in `src/`), the wire moved from `row_state: string` + client-side cast
  to typed unions end-to-end, the derivation stays behind `replies-view.ts`, and the test
  additions are behavior-asserting and mostly excellent. One structural finding in
  `ReplySide` and two low-severity test-hygiene findings survive the confidence bar.

---

## F1 (Medium) — `ReplySide` dispatches panels off the Action slot, contradicting ADR 0018's own rendering contract, and the diff adds a verbatim-duplicate panel block

`src/components/dashboard/reviews/PastReplyCard.tsx:198` (switch), `:252-271` (new posted×held
branch) vs `:215-229` (`recover` case).

ADR 0018 states the rendering contract explicitly: *"Grouping (Unanswered/Answered) and the
reply panel key off `reply_state`; the affordance keys off `row_action`."* The implemented
`ReplySide` does the opposite: the whole render is a six-way `switch (row.row_action)`, with
`reply_state` consulted only inside the `'none'` arm (a nested ternary). Two consequences:

1. **Verbatim JSX duplication.** The new posted×held branch (`:262-271`) is byte-for-byte
   the same panel as the `'recover'` case (`:216-228`): `ReplyEyebrow` + `ReplyBody` +
   `Provenance` + `RecoveryControl`. The `'regenerate'` case is the same skeleton with
   `AnsweredControls` swapped in. Three arms now own copies of the posted/live-reply panel
   skeleton. Failure scenario: a change to the posted panel (new badge, layout tweak,
   accessibility fix) must be replicated across three switch arms; a missed arm silently
   diverges the posted×held rendering from posted×regenerate — exactly the class of drift
   the two-axis remodel exists to prevent.
2. **The panel is keyed off the wrong axis for unproducible wire combos.** The wire type
   now admits 18 `(reply_state, row_action)` combinations of which the server produces 7.
   Because the panel keys off `row_action`, a stray `(posted, 'generate')` row would render
   the "No reply yet — this review has no reply on Google" panel *under a live posted
   reply*, and `(orphan, 'none')` would render the "Reply on hold" panel on an orphan.
   Under the ADR's stated structure the panel would follow `reply_state` and degrade
   gracefully.

**Preferred remedy (code judo, behavior-preserving):** invert the dispatch to match the
model the branch itself introduced — outer `switch (row.reply_state)`:

- `posted` → one live-reply panel (`ReplyEyebrow`/`ReplyBody`/`Provenance`) + an action
  slot: `AnsweredControls` when `row_action === 'regenerate'`, `RecoveryControl` when
  `'none'`.
- `orphan` → one recovery panel (current `'recover'` body).
- `none` → inner `switch (row.row_action)` for the three genuinely different panels
  (generate/generating, draft_ready cross-link, hold panel).

This deletes the duplicated posted-panel blocks, restores "panel ← Posted-reply axis,
slot ← Action slot" as code structure rather than comment prose, and keeps the
`never`-typed exhaustiveness guard. Not flagged as a spec violation — behavior over the 7
producible cells is identical and pinned by the 12-cell oracle — but it is a structural
regression relative to the contract the ADR wrote down.

## F2 (Low) — stale "RED until Task 7" paragraph survives inside an actively rewritten header comment

`src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx:14-16`.

The diff rewrote the paragraphs immediately above (lines 7-12) and below (lines 18-22) for
the #727 axes, but kept: *"RED until Task 7: `PastReplyCard` has no Generate/Regenerate
affordance today, `ReviewsTabs` still gates the tab on `historyEnabled` and labels it
`History`, and `PastRepliesClient` still takes gapRows/histRows."* Every clause is false —
those shipped at #678 and this suite is green on this branch. Violates the comment
discipline the CLAUDE.md working rules imply (comments state constraints, not stale
narration) and the "clean every cross-reference in the same change" rule: a reader is
told the suite is failing-by-design when it is the shipped contract.

## F3 (Low) — property test titled "every cell of the 3×4 cross-product" randomly samples instead of enumerating

`src/lib/past-replies/__tests__/replies-view.test.ts:269-275` (and, mildly, `:259-267`).

`fc.assert(fc.property(fc.constantFrom(...3), fc.constantFrom(...4), …))` draws ~100 random
samples; it does not enumerate. With fast-check's per-run random seed there is a small
(~0.2%/run) chance some cell of the claimed totality is never exercised, and any failure
reproduces nondeterministically. The same file already uses the correct idiom — the
`deriveAxes` describe iterates all 12 cells exhaustively — and TypeScript already enforces
`deriveRowAction` totality via the return type. A two-line nested loop is smaller,
deterministic, and actually matches the test title. (The invariant-#4 property at `:259`
has the same shape but a negligible miss probability over 3 constants; fold both into the
exhaustive style for one idiom per file.)

---

## Dimension-by-dimension summary

- **Repo standards**: clean. No `any` (the two `as unknown as ReviewsListView` casts in
  the integration suite are the file's pre-existing idiom), no silent catches, no new
  `NEXT_PUBLIC_*`, ESLint boundaries respected (`PastReplyCard` imports `replies-view`
  type-only). The inline `'open'` / `'dismissed_false_positive'` literals in the new
  `seedFlag` fixture are acceptable: `flagged_responses.status` has no authoritative TS
  constant module — production (`held-draft.ts`) spells `'open'` inline too, and the test
  comment says so. The old-vocabulary purge is complete: zero `row_state` /
  `ReviewRowState` / `deriveRowState` references remain in `src/`.
- **Deep-module discipline**: `replies-view.ts` stays deep. Surface grew by one function
  and two type aliases (`deriveAxes` + `deriveRowAction` + `ReplyState`/`DraftState`/
  `RowAction` replacing `deriveRowState` + `ReviewRowState`) — justified by ADR 0018 and
  consumed only by `toCardRow`, the card (type-only), and tests. `DraftState` is exported
  but only as a type, so the "never crosses the wire" claim holds structurally; the
  exact-allowlist wire-key test and the integration `JSON.stringify(view)` sentinel pin it
  behaviorally. `ReplySide` remains derivation-free (both dispatch inputs are
  server-derived) — the F1 issue is *which* server fact drives the panel, not client-side
  re-derivation.
- **Fowler smells**: F1 is the one real duplication (production JSX). `factsFor` is
  duplicated between `replies-view.test.ts` and `past-reply-card-states.test.tsx` exactly
  as the plan sanctioned and the copies are field-for-field identical — no drift. No long
  functions, no feature envy, no speculative generality in production code.
- **Glossary (CONTEXT.md)**: fully conformant. "Posted-reply axis", "Replacement-draft
  axis", "Action slot", `reply_state`/`draft_state`/`row_action` are used verbatim in code
  and comments; no invented synonyms found (the `LocationsPanel` `LocationRowAction` hit
  is an unrelated pre-existing reducer type, untouched by this branch).
- **Test quality**: strong. The 12-cell oracle (`past-reply-card-states.test.tsx:312-339`)
  is a maintainable table — raw facts → `toCardRow` → render → `assertOnlyAffordance`,
  asserting via ARIA roles and exact button counts, not implementation innards. The
  integration suite's held/ready/closed-flag triple with negative controls and the
  `SECRET sentinel` serialization pin are exemplary. The wire-shape test's EXACT key
  allowlist makes a future `has_held_draft` leak fail loudly. F3 is the only test-quality
  deduction.

## Low-confidence appendix (not findings; no action required)

- `reviews-list.test.ts:52-54` — the local `ListCardRow` mock interface types
  `reply_state`/`row_action` as `string`; importing the exported unions would let the
  compiler catch fixture typos, but this is a mock-result shape, not the wire.
- `PastReplyCard.tsx:47` — `provenance_badge?: string | null` (with the
  `as ProvenanceBadge` cast in `provenanceLabel`) now sits beside two union-typed wire
  fields whose doc comment celebrates "the wire boundary carries the contract"; unchanged
  by this diff, but the inconsistency is newly conspicuous and a candidate for the same
  union-typing treatment.
- `past-reply-card-states.test.tsx:43-65` — `makeRow`'s default is `reply_state: 'none'`
  with `response_id: 'response-1'`, a server-unproducible pair (carried over from the old
  fixture). Harmless today because no panel branches on `response_id`, but a fixture
  builder derived from `factsFor` would keep fixtures inside the producible set.
- `InlineGeneratePanel.tsx:5-6` — "mounted only for the two Action slots that can reach
  it" reads as two *slots*; the glossary has one Action slot with six values. Wording nit.
- `replies-view.ts:84-86` — "Intra-axis precedence: held > ready > generating > none"
  slightly overstates: held/ready are mutually exclusive outcomes of `draft_held`, so the
  only real precedence edge is settled-row > in-flight-outbox (which the `deriveAxes` doc
  states correctly).
- The 18-vs-7 wire state-space widening (two fields where one enum lived) is inherent to
  the ADR-locked projection and mitigated by F1's remedy; noted only so a future
  "collapse it back" refactor knows the tradeoff was seen.

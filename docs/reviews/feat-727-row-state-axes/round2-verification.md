# Round 2 — Verification-only review (feat-727-row-state-axes)

Scope: verify the four round-1 accepted findings were fixed by commit
`480d5601` and that the fixes introduced nothing new. Verification-only —
no new fronts opened against unchanged code.

Commands run (all green):

- `pnpm vitest run src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx` — 13 passed (the 12-cell oracle suite)
- `pnpm vitest run src/lib/past-replies src/components/dashboard` — 59 files passed, 1 skipped (DB-gated); 465 tests passed, 3 skipped
- `pnpm typecheck` — clean

## Findings table

| # | Verdict | Evidence |
|---|---------|----------|
| 1 (Standards F1, Medium) | **VERIFIED** | `src/components/dashboard/reviews/PastReplyCard.tsx`: local `ReplyPanel` (lines 316–335, eyebrow + body + provenance + `children`) is used by all three arms — `regenerate` (202), `recover` (215), posted×`none` (257). Rendered DOM identical: same `div.pr-side.pr-side-reply` wrapper, same child order; the only additions are a type-only `ReactNode` import and the unexported component. The D-G comment survives inside the `recover` arm (216–217, renders nothing as a JSX comment); the silent-withdrawal comment survives on posted×`none` (251–256). The none×held "Reply on hold" panel stays inline and untouched (269–281), and the extraction's doc comment explicitly excludes it. Oracle suite passes (13/13). |
| 2 (Standards F2, Low) | **VERIFIED** | The "RED until Task 7…" paragraph is gone from `past-reply-card-states.test.tsx` (grep confirms no `RED until` in the file). The remaining header reads coherently: the D-D paragraph flows directly into "Prop shapes pinned here (Task 7 must match)", which is the still-true contract sentence, not the deleted staleness claim. |
| 3 (Standards F3, Low) | **VERIFIED** | `replies-view.test.ts` lines 268–274: the totality test is now an exhaustive `for (const reply of REPLY_STATES) for (const draft of DRAFT_STATES)` loop over all 12 cells; the `it()` title `'derives a defined action for every cell of the 3x4 cross-product'` is byte-identical to round 1. The unused `anyDraft` binding is removed; `anyReply` remains and the invariant-#4 property (258–266) still uses `fc.assert`/`fc.property` — the RISK-high intake requirement is intact. |
| 4 (Adversarial, High → docs-fix) | **VERIFIED** | Docs+comments only — the commit's `replies-view.ts` hunk touches exclusively `//` comment lines (`deriveRowAction` still returns `'recover'` for orphan); no route or module behavior changed. Wording present in both places: `replies-view.ts` 142–147 and ADR 0018 "Dominance is a claim about the **affordance**" (83–94). Every factual claim matches the code: `/retry` (`retry/route.ts` 105–114) and `/restore-original` (`restore-original/route.ts` 126–130) both 409 `newer_draft_exists` on any `NON_TERMINAL_STATUSES` sibling, and `pending_approval` (held) is first in that list (`src/lib/shared/response-status.ts` 25–30); `on-demand-generate.ts` 118–128 refuses orphans with `orphan_recovery_pending`; the map #710 capability-axis deferral is recorded in `adversarial-approach.md` (line 66) as the ADR cites. |

## Fix-introduced regressions

None found. The only new code is the unexported `ReplyPanel` component and a
type-only import; suites and typecheck are green.

## Appendix — untriaged observations (out of scope, no effect on verdict)

- Other test files on this branch still carry "RED until Task N" header
  paragraphs in the same style F2 removed (e.g.
  `src/lib/past-replies/__tests__/reviews-list.test.ts:12`,
  `src/lib/costs/__tests__/regen-budget-batch.test.ts:12`) — whether each is
  now stale depends on its task having landed; not assessed here.

ROUND 2: APPROVED

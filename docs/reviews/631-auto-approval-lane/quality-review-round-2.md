# #631 Auto-approval lane — standards & maintainability review, round 2 (verification-only)

- **Reviewer**: STANDARDS & MAINTAINABILITY agent, round-2 verification pass
- **Inputs**: `docs/reviews/631-auto-approval-lane/quality-review-round-1.md` (7 findings F1–F7,
  mapped Q1–Q7 in the orchestrator triage at the bottom) + fix commit `a459cea8`
- **Verification performed**: full `git show a459cea8` read; `pnpm typecheck` (green),
  `pnpm lint` (green), `pnpm ci:directory-map` (passed, 575 rows), `pnpm ci:tenant-scope`
  (passed, 393 entries — baseline unchanged), `pnpm ci:static-policy` (passed); live-DB vitest
  runs against `TEST_DATABASE_POOL_URL=localhost:5499` for
  `auto-approval.integration.test.ts`, `outcome-anchor-pairing.test.ts`,
  `settings.integration.test.ts`, `settings.test.ts`, `release.integration.test.ts`,
  `approval.integration.test.ts` — all green (25 + 113 tests passed, 0 failed); `git log` /
  `git show a459cea8^` used to confirm pre-existing state where relevant (Q5).

## Per-finding verdicts

**Q1 (F1, glossary "auto lane") — RESOLVED.** All 12 sites the finding named are fixed
(`release.ts`, `release.integration.test.ts`, `auto-approval.integration.test.ts`,
`outcome-anchor-pairing.test.ts`); grep for `auto lane|Autopilot lane` across
`src/lib/solicitation/`, `src/lib/auto-approval/`, and the pairing test confirms zero remaining
in-scope hits. The one surviving hit, `src/lib/solicitation/approval.ts:80`, was explicitly
called out by F1 as pre-existing/out-of-scope ("candidate for a follow-up") — correctly left
untouched, not a miss.

**Q2 (F2, glossary "Autopilot lane" in `flags.ts`) — RESOLVED.** `flags.ts:19-20` now reads
"Gates ONLY the Auto-approval lane". Confirmed via diff and grep.

**Q3 (F3, phase-seam extraction) — RESOLVED.** New `src/lib/solicitation/release-phases.ts`
owns `PhaseTally`/`isolateItem`/`recordItemFailure`/`alertPhaseFailure`/`tallyPhase`; both
`release.ts` and `auto-approval.ts` import it (no cycle — both depend downward). The duplicated
`isolateAnchorItem`/`VetoAnchorTally`/`ANCHOR_ITEM_FAILURE_MESSAGE` in `auto-approval.ts` are
deleted outright; `anchorVetoDeadlines` now calls the shared `isolateItem('veto_anchor', …)` and
returns the shared `PhaseTally`. The drift F3 flagged (phase baked into message text) is gone —
the anchor's failure line now uses the ONE stable `ITEM_FAILURE_MESSAGE`, with `phase` carried
only as the Sentry tag, matching every sibling. `docs/directory.md` gained the `release-phases.ts`
row in the same commit. `pnpm typecheck`/`lint` green; `release.ts`'s five existing `isolateItem`
call sites needed no changes (the phase-string-first signature was already in place pre-extraction).

**Q4 (F5, D19 account-wide suspension — one owner) — RESOLVED.** `readAccountWideSuspension`
(`src/lib/solicitation/auto-approval.ts`) is now the sole spelling of the `EXISTS (... suspended_at
IS NOT NULL)` read; `readAutoApprovalConditions` delegates to it, and the settings expansion gate
(now `assertSolicitationExpansionAllowed` in the new `solicitation-settings.ts`) calls the same
exported function instead of re-spelling the query. Grep confirms no second `SELECT EXISTS`
spelling of this predicate remains in the repo.

**Q5 (F4, premise-correction per task instructions) — RESOLVED, premise confirmed stale as
directed.** Verified directly: `applyDowngradeSplit` (`release.ts`) already called
`Sentry.captureMessage(message, { tags: { reason: result.reason }, ... })` with its own per-lane
title (`DOWNGRADE_ALERT_MESSAGE` / `AUTO_DOWNGRADE_ALERT_MESSAGE`) — and the integration test "the
auto downgrade records its exact reason and never judge_unavailable" already asserted this
`captureMessage` call (title + `reason` tag) in commit `0110e57e`, the parent-of-parent of the fix
commit, i.e. it predates round-1 review entirely. The wrong comment (claiming
`Sentry.captureException` groups by message text, attached to the now-deleted
`isolateAnchorItem`/`ANCHOR_ITEM_FAILURE_MESSAGE`) is gone — it died with Q3's deletion, confirmed
by grep (`ANCHOR_ITEM_FAILURE_MESSAGE`, `isolateAnchorItem`, `captureException groups by message`
all zero hits repo-wide). No wrong comment remains.

**Q6 (F6, `SolicitationCapField` duplication) — RESOLVED.** `DailyCapField` now takes
`label`/`hint`/`placeholder` props; both the Reply-lane call sites and the Solicitation call site
route through it; `SolicitationCapField` and its ~50-line body are deleted. Grep for
`SolicitationCapField` and the removed `effectiveDailyCap` prop returns nothing. `expansionBlocked`
is correctly wired `false` at the Solicitation call site (documented no-op arm) since that lane's
expansion question is answered by the `onCommit` classifier, not a readiness block.

**Q7 (F7, `settings.ts` decomposition) — RESOLVED.** New `src/lib/auto-approval/solicitation-settings.ts`
(343 lines) holds the full Solicitation-lane unit (row-state type, mutation applier, exposure
classifier, expansion gate, audit writer, loader, upsert); `settings.ts` shrinks by ~290 net lines
and joins at exactly two points — `updatePolicyInTransaction`'s solicitation branch (PATCH) and
`loadSolicitationApiState`'s call from the GET path — matching both the commit message and the new
`docs/directory.md` row. `accountSubscriptionWritable`, `assertConfirmationProvided`, and the
`SettingsAccountEntitlementRow`/`SolicitationPatchInput` types are now exported from `settings.ts`
for the new file to consume.

## Fix-introduced observations (below the 80% bar, not filed as defects)

- **Two-file value-level circular import** between `settings.ts` and `solicitation-settings.ts`
  (`settings.ts` imports `applySolicitationMutation`/`loadSolicitationApiState`;
  `solicitation-settings.ts` imports `accountSubscriptionWritable`/`assertConfirmationProvided`/
  `AutoApprovalExpansionBlockedError` back). Functions only, no top-level value use, so ESM/CJS
  hoisting makes this safe in practice — typecheck, lint, and all live-DB tests pass. The repo
  already has one accepted precedent for a two-file cycle (`config/server` ↔ `price-tier-map`,
  documented inline). Not filed as a defect: it works, it's the natural shape of a
  bidirectional-but-deferred split, and F7 never asked for cycle-freedom the way F3 did for
  `release-phases.ts`. Noted for awareness only.

## Appendix (untriaged, out of scope for this pass)

- `src/lib/solicitation/release-phases.ts`'s `recordItemFailure` export docstring ("exposed
  separately because the RELEASE phase cannot use the wrapper... bare try/catch") describes a
  calling pattern that no longer exists in `release.ts` (the release phase now uses `isolateItem`
  via `runAccountArm`, per that function's own adjacent comment: "An earlier revision used bare
  trys... no longer true of this one"). This is byte-identical text carried over from the
  pre-existing `release.ts` into the new file — unchanged content, not introduced by this fix —
  so it is out of scope for this review, recorded here only for a future doc-accuracy sweep.

## Verdict

Q1 RESOLVED — 12/12 glossary sites fixed; the one remaining "auto lane" hit was explicitly
out-of-scope pre-existing text per F1.
Q2 RESOLVED — `flags.ts` comment aligned to the locked term.
Q3 RESOLVED — phase seam extracted to `release-phases.ts`, duplicate deleted, tag-not-text fixed.
Q4 RESOLVED — `readAccountWideSuspension` is the one owner, consumed by both call sites.
Q5 RESOLVED — premise confirmed stale as directed; Sentry call was already test-pinned pre-fix;
wrong comment died with Q3's extraction.
Q6 RESOLVED — `DailyCapField` parameterized; `SolicitationCapField` deleted with no residue.
Q7 RESOLVED — `solicitation-settings.ts` extracted; exactly two join points; directory.md updated.

AXIS VERDICT: APPROVED

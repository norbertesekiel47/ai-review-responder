# Deviations — `fix/1361-locations-route-fault-status`

## D1 — surface amendment: `.claude/reference/arch-review-log.md`

**What the plan did not anticipate.** The `merge-ledger` audit fails any PR that
changes a production file and adds no line to `.claude/reference/arch-review-log.md`.
That file sits outside every tree the locked surface covered, so the gate went
RED on a file the workflow itself mandates.

**Action.** Added `.claude/reference/arch-review-log.md` to
`allowed_edit_surface` in both intake copies. Counted as surface amendment 1 of 2
(`scripts/feature-state.sh incr-amendment`). The rule auto-approves an amendment
only inside an already-covered tree, so this one is reported to the owner rather
than treated as silent.

**Verdict:** ACCEPT — the audit is a required CI check; the alternative is a
branch that cannot pass `lint`. The amendment adds one documentation file and
narrows nothing.

## D2 — `estimated_prod_lines` corrected 8 → 24

**What the plan did not anticipate.** The `reclassify` gate row counts changed
production lines including comments. The two `throw err;` statements are 2 lines;
the two citation comments explaining WHY a server fault must not read as 401 are
19 more. 21 changed lines against an estimate of 8 tripped the 2× trigger.

**Action.** Re-ran step 0 with the real numbers. SIZE stays **small**, RISK stays
**high**, SURFACE stays **backend** — the lane does not change. Estimate
corrected to 24 in both intake copies (24 covers the ledger line from D1).

**Verdict:** ACCEPT — an estimating error, not a scope change. The lane is
unchanged, so no re-plan is owed.

## D3 — the `build` gate row fails on `main`, before this change

**What the plan did not anticipate.** `pnpm build` fails in this worktree with
567 copies of `Error: Cannot find module '@vercel/turbopack/postcss'`, every one
of them in a landing-page CSS import.

**Evidence that it is not this change.** Reverted all four changed files to
`650f625e` (the merge-base, which equals `origin/main`), rebuilt, and got a
byte-identical failure: same 567 errors, same module, same components. Then
restored the committed files. Ruled out as causes: `pnpm install --frozen-lockfile`
reports "Already up to date"; `@next/swc-darwin-arm64@16.3.0` matches the host
(`arm64 darwin`); `postcss`, `tailwindcss` and `@tailwindcss/postcss` are all
installed; clearing `.next` and rebuilding reproduces it exactly.

This change touches two `.ts` files under `src/lib/` and their tests. It imports
no CSS, no component and no PostCSS plugin.

**Action.** Not fixed on this branch. It is a worktree-environment defect on
`main`, in the same class as the known local ESLint react-hooks plugin linking
breakage (2026-09-20 session note: pre-existing on `main`, passes in CI). CI runs
`pnpm build` on a fresh Blacksmith install, which is the authoritative signal.

**Verdict:** ACCEPT — out of scope for #1361, with the pre-existence proven by
the revert-and-rebuild test rather than asserted. The gate carries this row as a
known-RED environmental row; the PR's own `build` check is the real gate, and it
must be green before merge.

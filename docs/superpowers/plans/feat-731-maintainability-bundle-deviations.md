# feat-731-maintainability-bundle — deviations

Entries are things the plan did not anticipate. Every entry gets a triage verdict
(ACCEPT / RE-PLAN) at step 6, before any review agent is dispatched.

---

## D1 — Surface overlap with #740 (`feat-719-drip-dropped-column`): ACCEPTED, no merge-order constraint

`scripts/feature-setup.sh` flagged one code-pair collision:
`scripts/ci/tenant-scope-allowlist.ts`, also declared by the armed worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column`
(PR #740, `fix(#719)` onboarding drip dropped-column repair).

Investigated at intake, before planning. The two edits are **region-disjoint and
semantically independent**:

| | #740 (PR open, `CONFLICTING`) | #731 (this branch) |
|---|---|---|
| Region | `ONBOARDING_DRIP_CANDIDATES_SQL`, ~line 128–140 | ledger comment ~line 51–69, `ALLOWLIST_BASELINE` line 70, three `load-replies.ts` entries ~line 1284–1304 |
| Entry count | unchanged | 3 entries → 1 (**shrink**) |
| `ALLOWLIST_BASELINE` | **not touched** (verified: `git diff <merge-base> HEAD -- scripts/ci/tenant-scope-allowlist.ts` contains no `ALLOWLIST_BASELINE` line) | 409 → 408 |

Because only one side moves the baseline, neither branch has to re-derive the
other's number — the failure mode the earlier charting note worried about
("both must regenerate the SAME three pinned entries") does **not** materialise:
#740 regenerates a *different* constant (`ONBOARDING_DRIP_CANDIDATES_SQL`), and
#731 regenerates the three `load-replies.ts` entries. The two regions are ~58
lines apart, well outside git's 3-line merge context.

**Agreed order: either, recommended #731 first.** #740 is currently
`mergeable: CONFLICTING` and needs a rebase for unrelated reasons, so it will
rebase onto a `main` that already carries #731; that rebase is textual and clean.
Nobody is actively working #740 (parked pending rebase), so no live coordination
is needed. Surfaced to the owner at step 3 so the fact travels with #740 when it
is resumed — **not** written into #740's own deviations file, because editing
another armed worktree from this session would cross that worktree's
edit-surface guard.

**Verdict: ACCEPT.** No surface narrowing, no amendment, no amendment-budget
charge (`allowed_edit_surface` is unchanged from the locked intake).

---

## D2 — PR #747 (`codex/authenticated-dashboard-design-audit`) is NOT a collision

Recorded because it looked like one and the next reader will hit the same trap.

The parent checkout sat on `codex/authenticated-dashboard-design-audit` (PR #747)
whose `git diff origin/main -- src/lib/past-replies/load-replies.ts` shows a
15-line diff that **inverts #730's `openFlagExistsSql` composition** — it appears
to revert merged work on a file this bundle edits.

It is pure branch staleness, not a revert. #747's merge base is `76b40b7b`,
which predates #730; diffing a stale branch against a moved `main` renders the
newer commit's change backwards. Against its own merge base the branch touches
**none** of this bundle's files:
`git diff $(git merge-base origin/main HEAD) HEAD -- src/lib/past-replies/ src/lib/costs/ src/lib/shared/ scripts/ci/ worker/` is empty, and the PR reports
`mergeable: MERGEABLE`.

**Lesson (promote at step 8):** when checking a feature's file-set collisions
against open PRs, diff each branch against **its own merge base**, never against
current `main`. The latter reports every commit the branch simply hasn't merged
yet as an outgoing change, which reads exactly like a revert.

**Verdict: ACCEPT** (no action; documentation only).

---

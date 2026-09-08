# Deviations — #1178 `scripts/mint-admin.ts`

Every entry is something the plan did not anticipate. Step 6 records a
one-line **Verdict:** ACCEPT or RE-PLAN against each before the review wave.

---

## D1 — the script never reads `auth.users` unconditionally

**When:** step 3, before the plan was written.

**What:** the ticket's shape implies a Postgres-side lookup for an existing
Auth identity, and `src/lib/auth/provision-auth-user.ts:67-77` does exactly
that in production code. But `scripts/ci/test-db-bootstrap.sql:57-60`
provisions schema `auth` with `auth.uid()` and **no `auth.users` relation**, so
an unguarded probe makes the module unrunnable against the local and CI test
databases — including its own live-DB suite.

**Adaptation:** the probe is guarded by `SELECT to_regclass('auth.users')` and
reports `authProbe: 'unavailable'` loudly when the relation is absent; the
real-run refusal is closed independently by `auth.admin.createUser`'s own
duplicate-email error. Both intake copies were updated before arming, so no
locked decision moved.

**Verdict:** ACCEPT. Verified against the tree, not the memory of it: the
bootstrap creates schema `auth` and `auth.uid()` and no `auth.users`, and the
live container confirms it (`to_regclass('auth.users')` is NULL there while
`admin_audit_log` resolves). The adaptation is strictly stronger than what the
plan first proposed — TWO independent refusals instead of one — and plan round
1 independently reached the same gap from the other side (dry-run parity), then
round 2 accepted this remedy over its own `listUsers` proposal. `never a silent
"no such identity"` is pinned by the test `reports the auth probe as
unavailable when auth.users is absent`.

---

## D2 — the ladder does not survive `feature-setup.sh`

**When:** step 2, and again after each intake re-install.

**What:** `scripts/feature-setup.sh` carries the PARENT checkout's
`progress.json` into the armed worktree. The parent's ladder was a finished
`small·normal` run, so every re-arm reset this run's ladder to
`small·normal · 81% · gate/review/ready done`.

**Adaptation:** re-run `progress.mjs init` plus explicit `step … pending`
resets after every `feature-setup.sh` invocation. Cosmetic — `.feature/state.json`,
not `progress.json`, is the phase authority — but a stale ladder is exactly the
kind of "claim a phase from memory" the working rules forbid, so it is fixed
rather than tolerated. Candidate lab note at step 8.

**Verdict:** ACCEPT. Cosmetic and outside the change's blast radius: it touches
no repository file, and every phase claim in this run is read from
`.feature/state.json` (`phase=gate_green head=82b19407`), never from the
ladder. Invalidates no locked decision. The durable lesson — re-`init` the
ladder after `feature-setup.sh` — is promoted at step 8 rather than left here.

---

## D3 — surface amendment #1: `.claude/reference/arch-review-log.md`

**When:** step 5, first full gate run.

**What:** `ci:merge-ledger` went RED. Its GOVERNANCE trigger is a `scripts/ci/`
PREFIX with no test-file exclusion (`scripts/ci/merge-ledger-audit.ts:57,101`),
so this branch's two new suites under `scripts/ci/__tests__/` require one added
line in `.claude/reference/arch-review-log.md` — a file the intake did not
list. The edit-surface guard blocked the write, correctly.

**Adaptation:** amendment #1, applied and counted
(`feature-state.sh incr-amendment` → `surfaceAmendments=1`). It is not scope
creep: `/feature` step 8 already mandates a line in that exact file for every
run ("Entropy counter"), and a REQUIRED CI audit fails without it, so the file
was always in this change's path and the intake simply omitted it. There is no
way to avoid it — the audit's trigger has no test-file carve-out, and moving
the suites out of `scripts/ci/__tests__/` would mean editing `vitest.config.ts`
(a broader amendment), since that is the only `scripts/` path the include list
matches.

**Owner visibility:** flagged in the run report. The orchestrator brief's hard
stop is a SECOND surface amendment; this is the first, and no further amendment
is expected.

**Verdict:** ACCEPT. It widens no capability and invalidates no locked
decision: the added path is an append-only prose ledger, the added text asserts
nothing the branch does not do, and the audit deliberately does not read or
write the counter number — so nothing about this change's authority or blast
radius moves. The alternative (relocating the suites, which means editing
`vitest.config.ts`) is a strictly broader amendment for no benefit.

---

## D4 — step-0 re-run: the production-lines estimate was 3.3x low

**When:** step 5, same gate run — `reclassify` WARN (982 production changed
lines against an estimate of 300).

**What:** two causes, both estimation errors rather than scope changes.
(a) `scripts/mint-admin.ts` is 810 lines because the house style carries the
reasoning in the code, and here the reasoning IS the reviewable part (the
conditional-compensation rule, the ref-parsing guard, the self-actor
justification) — the three plan rounds added most of it. (b) The gate's
production bucket counts `docs/runbooks/mint-admin.md` (172 lines); only
`docs/superpowers/plans/**` and `docs/reviews/**` are excluded as workflow
artifacts. The estimate treated the runbook as documentation.

**Adaptation:** step 0 re-run with the real numbers, per the trigger. **The
classification does not move**: `size=standard` (one seam, one production file,
five tracers, a tight surface), `risk=high`, `surface=backend` — only the
estimates were wrong. `estimated_prod_lines` 300 → 1000,
`estimated_test_lines` 420 → 800 (measured 776, already inside 2x). Recorded
rather than silently re-baselined, so the miss is visible to the review wave.

**Verdict:** ACCEPT. The trigger asks for a re-classification, and the
re-classification was performed and came back unchanged — this is the trigger
working, not a decision being invalidated. Guard against the obvious objection
(raising an estimate to silence a WARN): the surface is still six code-bearing
paths, the diff still has ONE production module and no second seam, and the
review wave receives this entry, so the size claim is checkable rather than
asserted. The standards axis joins the wave on the measured number regardless
(risk is high, and 982 is well over the 300-line threshold).

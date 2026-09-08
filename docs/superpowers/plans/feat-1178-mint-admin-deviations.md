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

**Verdict:**

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

**Verdict:**

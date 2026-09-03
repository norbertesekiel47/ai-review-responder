# Deviations — feat/stripe-customer-redaction

## D1 — the armed ladder carried a stale classification

**What happened.** `scripts/feature-setup.sh:88` runs
`progress.mjs carry "$PARENT_ROOT"`, which copied the parent checkout's
`.feature/progress.json` into the worktree. That file held `epic·high·ui`
from an earlier, unrelated run, so the armed worktree reported the wrong
lane even though `.feature/intake.json` correctly held
`standard·high·backend`. `.feature/LADDER-NOTE.md` records the same class of
bug from 2026-09-02; renaming the stale file fixed one instance, and the file
was recreated since.

**What I did.** Re-ran `progress.mjs init --size standard --risk high
--surface backend` inside the worktree. The step history survived, because
`init` preserves an existing `steps` object. The intake was never wrong and
was not edited.

**Impact on the feature.** None. The ladder is reporting metadata only.

**Verdict:** ACCEPT

## D2 — my own `verification_commands` broke the gate

**What happened.** The first baseline gate went RED on
`extra-pnpm-test-worker-jobs-account-offboardin-cd840c`:
`offboarding-lifecycle.integration.test.ts:1543` expected a
`solicitation_suppressions` verification issue and instead saw
`accounts`/`businesses`/`users` each with `violationCount: 1`. The tree was
docs-only at the time, so nothing in this branch could have caused it.

**Root cause.** The three `verification_commands` I put in the intake each
spawn a separate `vitest run`, and the gate executes its `extra-*` rows in
PARALLEL. Two of those rows reach live-DB offboarding suites. Vitest's
serialized `integration` project only serializes suites WITHIN a single run,
so three concurrent vitest processes against one Postgres test database
interfere — the class `.claude/CLAUDE.md` warns about under the live-DB suite
conventions. A compounding factor: `scripts/verify-gate.sh:255` provisions the
test DB only when the diff is not docs-only, but lines 247-249 export
`TEST_DATABASE_POOL_URL` unconditionally, so the suites ran against an
unprovisioned database.

**Proof.** Run alone without the DB: 86 passed, 2 skipped. Run alone WITH
`TEST_DATABASE_POOL_URL` exported: 88/88 passed. The suite is green at HEAD;
only the parallel gate run failed it.

**What I did.** Cleared `verification_commands` to `[]` in both intake copies.
The gate's own `pnpm test` row already runs every suite with the correct
serialization, so the three commands added no coverage and actively broke the
gate. This is an intake correction, not a surface amendment, so it does not
count against the amendment budget.

**Impact on the feature.** None on behaviour. It removes a false-red source
from every future gate run on this branch.

**Verdict:** ACCEPT


## D3 — surface amendment 3 was recorded but never applied

**What happened.** `.feature/state.json` logs `surfaceAmendments: 3`, and entry
3 (2026-09-03T11:09:06Z) states that
`worker/background/pollers/health-alert/__tests__/checks.test.ts` joins
`allowed_edit_surface`. Neither intake copy contained that path. The recorded
`intakeSha256` `f8ae6bc7…` matched both copies, so the amendment was logged at
the `plan_approved` transition and the intake edit was dropped in the same
step.

**Why it matters.** `tests_to_add` title 43,
`checkFailedInboundEvents does not count stale_ignored rows`, had no legal home
file. The in-session edit-surface guard blocks the write, and
`ci:feature-surface` blocks it again at merge. Verified with the audit's own
matcher: zero entries matched the path. `*` crosses `/` in that matcher, but
no entry carries a wildcard, so
`worker/background/pollers/__tests__/ArchivalPoller.test.ts` does not cover a
sibling directory. Entry 3's stated reasoning was wrong on that point.

**What I did.** Added the one path to both intake copies, immediately after the
`ArchivalPoller.test.ts` entry. Both copies stay byte-identical
(`5a5b508c…`). Re-recorded `intakeSha256` and `planContractSha256`.

**Why this spends no review round.** Plan rounds are 3 of 3 and RISK is high,
so `contract-changed` reporting CHANGED would normally escalate. It was
escalated: the owner was asked on resume and chose to apply the logged
amendment. Nothing in the design moved. The plan's T4 section already says
this behaviour is pinned by a test rather than assumed, and no plan heading
changed. This is the application of an amendment the owner approved before the
plan locked, not a new one, so it does not consume amendment budget either.

**Impact on the feature.** None on behaviour. It makes the promised test
writable.

**Verdict:** ACCEPT

## D4 — the D8 lock's blast radius was seven suites wider than the plan said

**What happened.** The plan's T2 section named one test file for the lock,
`worker/ingress/stripe/__tests__/apply-subscription-state.test.ts`. Placing
`acquireStripeCustomerBindingLock` inside
`applyStripeSubscriptionStateInternal` puts one extra statement on the path of
EVERY Stripe subscription webhook, and seven sibling ingress suites pin exact
mock-SQL statement counts. They went red the moment T2 landed: 36 failures
across `stripe-activation-enqueue`, `stripe-audit`, `stripe-invoice-paid`,
`stripe-invoice-payment-failed`, `stripe-subscription-deleted`,
`stripe-checkout-completed` and `stripe-idempotency`. A representative failure
reads `expected length 7 but got 5` — the queue drains out of alignment, so
later statements read the wrong fixture.

None of those files was in `allowed_edit_surface`.

**How it surfaced, and a caution.** The T4 subagent reported "27 pre-existing
failures at HEAD" and had verified that honestly by stashing its own diff. The
framing still misled: HEAD already contained T2, so "pre-existing" meant
"caused by the previous tracer", not "unrelated to this branch". Measuring both
sides settled it — 36 failures without T4, 27 with it, so T4 had REDUCED them
by nine. **Never accept a subagent's baseline claim without re-deriving which
commit the baseline sits on.**

**What I did.** Surface amendment 4, owner-approved 2026-09-03, adding the
seven suites plus two files:

- `worker/ingress/__tests__/helpers/stripe-webhook-harness.ts` — the shared
  owner of the queue helpers. Fixing it there fixed most of the seven at once,
  which is why it is in the amendment rather than seven separate edits.
- `scripts/ci/static-policy-audit.ts` — one line-number re-pin. That allowlist
  is line-keyed and its own comment says it shifts whenever anything is
  inserted above an entry; T4's constants moved
  `worker/ingress/stripe/shared.ts:147` to `:280`.

Every edit queues one extra advisory-lock result at the applier boundary, or
adjusts a statement count by one. No assertion's INTENT changed.

**A second, smaller change rides along.** Owner-approved in the same exchange:
the dispatcher now closes `inbound_events` through
`markInboundEventProcessed` / `markInboundEventStaleIgnored` instead of two
inline UPDATEs. Test title 41 requires the stale-ignored helper to exist, and
without this it had zero production callers — dead code the adversarial pass
would rightly flag. The cost is that suites mocking `../shared` must name both
helpers, and assertions that pinned the closing write as SQL text now pin it at
the seam. Each such assertion carries a comment saying why it moved.

**Also owner-approved:** `processSubscriptionDeleted` now returns
`StripeSubscriptionAck` instead of `void`, and the `AsyncLocalStorage` ack
channel is deleted. My own T0 test had pinned `resolves.toBeUndefined()`, which
pinned an accident of the signature written before the reporting mechanism
existed. The test titles are unchanged.

**Impact on the feature.** None on behaviour. It corrects a plan estimate that
was wrong about scope, exactly as the earlier D8 estimate was.

**Verdict:** ACCEPT

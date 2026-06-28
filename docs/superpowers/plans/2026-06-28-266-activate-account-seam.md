# Plan — #266: Extract the "subscription became active" seam (invoice-paid + checkout-completed)

Branch: `refactor/266-activate-account-seam` · Money path · Behavior-preserving.

## TL;DR of the brainstorm finding (read before touching code)

Issue #266 was filed as a fast-follow from the PR #265 review. **Since then, PRs
#362 (trial) and #366 ("status-applier consolidation, audit PR B") already did
the bulk of #266's remedy.** Concretely, the issue's premise is now stale:

- **Part 1 — `activateAccountInTx` — ALREADY DONE.** Both handlers route their
  in-tx activation through the single applier
  `applyStripeSubscriptionState` (`worker/ingress/stripe/apply-subscription-state.ts`).
  That applier owns the entire in-tx sequence the issue wanted extracted:
  status UPDATE (`writeStatusColumns`) + `writeAccountAuditLog` + the deprecated
  `businesses` compat UPDATE (`writeBusinessesMirror`) + `enqueueStripeOverageRecompute`
  + lifecycle analytics — all inside the caller's `tx` (invariant #2).
- **The raw `INSERT INTO account_audit_log` audit inconsistency the issue wanted
  fixed "for free" — ALREADY GONE.** `checkout-completed.ts` no longer hand-rolls
  any INSERT; it routes through the applier, which uses `writeAccountAuditLog`.
  `rg "INSERT INTO account_audit_log" worker/ingress/` returns nothing in the
  stripe handlers. The locked tests already assert the `writeAccountAuditLog`
  path (`stripe-audit.test.ts`, `stripe-checkout-completed.test.ts` mock
  `writeAccountAuditLog`).
- **The subtly-different per-handler UPDATE predicates** the issue warned about
  were the OLD inline UPDATEs. They were correctly unified into the applier's
  transition table by #366. There is no longer a divergent in-tx UPDATE to
  preserve.

**Decision:** do NOT create a redundant `activateAccountInTx` wrapper around
`applyStripeSubscriptionState`. That would be a shallow pass-through (design.md:
"Reject pass-through services"; repworth.md: "Do not add abstraction layers").
The in-tx seam already has exactly one home.

## What actually remains (Part 2 — the genuine remaining duplication)

The **post-commit, best-effort backfill-resume block** is still duplicated across
**4 call sites**, each an identical null-guard + `maybeEnqueueBackfillResume(id).catch(log)`:

1. `invoice-paid.ts` recovery loop (`recovered` accounts) — resolves business id
   via its own `SELECT id FROM businesses … is_primary=TRUE AND archived_at IS NULL`.
2. `invoice-paid.ts` `convertTrialingAccount` — uses `transition.primaryBusinessId`.
3. `checkout-completed.ts` paid path — uses `businessId ?? transition.primaryBusinessId`
   (legacy Payment-Link business id preferred).
4. `checkout-completed.ts` `maybeStartTrial` — uses `knownBusinessId ?? transition.primaryBusinessId`.

The **business-id resolution differs per call site** (this is the "subtly
different predicate" for THIS layer) and MUST be preserved. So the extracted
helper takes the already-resolved business id; each call site keeps its own
resolution.

## Change set

### 1. `worker/ingress/stripe/shared.ts`
- Add `export async function resumePrimaryBusinessBackfill(businessId: string | null): Promise<void>`
  owning: null-skip + call `maybeEnqueueBackfillResume(businessId)` + best-effort
  log-and-swallow (worker best-effort rule — a resume failure must never flip an
  already-committed activation to failed).
- Make `maybeEnqueueBackfillResume` **module-private** (drop `export`): after the
  handlers route through `resumePrimaryBusinessBackfill`, it is only called
  internally, so leaving it exported would be a fallow unused-export.

### 2. `worker/ingress/stripe/invoice-paid.ts`
- Import `resumePrimaryBusinessBackfill` (drop `maybeEnqueueBackfillResume`).
- Recovery loop: keep the primary-business SELECT, replace enqueue+catch+guard
  with `await resumePrimaryBusinessBackfill(primaryBiz?.id ?? null)`.
- `convertTrialingAccount`: replace with `await resumePrimaryBusinessBackfill(transition.primaryBusinessId)`.

### 3. `worker/ingress/stripe/checkout-completed.ts`
- Import `resumePrimaryBusinessBackfill` (drop `maybeEnqueueBackfillResume`).
- Paid path: `await resumePrimaryBusinessBackfill(businessId ?? transition.primaryBusinessId)`.
- `maybeStartTrial`: `await resumePrimaryBusinessBackfill(knownBusinessId ?? transition.primaryBusinessId)`.

### 4. Tests
- `stripe/__tests__/checkout-trial.test.ts` + `stripe/__tests__/invoice-paid-trial.test.ts`:
  these mock `stripe/shared.ts`'s `maybeEnqueueBackfillResume`. The handler's
  collaborator changed → swap the mock/asserts to `resumePrimaryBusinessBackfill`.
  Behavior verified is identical (resume runs with the resolved business id when
  the applier activated; skipped otherwise).
- **No change** to the locked tests (`stripe-invoice-paid.test.ts`,
  `stripe-checkout-completed.test.ts`, `stripe-activation-enqueue.test.ts`): they
  drive the REAL `stripe/shared.ts` via the ingress harness's mockSql.
  `resumePrimaryBusinessBackfill` adds no SQL of its own (it just calls
  `maybeEnqueueBackfillResume`), so the SQL call sequence is byte-identical →
  they stay green. `stripe-audit.test.ts` untouched (audit already via
  `writeAccountAuditLog`).

## Behavior-preservation argument

- In-tx side effects: unchanged (untouched applier).
- Post-commit resume: same business-id resolution per call site, same eligibility
  SELECT + outbox INSERT (inside the unchanged `maybeEnqueueBackfillResume`), same
  best-effort log-and-swallow, same skip-on-null. Only the duplication is removed.

## Verify gate (all must pass, incl. fallow "No issues")
`pnpm lint && pnpm typecheck && pnpm test` · `pnpm ci:tenant-scope && pnpm ci:rls-audit` · `pnpm ci:fallow`

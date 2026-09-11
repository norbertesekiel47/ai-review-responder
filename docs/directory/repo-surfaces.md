## `scripts/`

Operational scripts. Run with `tsx scripts/<name>.ts`. Not part of the runtime.

| File | What it does |
|------|--------------|
| `admin-contract-delivery.ts` | Copies `docs/admin-api/` to one bot-owned branch/PR in `RepWorth/admin-app`; target-only token, no target main write. Workflow and bootstrap procedure: `docs/runbooks/admin-contract-delivery.md`. |
| `redis.ts` | Helpers for the other scripts to construct Redis clients from env vars (avoids re-implementing `getCacheRedis` outside the app). |
| `clear-signup-rate-limits.ts` | Wipes signup rate-limit keys in Redis. Used when a real owner gets stuck behind rate limits during dev / first-customer onboarding. |
| `zernio-count-reviews.ts` | One-shot diagnostic: hits Zernio `listReviews` for a given business and prints counts per page. Used during the Zernio ingestion smoke test to verify pagination + tier caps. |
| `zernio-backfill-external-replies.ts` | One-off backfill helper for the read-only Past Replies feature (migration 031). Walks Zernio reviews for a business and ingests existing owner replies as `posted` responses so they appear in the "Past Replies" tab. Requires `EXTERNAL_REPLY_IMPORT_ENABLED=true` to run (otherwise the underlying helpers no-op). Idempotent. |
| `verify-stripe-price-parity.ts` | WS8 provider verifier for all six immutable Prices: exact cents, USD, monthly recurrence, active state, and Stripe-Tax-compatible behavior. Fails on missing/duplicate configuration. |
| `ws8-stripe-cutover-preflight.ts` | Dry-run-by-default provider-wide cutover blocker. Independently paginates every Stripe subscription and open Checkout Session/line item, reconciles local projections, and optionally expires old-Price Sessions with stable idempotency. Never writes the database or cancels subscriptions. |
| `ci/rls-audit.ts` | **(Wave 1)** Reads `pg_class.relrowsecurity` and exits non-zero if any tenant-scoped table (see `ci/tenant-tables.ts`) has RLS disabled. Needs a DB URL — documented as staging-gated until `TEST_DATABASE_POOL_URL` is in CI. |
| `ci/tenant-scope-audit.ts` | **(Wave 1, rewritten #859)** Query-block-aware static audit of inline `sql\`…\`` queries in `src/` + `worker/`; proves every physical tenant-table binding — in CTE bodies, scalar/`EXISTS`/LATERAL children and set arms — on an `account_id`/`business_id`/root-id predicate the table PHYSICALLY carries (`TENANT_SCOPE_COLUMNS`), or on an identity equality to a proven, unshadowed ancestor. Runs in the blocking `lint` CI job. Backed by `ci/tenant-scope-allowlist.ts` (vetted known-good exceptions, with dead-entry + duplicate guards) and `ci/tenant-tables.ts` (the tenant-table inventory + the per-table scope-column map, asserted against `information_schema` by `ci/__tests__/tenant-tables.integration.test.ts`). |
| `ci/db-imports-audit.ts` | **(A+ campaign)** `ci:db-imports` — bans any non-composition-root file from importing `@/lib/db/server` (invariant #15). **STRICT** (PR 3, #456): no baseline — any non-root importer fails. Worker root status is **derived from `worker/index.ts` registration** via TypeScript-AST parsing (not file position); `import type` excluded (runtime-value-precise). The checked-in baseline snapshot was deleted when the importer set hit 0 (arc: 105 → 0). Unit-tested (11/11); runs in the blocking `lint` CI job. |
| `ci/lib/ratchet-harness.ts` | **(A+ campaign)** Shared file-walker + ratchet/baseline-diff engine used by the `ci:*` audit scripts (consolidated in 2i, #455) so each guard declares only its own predicate, not its own traversal. |
| `ci/process-env-audit.ts` | **(A+ campaign)** `ci:process-env` — ratchets raw `process.env` reads down toward the typed config layer (`src/lib/config/*`); baseline 10. Widened in PR 3 (#456). |
| `ci/normalize-v8-coverage.ts` | **(A+ campaign)** Normalizes the V8 coverage report so `ci:fallow --coverage` reads a stable shape (PR 3, #456). |

---

## `tests/llm-eval/` — Offline and optional live LLM safety gates

| File | What it does |
|------|--------------|
| `judge-eval-set.jsonl` | **(WS6)** Twelve deterministic judge fixtures: clean pass, compensation/PII/fabrication/hostility flags, mediocre-safe forbidden-flag cases, and adversarial near-misses. Each carries a schema-valid canned output for keyless scoring. |
| `judge-types.ts` | **(WS6)** Strict fixture, expectation, result, report, category, and live-generator types for the judge lane. |
| `judge-load.ts` | **(WS6)** JSONL loader and shape validator with duplicate-id rejection before scoring. |
| `judge-scorer.ts` | **(WS6)** Parses outputs through `JudgeOutputSchema` and scores required/forbidden verdict agreement without vacuous assertions. |
| `jsonl.ts` | Shared line-aware JSONL parser used by both offline eval lanes; rejects malformed JSON without duplicating fixture-domain validation. |
| `run.ts` | Main `pnpm eval:llm` runner. **WS6** always runs the offline judge lane and, under `--live`, reports live judge agreement alongside the existing suites. |
| `live-runner.ts` | Optional provider-backed runner. **WS6** invokes `runLlmTask('judge')` per fixture through the explicitly documented eval-only cost-guard exception; production callers remain guarded. |

### WS6 contract-test inventory

| Area | Test modules |
|------|--------------|
| Flags/startup | `worker/config/__tests__/startup-assertion.test.ts`, `src/lib/responses/__tests__/judge-flags.test.ts`, and the WS6 cases in `src/lib/auto-approval/__tests__/flags.test.ts` / `src/lib/config/__tests__/worker.test.ts`. |
| Judge domain | `src/lib/responses/__tests__/{judge-health,judge-policy,judge-schema,judge-store,judge-store.integration,judge}.test.ts` plus the judge block in `model-pinning.test.ts`. |
| Governor/suspension | `src/lib/auto-approval/__tests__/{account-lock-order,governor,suspension,suspension.integration}.test.ts` plus the governor cases in `flags.test.ts`. |
| Migration/shared contracts | `src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts`; WS6 cases in `job-outbox-helpers.test.ts`, `outbox.test.ts`, and `past-due-recovery.test.ts`. |
| Judge worker/publisher | `worker/jobs/judge/__tests__/{JudgeWorker,failed-hook,lock-order-source}.test.ts`; `worker/jobs/publisher/__tests__/{judge-gate,auto-policy-downgrade,auto-policy-downgrade-lock-order}.test.ts` + the live-DB `auto-policy-downgrade.integration.test.ts` (the `auto_post_revoked` **Refusal**: `occurred_at` equality, the rollback pair and the partial index, none of which a mocked `sql` can carry); WS6 cases in `ResponsePublisherWorker.test.ts`. |
| Governor loops | `worker/background/pollers/__tests__/JudgeSweepPoller.test.ts` and `worker/background/schedulers/__tests__/{AutonomyGovernorScheduler,AutonomyGovernorScheduler.integration}.test.ts`. |
| Suspension notices/admin alert | `worker/jobs/autonomy-suspended-notice/__tests__/{AutonomySuspendedNoticeWorker,context,dispatch}.test.ts`, `worker/jobs/__tests__/AutonomyAdminAlertWorker.test.ts`, `src/lib/notifications/email/templates/__tests__/autonomy-suspended-notice.test.ts`, WS6 cases in `src/lib/notifications/__tests__/delivery.test.ts` and `src/lib/notifications/channels/__tests__/{email-channel,factory,telegram-body,telegram-channel,whatsapp-body,whatsapp-channel}.test.ts`, plus `worker/ingress/__tests__/resend-webhook-bounce.test.ts`. |
| Admin recovery API | `src/app/api/admin/autonomy/__tests__/routes.test.ts`. |
| Eval lane | `tests/llm-eval/__tests__/judge-eval.test.ts` plus WS6 live-judge coverage in `live-runner.test.ts`. |

---

## `supabase/migrations/`

All schema migrations live here, numbered `001` … `098` (repository/local-test
head — `098_solicitation_suppression_corrections.sql`, the #645 **Correction
path** audit sink: one immutable row per admin-removed suppression, written by
the same statement as the DELETE, RLS deny-all with zero policies, and **no
foreign keys** — `suppression_id`'s referent is gone by design. It **does**
snapshot the corrected row's `normalized_handle`, `account_id`,
`created_by_user_id` and `note` (D-A11) — the evidence the removed assertion was
legitimate — so it is account-linked and therefore **classified rather than
renamed to evade classification**: `retain_compliance_limited_pii` /
`allowed_limited_retention` in `table-disposition.ts`, the disposition its
siblings `solicitation_suppressions` and `solicitation_unsubscribe_tokens`
already carry; next is `099`). Supabase staging/production migrations remain a user-run
promotion step. WS8 uses `077_copilot_autopilot_expand.sql` only after provider
preflight reaches zero while traffic is quiesced, then deploys strict code and
smokes before `078_copilot_autopilot_contract.sql` installs the NULL-safe strict
two-tier checks. The only executable rollout is
`docs/runbooks/ws8-tier-cutover.md`; the full per-migration narrative and
deployment status remain in `.claude/reference/migrations-log.md`.

---

## Other top-level surfaces (not detailed here)

- `.claude/CLAUDE.md` — always-loaded project facts + the canonical architecture-invariants list + working rules + gotchas + a "where things live" index. Source of truth for architecture. (The former `.claude/rules/` files were retired 2026-08-03: the generic book distillations deleted, `repworth.md`'s unique contracts folded into CLAUDE.md's "Working rules".)
- `.claude/skills/` — patterns to follow, invoked on demand (cost-guard, approval-security, outbox-pattern, onboarding-demo-cost-guard).
- `.claude/reference/` — recall-when-needed inventories, read on demand (env-vars, migrations-log, lab-notes, review-ingestion).
- `docs/runbooks/` — operational + deployment runbooks, including
  `ws8-tier-cutover.md` as the single quiesced Stripe → 077 → strict code → 078
  tier rollout path, and `mfa-factor-reset.md` as the break-glass procedure for
  a user who has lost their authenticator (operator-side factor removal via
  the Supabase Admin Auth API).
- `docs/security/` — **(Wave 1)** RLS inventory, tenant-isolation model, vendor-risk + access registers, CSP rollout plan.
- `docs/finance/` — **(Wave 1)** pilot invoice-review template for the first multi-location accounts (`accounts.flags.is_pilot`).
- `docs/legal/` — legal source docs + external-gate status (`legal-review.md`, `insurance.md`); rendered pages come from `src/lib/legal/content.ts`, not these.
- `public/.well-known/security.txt` — **(Wave 1)** RFC 9116 disclosure pointer (contact `security@repworth.net`, links to `/security`).
- `src/app/fonts/` — the seven self-hosted `.woff2` files (six families; Fraunces has a second file for italic), loaded by `next/font/local` from `src/app/layout.tsx` and `src/app/(authenticated)/layout.tsx`. NOT a general asset dump — `next/font/google` is banned by `ci:static-policy` because Turbopack resolves it with a compile-time CDN fetch whose intermittent failure broke E2E and Vercel builds on unrelated commits. Provenance, the latin-only coverage limitation, and the refresh procedure are in `src/app/fonts/README.md`.
- `docs/superpowers/` — historical specs + plans for every feature, dated. The plan file at the head of each branch is the spec of record for that feature.
- `tests/` and per-module `__tests__/` directories — Vitest unit + integration tests; the WS6 LLM-eval lane and contract-test inventory are detailed above, and Playwright E2E lives in `tests/e2e/`.

---

_Index: [`docs/directory.md`](../directory.md)_

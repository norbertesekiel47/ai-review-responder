# Plan review round 1 — triage verdicts (#656)

Full report: `plan-review-round1-codex.md`. Verdict: **REVISE**.
Reviewer: `codex exec`, read-only sandbox. Round 1 of max 3 (`planReviewRounds=1`).
First dispatch timed out at the harness wall with no verdict (codex thread
`019fcb03-6c76-7310-8829-fa7d80dd8b7e`); this is the relaunched run.

## Plan-level findings

| # | Sev | Verdict | Note |
|---|---|---|---|
| 1 | Critical | **ACCEPT** | Verified: locked intake carries three `migration 098 …` titles; the plan authors `099`. `promised-tests` matches verbatim, so the gate could never go green. My renumber (D1) changed the migration and the globs but missed the test titles. |
| 2 | Critical | **ACCEPT** | Verified: `.feature/intake.json` does NOT contain `worker/jobs/solicitation-batch/index.ts`. D4's amendment was written to the committed copy only; I never re-ran `feature-setup.sh` after it. The guard would have blocked the edit at execution time. Also real: `src/lib/shared/__tests__/**` and `worker/jobs/solicitation-batch/__tests__/**` are required and absent from the surface. |
| 3 | Critical | **ACCEPT** | The all-or-nothing CHECK enforces tuple *completeness*, not that the attestation covers the *current bytes*. An address-only `UPDATE` on an attested row keeps all four columns non-NULL and passes. That is precisely the stale-attestation defect this feature exists to prevent, and `attestPostalAddress` being well-behaved does not constrain any other writer. **Fix:** add `solicitation_postal_address_attested_digest` to the tuple with a CHECK that it equals `encode(sha256(convert_to(solicitation_postal_address,'UTF8')),'hex')`. Schema-level, no trigger, and an address-only UPDATE then fails closed. |
| 4 | High | **ACCEPT** | The §7.6.1 / §2.4 override was agreed with the owner and recorded on ticket #656 and map #617 — but **not** in `docs/superpowers/specs/`. A reader of the locked spec still gets "no batch produced". This is the #643 lesson (a decision that lives only outside the spec directory). Fix: add a binding entry to `2026-07-28-send-mode-cross-spec-amendments.md`. Requires a surface addition. |
| 5 | High | **ACCEPT** | Verified: `competitors/route.ts` uses `requireSettingsOwner` + `withSameOrigin` + an explicit `businessId`, not the `requireRoleOr401` / `user.locationId` / `assertWritableSubscriptionForAccount` trio I cited from `/api/settings/route.ts`. Worse, `requireOwnerAccess` returns **`currentLocationId`** (cookie-resolved scope), not `businessId` — the plan as written could show one location and write another. Task 4 and Task 5 both need rewriting against the real helper. |
| 6 | High | **ACCEPT** | No FK on `_attested_by_user_id` preserves history, but nothing stops the writer stamping an arbitrary or cross-tenant UUID as legal provenance. Validate actor membership inside the same scoped UPDATE; keep the column FK-free. |
| 7 | High | **ACCEPT** | `it.todo` satisfies the `promised-tests` row, so the gate can go green with the feature absent. Add codex test #1 (zero pending at final verification) and a closing task running `verify-gate.sh --review`. |
| 8 | High | **ACCEPT** | Task 6 necessarily breaks the existing exact-log fixture in `worker/jobs/solicitation-batch/__tests__/index.test.ts` and the batch-builder unit fixtures. Both must be in the task and the surface. |
| 9 | Medium | **ACCEPT** | Add a `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS` schema requirement and assert it in every affected live-DB suite. |
| 10 | Medium | **ACCEPT** | Add a blocking pre-T2 check that 098 and its migrations-log entry exist before T2 records head 099. |
| 11 | Low | **ACCEPT** | Dependency graph wrongly routes T7/T8 through T3 (their headers correctly say T2). Prose says "only two new test files" while the table lists five. Both are my errors. |

## Cited-artifact check — my errors it caught

All ACCEPTED; each is a real miscitation in the plan:

- Task 6 says "read deviations **D2**" for the watch-mode decision. D2 is the tenant-scope allowlist entry. **The watch-mode/send-handoff decision is not in the deviations file at all** — it lives on ticket #656 and map #617. Cite those, or add it as a deviation.
- Task 7's "alongside the existing `google_place_address` assertion" — **no such assertion exists** in the offboarding suite.
- Task 1 Step 6's "existing suite's flag-stubbing helper" — **does not exist**; the suite mutates `process.env` directly.
- `acquireLiveDbLock` is exported from `helpers/live-db-lock.ts`, **not** `schema-ready.ts` as the plan's live-DB note implies.

## Rejected

| Finding | Verdict | Reason |
|---|---|---|
| "`subagent-driven-development` / `executing-plans` skills do not exist" | **REJECT** | They exist as user-level skills in the active catalog; codex only searched the repository. No plan change. |

## Missing failing tests (32)

**ACCEPT in bulk** — they are the substance of the revision. Highest-value, grouped:

- **Bind attestation to bytes** (#3, #4, #5, #6): address-only UPDATE rejected; one scoped UPDATE; failed re-attestation preserves the prior tuple; re-attestation records the *new* actor.
- **Tenant isolation on every new path** (#7, #11, #12, #13, #25): cross-account actor refused; the **cookie-resolved active location** is the one written; read model returns null cross-account; the builder's widened SELECT keeps both predicates; purge never crosses tenants.
- **The withhold must actually withhold** (#27, #28, #29, #30, #31): zero `generate_solicitation_asks` outbox rows; per-candidate counts byte-identical (not merely "no new key" — it could leak into `no_consent`); `not_applicable` when the flag is off (all five planned cases turn it on, so watch-only behaviour was untested); first-match precedence; enqueue failure rolls back the build.
- **Compliance-copy integrity** (#16, #17, #21): checkbox label equals `POSTAL_ADDRESS_ATTESTATION_TEXT` verbatim; the Google prefill is never persisted without explicit attestation; an unknown attestation version is refused.
- **Route hardening** (#18, #19, #20): unauthenticated/non-owner, cross-origin, and non-writable-subscription callers all refused with zero writes.
- **Lint sharpness** (#22, #23): two *non-empty* lines; a five-digit street number is not a ZIP.
- **Gate integrity** (#1) and **observability** (#32).

## Consequence for the surface — owner decision required

Fixing findings 2, 4, 8 and 9 requires adding to `allowed_edit_surface`:
`src/lib/shared/__tests__/**`, `worker/jobs/solicitation-batch/__tests__/**`,
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` — plus
re-arming with the worker source file D4 never delivered to the locked copy.

Under step 5's abort criteria that is **surface amendment #2**, which fires the
abort trigger. See the session's owner question and its resolution; the outcome
is recorded in the deviations file.

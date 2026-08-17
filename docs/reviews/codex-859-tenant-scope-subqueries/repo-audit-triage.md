# #859 repository tenant-scope audit triage

## Fixed point and method

- Base: `2aa9c4fe` (`origin/main` when the feature worktrees were created).
- Before: the flattened scanner passed with 397 exact allowlist entries.
- Audit method: run the query-block analyzer once with exact exceptions applied (`pnpm ci:tenant-scope`) and once with them disabled (`pnpm exec tsx scripts/ci/tenant-scope-audit.ts --no-allowlist`). The disabled run intentionally exits non-zero and identifies every unproven physical binding by template occurrence, statement, set arm, block, table, alias, and binding ordinal.
- Triage rule: fix parser false positives; retain/add an exact categorized entry only for a legitimate global/pre-auth/admin flow; stop for an approved runtime edit if a genuine tenant leak appears.

## Outcome

The first applied-allowlist run under the new parser exposed one occurrence and no runtime tenant leak:

| Identity | Disposition |
| --- | --- |
| `template:a10c4aa3180b646b:occurrence:1:statement:1:arm:1:block:root:table:api_costs:alias:ac:binding:1` in `src/lib/admin/cost-report-service.ts` | Legitimate global admin query. Its account predicate is an optional composed fragment; when absent the Costs page and API intentionally aggregate all accounts, after `requireAdminPage` / `requireRole('admin')`. Added the same exact `admin-after-require-role` exception already carried by the query's `accounts` and `businesses` bindings. |

No repeatable parser defect or genuine tenant leak was suppressed. The final applied run passes at 381 entries: the one honest admin exception above was added and 17 obsolete parser-limitation exceptions below were removed (net 397 → 381). The final disabled run reports 342 unproven physical bindings. Those remaining bindings include intentionally exempted global, provider-ingress, pre-auth-token, admin, and durable-job flows, plus safe statements at conservative proof boundaries the analyzer deliberately declines to infer: fail-closed `OR`, unqualified correlated tenant columns, sibling-only correlation, and non-tenant ownership bridges. Each remains pinned by an exact, rationale-bearing allowlist entry; disabling exceptions is evidence collection, not a green-gate mode.

## Obsolete limitation entries removed

For every row below, auditing its exact snippet with `{ applyAllowlist: false }` now produces no finding for the named table. The exact file/table/normalized-snippet allowlist key is therefore the removal identity; a missing-scope `sqlIdentity` cannot exist for a binding the analyzer proves scoped.

| File | Table | Newly visible proof |
| --- | --- | --- |
| `src/lib/accounts/tier-change.ts` | `account_offboardings` | account identity correlation through LATERAL |
| `src/lib/admin/cost-report-service.ts` | `businesses` | bound account predicate in the standalone `businessIdInAccount` fragment |
| `src/lib/dashboard/service.ts` | `responses` | bound business predicate inside both reputation-rate EXISTS blocks |
| `src/lib/dashboard/service.ts` | `reviews` (reputation trend) | bound business predicate in a LEFT JOIN child |
| `worker/jobs/response-generation/analytics.ts` | `responses` | bound account predicate in EXISTS |
| `worker/jobs/response-generation/analytics.ts` | `businesses` | bound account predicate in EXISTS |
| `src/lib/dashboard/service.ts` | `review_escalations` | business correlation through LATERAL |
| `src/lib/dashboard/aggregate-service.ts` | `review_escalations` | business correlation to an account-scoped ancestor through LATERAL |
| `src/lib/dashboard/service.ts` | `reviews` (velocity) | bound business predicate in a LEFT JOIN child |
| `worker/jobs/publisher/auto-policy-publish.ts` | `auto_approval_policies` | bound account predicate is an AND term; the location override OR cannot broaden it |
| `src/lib/competitors/named-rival.ts` | `businesses` | bound business root in the `ctx` CTE |
| `src/lib/competitors/named-rival.ts` | `ranking_snapshots` | bound business predicate in the `dates` CTE |
| `src/lib/account-offboarding/confirm.ts` | `account_audit_log` | bound account predicate in the idempotency EXISTS |
| `src/lib/account-offboarding/keep-my-data.ts` | `account_audit_log` | bound account predicate in the idempotency EXISTS |
| `worker/jobs/account-offboarding/purge-helpers.ts` | `businesses` | bound account predicate in the IN child |
| `worker/jobs/account-offboarding/purge-stages.ts` | `businesses` (notification purge) | bound account predicate in the IN child |
| `worker/jobs/account-offboarding/purge-stages.ts` | `businesses` (analytics scrub) | bound account predicate in the IN child; the separate outer OR does not broaden the child proof |

Sixty-six other exact entries also happen to be statically provable, but their reasons describe contextual trust boundaries rather than the retired subquery limitation. They were deliberately left alone: #859 removes obsolete parser workarounds, not every historical exception whose current SQL is independently scoped.

## #629 SQL restoration

- `approval.ts` again resolves the Send parent in a correlated scalar subquery and expresses readiness as `NOT EXISTS`; both child bindings carry tenant proof and the batch → run lock order is unchanged.
- `batch-view.ts` again reads its two send-lane counts as independent scalar aggregates. The shape test forbids child-table joins, `COUNT(DISTINCT ...)`, and `GROUP BY`, so the rejected child-table cross product cannot return.
- UUID canonicalization remains at the approval boundary and in `closeBatchIfSettled`; no query cleanup weakened the mixed-case defense.

## Verification evidence

- Query-block parser suite: 111 tests green (107 at first review, plus the four review-round regressions below), including every intake-promised adversarial case plus comma bindings, explicit-schema CTE shadowing, ordered CTE visibility, quoted identifiers, local-alias shadowing, hierarchical set-arm identities, same-level `OR`, outer-join directionality, parenthesized joined-table groups, complete-conjunct proof, conservative unsafe-literal resolution across block, function, generator, static-block, and control-flow scopes, shared UTF-16-stable JavaScript/SQL lexical extraction with token-aware regex detection and runtime-cooked static literals, PostgreSQL `TABLE` expressions, table-function modifiers, and mixed-extractor source ordering.
- Applied allowlist: `pnpm ci:tenant-scope` green — also green against `main` at `0101522a` (#866 rewrote `unsubscribe.ts` SQL after this branch's base), so the rebase does not move the baseline.
- Branch review round (2026-08-17): two analyzer false negatives found by adversarial fixtures and closed before merge — (a) unqualified proof on a column the table lacks inside a child block (`reviews`/`responses` via `account_id`, `auto_approval_policies` via `business_id`; PostgreSQL resolves the column outward, `EXPLAIN` shows a filterless `Seq Scan`), fixed by the schema-asserted `TENANT_SCOPE_COLUMNS` map; (b) a grandchild inheriting a root alias that an intermediate block re-binds, fixed by passing only unshadowed ancestors down. Neither fix changed a repository finding: the applied gate stays at 381 and the disabled run at 342. A third, cosmetic fix stops plain literals nested in a `${…}` placeholder from being extracted as SQL under the enclosing tag (repo template count 1,115 → 1,106; every dropped one was a bind-parameter string).
- Schema conformance: `scripts/ci/__tests__/tenant-tables.integration.test.ts` asserts `TENANT_SCOPE_COLUMNS` against `information_schema` at migration head (43/43 tables).
- Disabled allowlist: 342 identity-bearing findings, expected non-zero.
- Approval behavior: 3 existing unit behavior cases plus 1 approved SQL-shape unit case, and 19 live-database integration cases, are green.
- Batch-view behavior: 18 unit cases green during the tracer; live-database coverage is rerun by the feature verified gate with the repository test database environment.

# ADR 0028 — The Admin API contract: generated from code, gated by CI, pushed to the Admin app

## Status

Accepted — 2026-09-07. Resolves decision ticket
[#1164](https://github.com/RepWorth/ai-review-responder/issues/1164) on wayfinder
map [#1159](https://github.com/RepWorth/ai-review-responder/issues/1159).

## Context

The **Admin app** is built by a developer with no read access to this repo
(ADR 0024 D1). They cannot read a route to learn its shape. So the **Admin API**'s
request and response shapes must leave this repo as an artifact, and a change to
one must fail CI here before it ships.

The inventory at 2026-09-07:

- **35 route files** under `src/app/api/admin/**`, serving 24 distinct paths that
  40 client `fetch` sites call.
- **14 of the 35 declare a zod schema.** The other 21 — mostly GETs, plus the
  hand-parsed multipart on `locations/csv-import` — have no request schema at all.
- **Response DTOs already exist as TypeScript.** About 40 exported interfaces
  across 15 `src/lib/admin/*.ts` files (`OverviewData`, `AdminFlaggedData`,
  `AdminJobsData`, `AdminOffboardingsList`, `MarginData`, …). They are types, not
  schemas.
- `zod` is `^4.4.3`, so `z.toJSONSchema()` is built in. **No new dependency is
  needed for any option below**, which removes the near-duplicate-dependency
  objection from the choice.
- **Error bodies are prose.** 37 distinct `{ error: … }` string literals across
  admin routes. About ten are machine codes (`invalid_body`, `not_suspended`,
  `not_tripped`, `feature_disabled`, `not_found`, `invalid_business_id`,
  `invalid_offboarding_id`, `invalid_impersonation_session`,
  `impersonated_user_not_found`, `account_offboarding_blocked`). The rest are
  English sentences: `'Failed to fetch overview'`, `'Business not found'`,
  `'Too many demo generations. Try again in a minute.'`.
  **`errorResponse(code, status)` is used in ZERO admin routes** — it is the
  owner/dashboard helper (`src/lib/auth/route-helpers.ts:52`). `src/proxy.ts`
  branch 4 adds three more bodies of its own: `{error:'Unauthorized'}` 401,
  `{error:'Forbidden'}` 403, and `{error:<aal gate value>}` 403.

That last fact is why the ticket's item 5 — "enumerate the codes" — could not be
done as written. There is no code vocabulary to enumerate.

## Decisions

### D1 — the contract is GENERATED from the code that already exists

Three artifacts under `docs/admin-api/`, all generated, all committed:

1. **`admin-api.d.ts`** — emitted by `tsc --emitDeclarationOnly` from a barrel
   (`src/lib/admin/api-contract.ts`) that re-exports every response DTO the Admin
   API returns. The barrel is an index, not an abstraction: it adds no type and
   wraps no call. It lives under `src/lib/admin/` — not under `scripts/` — so that
   `ci:directory-map` forces a row for it and a route author adding a DTO sees the
   contract surface rather than a CI script.
2. **`schemas/<route>.json`** — `z.toJSONSchema()` output for each of the 14 routes
   that already declare a request schema. The 21 without one are listed in the
   route table as *no request body* or *hand-parsed*, truthfully, rather than given
   a schema invented for the document.
3. **`README.md`** — one row per route: path, methods, gate function, request
   schema file (or its absence), response type name, and status codes.

Nothing here is written twice. Every value is derived from a route file, a zod
schema, or an exported interface that already exists.

**Full OpenAPI from zod is rejected.** It needs a response schema per route written
by hand in zod, which creates a second source of truth beside the interfaces the
services already return — and the two would drift in opposite directions. It also
needs a request schema written for the 21 routes that have none, before it can
describe a single one of them. That is the real cost the ticket named, and the
inventory sets it at 45 hand-written schemas.

**A hand-maintained markdown plus a hand-written `.d.ts` is rejected.** It drifts
the first time a service return type changes and the doc does not, which is the
exact failure the snapshot check exists to catch.

### D2 — `ci:admin-contract` regenerates and diffs

`scripts/ci/admin-contract-audit.ts` regenerates the three artifacts into a
temporary directory and compares them byte for byte against the committed copies.
A difference is a FAIL, with the diff in the log. The remedy is to commit the
regenerated files in the same PR.

This is the `ci:directory-map` posture, not a new one: a generated artifact whose
staleness is a CI failure rather than a nightly job's problem.

Two completeness checks ride the same audit, because the diff alone cannot see
them:

- **Every route file is in the table.** The audit enumerates
  `src/app/api/admin/**/route.ts` and its exported HTTP methods. A path with no row
  fails. A row whose file is gone fails.
- **Every route's gate is named.** The gate column is derived by the same
  provenance rule `scripts/ci/admin-aal2-audit.ts` applies — a credited gate is a
  CALL to `requireAdminWithAal2` or `requireAdminJson`, or a value binding of
  `resolveAdminActor`, each imported from the canonical module. The implementation
  reuses that audit's resolver rather than writing a second one; two readers of the
  same gate shape can disagree, and a disagreement here understates a route's
  posture in a document a stranger codes against.

The audit is wired into the `lint` CI job and mirrored in `lefthook.yml`, like
every other `ci:*` script, and `src/__tests__/ci-audit-wiring.test.ts` keeps the
three lists from drifting.

**What the diff does and does not prove.** It proves the artifact matches the code.
It does **not** classify a change as breaking or non-breaking — a removed field and
a widened optional both appear as a diff, and a human reads it in the PR. That is
the honest limit, and it is enough: the failure mode being closed is a shape
changing with nobody noticing, not a reviewer misjudging a diff they can see.

### D3 — the contract lives here and CI pushes a copy

`docs/admin-api/` is the source of truth in this repo. A GitHub Action on merge to
`main` opens or updates a pull request in the Admin app repo carrying the same
files.

This is the **Console visual system** export precedent (ADR 0024 D8, executed by
hand once in #1167) with the manual step automated. It keeps one owner, which is
D8's actual reasoning — the objection to `@repworth/console` was two publishing
surfaces, not the copying.

**A third `admin-api-contract` repo is rejected**: a third repository to permission,
a third CI setup, and a second place a change must land before the developer can
see it.

**A hand copy is rejected**: it relies on a human noticing that a shape changed,
which is the failure `ci:admin-contract` exists to remove. Automating the audit and
then leaving the delivery manual moves the gap rather than closing it.

### D4 — no versioning

Dual mode serves both callers on the same paths (ADR 0024 D4). There is one
consumer of the Admin API that is not in this repo, and it deploys independently
but not on a schedule anyone must coordinate with. A version header would be a
mechanism with no case to answer yet.

Revisit at the first genuinely breaking change that the Admin app cannot take in
the same week.

### D5 — the error contract promises status codes and an envelope, not codes

The contract states, per route, the HTTP status codes it returns, and states once
that every error body is `{ error: string }` where **the string is a human message,
not a machine code**. The Admin app branches on status and displays the string,
which is exactly what the legacy client does today.

The three `src/proxy.ts` branch-4 bodies are part of the contract and are
enumerated by hand in the README, because they come from the proxy and not from any
route file: `401 {error:'Unauthorized'}`, `403 {error:'Forbidden'}`, and
`403 {error:<aal gate value>}`. ADR 0025 D3's refusal vocabulary
(`mfa_required`, `mfa_check_failed`) is named there too.

**Normalizing all 37 strings to codes first is rejected as a blocker.** It is a
sweep across ~35 admin routes replacing every prose string with an
`errorResponse(code, status)` call — RISK high, touching every route on the
surface — and it would sit in front of the contract the developer needs now. It is
a real improvement and it becomes its own ticket, outside this map.

**Enumerating only the ten existing codes is rejected**: the document would then be
half-typed, and a reader could not tell from a row whether a body carries a code or
a sentence without opening the route.

## Consequences

- One new `ci:*` script, one new generated doc directory, one new barrel file with
  a `docs/directory/` row.
- The contract ticket is **blocked by #1184**: the gate fold changes the gate column
  for nine routes, and a contract generated before it documents a posture that is
  about to change.
- D1 of ADR 0027 adds a `batchSummary` key to `GET /api/admin/businesses/[id]`.
  Either it lands before the first generation, or the first regeneration carries it.
- The Admin app developer reads `{ error: string }` as display text. If a future
  ticket normalizes admin errors to codes, that IS a contract change and the
  snapshot will say so.
- `src/proxy.ts`'s error bodies are now contract. #1185 changes branch 4's behavior
  for a bearer; that PR updates the README rows in the same change.

## Alternatives rejected

- **OpenAPI generated from zod** — 45 hand-written schemas, and a second source of
  truth for response shapes (D1).
- **A hand-maintained contract** — drifts silently (D1).
- **A private `@repworth/admin-api-types` package** — ADR 0024 D8 rejected the same
  shape for the design system, and the reasoning transfers: a publish step, a
  version to bump, and a second surface to keep in sync, in exchange for an import
  the copy already provides.
- **A third contract repo** — a third thing to permission and sync (D3).
- **Normalizing 37 error strings to codes as a prerequisite** — a high-risk sweep
  across every admin route in front of a document the developer needs now (D5).

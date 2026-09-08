# ADR 0027 — The Admin API read gaps: two, not five

## Status

Accepted — 2026-09-07. Resolves decision ticket
[#1163](https://github.com/RepWorth/ai-review-responder/issues/1163) on wayfinder
map [#1159](https://github.com/RepWorth/ai-review-responder/issues/1159).

Amends **ADR 0024 D5**: the survivor list of the **Legacy admin portal** does not
grow. `/admin/security` and `/admin/runbook` move to the **Admin app**.

Terms: `docs/context/core-accounts-channels-admin.md` → **Legacy admin portal** (D3 keeps its survivor list unchanged).

## Context

Every page under `src/app/admin/**` is a server component that reads the database
directly (`src/lib/auth/page-gate.ts:41`). The **Admin app** cannot do that. It
holds the Supabase anon key, never a database URL, and reaches data only through
the **Admin API**. So every server read a page performs must have a GET route
before that page can move.

The map's inventory named six pages with no GET route. **Four of the six read
nothing.** In `/admin/suppressions`, `/admin/security`, `/admin/runbook` and
`/admin/locations/csv-import`, the `sql` import is only the first argument to
`requireAdminPage` — the page gate, which is invariant #15's explicit-client rule,
not a data read. Those pages fetch no rows.

| Page | Server read | Client calls |
|---|---|---|
| `/admin/suppressions` | none | `POST suppressions/lookup`, `POST suppressions`, `POST suppressions/correct` — all exist |
| `/admin/security` | none | none — `useMfaEnrollment` talks to Supabase directly |
| `/admin/runbook` | none | none — 261 lines of static JSX |
| `/admin/locations/csv-import` | none | `GET businesses`, `POST locations/csv-import` — both exist |
| `/admin/businesses/[id]` | `readAdminBatchSummary` | gap |
| `/admin/businesses/new` | `betaCompCouponId() !== null` | gap |

Two further facts bind the decisions below.

**The pool is three connections.** `src/lib/db/server.ts:62` records that Vercel
sets `DB_POOL_MAX=3` per serverless instance. `businesses/[id]/page.tsx:37-44`
carries an imperative comment forbidding a `Promise.all` there: racing
`getBusinessDetail` (itself a 13-query chain) against the channel read put two
chains in flight against that pool, which is the #773 fan-out. Once the Admin app
fetches, every additional GET route it calls for one screen re-creates that
fan-out at the HTTP layer, where `ci:pool-fanout` cannot see it.

**The Beta comp coupon id already never leaves the server.**
`businesses/new/page.tsx:21` computes `betaCompCouponId() !== null` and passes only
that boolean to the client. The POST reads the id from the durable
`accounts.checkout_attempt_*` snapshot, never a live env read
(`.claude/rules/admin-portal.md` § Traps (a)). The ticket asked whether the Admin
app receives the id; it does not, and it never did. The only open question was how
it learns the boolean.

## Decisions

### D1 — `readAdminBatchSummary` folds onto `GET /api/admin/businesses/[id]`

The route calls `getBusinessDetail` and then `readAdminBatchSummary`,
**sequentially**, and returns both under one response object. It gains no logic:
it is a composition root calling two service functions and returning their
results, which is invariant #12.

The alternative — a new `GET /api/admin/solicitation/batch?businessId=` beside the
existing halt POST — is rejected on the pool. `/admin/businesses/[id]` already
loses one chain to a parallel HTTP fetch, because
`GET /api/admin/businesses/[id]/channels` has two other consumers
(`AdminEnrollmentWidget.tsx:51`, `useBusinessDetail.ts:115`) and stays standalone.
Two concurrent requests against a three-connection pool is the ceiling this screen
gets. A third is the defect the page comment was written to prevent, moved to a
layer that has no audit.

**Channels stays a separate route.** It has consumers that are not this page, and
folding it would give one DTO two owners.

### D2 — a new `GET /api/admin/businesses/options` carries the Beta comp boolean

It returns `{ betaCompActive: boolean }` and nothing else. It is gated with
`requireAdminWithAal2` — one of the three shapes `ci:admin-aal2` credits, and the
same gate as the `POST /api/admin/businesses` it precedes. Its sibling page
`/admin/businesses/new` already passes `{ aal2: true }`
(`businesses/new/page.tsx:15`), so the PAGES contract
(`scripts/ci/admin-aal2-audit.ts:627-645`) holds from the first commit, with no
page change.

The name is `options`, not `beta-comp`, so a second server-authoritative form
input lands as a key rather than a second route. That is the one abstraction this
ADR permits ahead of a caller, and it is permitted because the alternative is a
route per boolean.

Folding the boolean onto `GET /api/admin/nav-counts` is rejected: nav-counts is
the sidebar's route, and a Businesses-form input on it gives the response two
owners. Rendering the control unconditionally and letting the POST decide is
rejected because it reproduces the exact failure X10 removed — the admin learns
the coupon is unarmed only after filling the form.

### D3 — `/admin/security` and `/admin/runbook` move; the survivor list does not grow

Neither needs a GET route, so neither is blocked by anything in this ADR.

`/admin/security` is the MFA enrollment surface. It renders `AdminSecurityClient`,
which calls `useMfaEnrollment` against Supabase Auth directly and touches no API
route. The **Admin app** already runs its own MFA challenge (ADR 0024 D3) with the
same Supabase project, and a factor enrolled there is on the same `auth.users`
row. So `/mfa/challenge` on the **Legacy admin portal** keeps working for the
surviving impersonation flow after the legacy page is deleted. Enrollment belongs
where the admin signs in.

`/admin/runbook` is static content — a `Scenario[]` literal rendered as JSX, with
`NEXT_PUBLIC_DOCS_BASE_URL` turning doc filenames into links. It moves verbatim.
The env var moves with it and is registered in the Admin app's own inventory, not
here.

**This is an amendment, not an addition.** ADR 0024 D5's survivor list stays
exactly: `/admin/impersonate/**`, `/admin/login`, `/admin/forgot-password`,
`/admin/reset-password`, `/mfa/challenge`, `src/app/admin/layout.tsx`. #1163 asked
whether two operator pages should join it. They do not.

### D4 — no other page needs a route

The four no-read pages move with their client components and the routes those
components already call. `/admin/suppressions` keeps its unconditional AAL2
posture on the Admin app side, matching the `requireAdminWithAal2` on the three
routes it calls — the page-gate comment at `suppressions/page.tsx:20-22` states
that parity, and it survives the move as a property of the Admin app's own gate.

## Consequences

- The Admin API read-gap work is one `/feature` run: one response-shape change and
  one small route. It has no blocking edge on the gate tickets — the fold inherits
  whatever gate `GET /api/admin/businesses/[id]` carries, and #1184 moves that
  route to `requireAdminWithAal2` on its own schedule.
- `GET /api/admin/businesses/[id]`'s response grows a `batchSummary` key. It is a
  **breaking change to a shape the Admin app consumes**, so it must land before
  the contract snapshot of ADR 0028 is generated, or be carried through it.
- The retirement page list (#1169) gains two entries that need no API work and can
  move first: `/admin/security` and `/admin/runbook`.
- `readAdminBatchSummary` gets a second call site. Its deliberate ordering contract
  — live-send predicate, then `built_at IS NOT NULL`, then recency — is unchanged
  and must not be re-derived at the route.

## Alternatives rejected

- **A GET route per page in the table.** Five routes, three of which would return
  nothing, written to satisfy a table that misread a page-gate argument as a data
  read.
- **`GET /api/admin/solicitation/batch` as a sibling of the halt POST.** Cleaner
  path family, rejected on the three-connection pool (D1).
- **Keeping `/admin/security` on the legacy portal.** The argument was that the
  legacy portal's own admins must enroll somewhere. They do not need a second
  surface: the factor is on the shared Supabase user, so enrolling in the Admin
  app satisfies `/mfa/challenge` here.
- **Keeping `/admin/runbook` on the legacy portal** so RepWorth support prose stays
  out of a repo the second developer owns. Rejected: they already receive a
  curated doc set (ADR 0024 D7), and parity is the retirement bar.

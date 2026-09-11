# ADR 0031 — Retiring the Legacy admin portal: four tranches, checkable parity, a checklist scoped to what breaks

## Status

Accepted — 2026-09-07. Resolves wayfinder decision ticket #1169 on map #1159
(the admin split). It is the LAST decision ticket on that map.

Closing it releases two already-cut tickets: #1192 and #1193 both carry
`Blocked by: #1169`.

Depends on ADR 0024 (the split), ADR 0027 (the read gaps — `/admin/security`
and `/admin/runbook` MOVE), ADR 0028 (the **Admin API contract**), ADR 0029
(the end-state file set) and ADR 0030 (the starter).

Terms: `docs/context/core-accounts-channels-admin.md` → **Page parity**
(coined here), **Legacy admin portal**, **Admin app**, **Admin API**,
**Admin API contract**, **Admin transport**.

## Context

The **Legacy admin portal** is frozen and is deleted page by page as the
**Admin app** reaches parity (ADR 0024 D6). This ticket asked for the order,
the definition of parity, and the per-page checklist a `/feature` run executes.

Facts measured at 2026-09-07, on `main` at `7bb4426e`:

- **Twenty-one `page.tsx` files exist under `src/app/admin/`. Five survive
  (ADR 0029 D5), so SIXTEEN retire.** `/admin/security` and `/admin/runbook`
  are among the sixteen: ADR 0027 D3 decided both MOVE. The ticket's
  parenthetical predicted the opposite.
- **The ticket's five cited tests are three different kinds of thing.** All
  three cited line numbers resolve correctly; the classification does not.
  - `src/__tests__/console-admin-palette.test.ts:28-46`,
    `src/__tests__/runbook-empty-polish.test.ts:9` and
    `src/__tests__/no-yellow-star-colors.test.ts:71-72` READ the file from
    disk. A deletion turns CI red.
  - **Two hard pins are missing from the checklist.**
    `src/app/admin/__tests__/page-chrome.test.ts:22-` holds a static
    page-plus-client table and `readFileSync`s every entry.
    `src/app/admin/__tests__/runbook-import-consent.test.ts:20,62,97` reads
    `runbook/page.tsx` throughout — the larger of the two runbook tests, where
    the ticket cites only the smaller.
  - **Two entries are DERIVED and need no action.**
    `src/app/admin/__tests__/server-client-value-imports.test.ts:29` walks
    every `src/app/admin/**/page.tsx`, and `scanAdminPageFile`
    (`scripts/ci/admin-aal2-audit.ts:625-627`) accepts any path under
    `src/app/admin/` ending `/page.tsx`. Both self-adjust.
  - **The `admin-aal2-audit.test.ts` "fixtures" cannot break.** Every call
    passes a path STRING plus synthetic page text — `ungatedPage`,
    `plainPage`, `aal2Page` (`:668-704`). No real file is read.
    `scripts/ci/__tests__/db-imports-audit.test.ts:103` is the same shape: it
    asserts `isCompositionRoot('src/app/admin/jobs/page.tsx')`, a pure path
    classification.
- **`ci:directory-map` does not enforce the doc-row step.**
  `scripts/ci/directory-map-audit.ts:51`: "Scope is `worker/` + `src/lib/` on
  purpose: `src/app/**` is route files". `docs/directory/app-admin.md` holds 58
  rows and nothing checks them.
- **`src/components/admin/nav-config.ts:18-47` carries fifteen `/admin/...`
  hrefs, and it IS guarded.** `src/components/admin/__tests__/AdminSidebar.test.tsx`
  holds four nav-versus-filesystem tests that walk `src/app/admin` for
  `page.tsx` files: `points every nav href at a real page` (`:221-225`) fails
  on a stale entry, `lists every non-auth admin page exactly once`
  (`:210-215`) fails on a page with no entry, and
  `keeps the excluded-page list honest` (`:227-231`) fails when a page named
  in `NON_NAV_PAGES` is deleted — that list names `/admin/businesses/new`
  (`:190`). So the prune is a HARD PIN, not a silent hazard, and tranche 3
  must also drop the `NON_NAV_PAGES` entry. The file was absent from the
  ticket's checklist all the same.
- **`/admin/businesses/[id]` has ELEVEN client components** — ten under
  `_components/` plus `BusinessDetailClient.tsx` — not the seven the ticket
  states. Its twelve fetch sites are counted correctly.
- **Every retiring page except `security` and `runbook` has a sibling GET
  route** under `src/app/api/admin/`.

## Decisions

1. **The sixteen pages move in FOUR tranches, and the first needs nothing from
   the Admin API.**

   | Tranche | Pages | Why here |
   |---|---|---|
   | T1 (#1200) | `/admin/security`, `/admin/runbook` | Neither reads anything and neither needs a route (ADR 0027 D3). They move while #1184/#1185/#1186 are still being built, and they are the developer's first pages (ADR 0030 D7). |
   | T2 (#1201) | `/admin/overview` | The **Admin app**'s version already exists as Gate B's proof (ADR 0030 D8 check 6, #1197). Runs with #1192 after Overview parity and #1202; #1193 follows T4 (owner correction 2026-09-11). |
   | T3 (#1202) | `/admin/businesses`, `/admin/businesses/[id]`, `/admin/businesses/new` | The developer's main work surface; `[id]` is eleven client components and twelve fetch sites. Needs #1189's fold and options route. |
   | T4 | the remaining TEN — `autonomy`, `costs`, `demos`, `flagged`, `jobs`, `locations/csv-import`, `notifications`, `offboardings`, `solicitation`, `suppressions` | Owner priority, which does not exist yet. Tickets are cut when it does (D7). |

   Rejected: overview first, as the ticket recommends. "Proves the starter" is
   work #1197 already does, and it blocks the first deletion behind the whole
   gate build — nothing would retire for weeks.

   Rejected: `/admin/businesses/[id]` first, to surface the hard problems while
   the pattern is cheap to change. It makes the developer's first delivery the
   riskiest one, and it is blocked on the gate build plus #1189.

2. **Page parity is route-set equality PLUS a screenshot pair. Half of it is
   machine-checked.**

   **Machine half**: the **Admin app** page reaches exactly the route set the
   legacy page reached, read from the generated **Admin API contract** (#1190)
   rather than asserted by hand in a PR description.

   **Human half**: a before/after screenshot pair at 390px and 1440px, and
   founder sign-off.

   **A dropped or added route is a SPEC CHANGE, not parity**, and the
   retirement PR says so out loud rather than absorbing it. The page with
   twelve fetch sites is exactly where a silently dropped call hides.

   **Owner-approved route substitution (2026-09-11, #1226):** the business
   detail port replaces legacy `POST /api/zernio/disconnect` (business ID in
   JSON) with `POST /api/admin/businesses/[id]/disconnect` (business ID in the
   route). The new route is part of the generated Admin API contract and uses
   the canonical AAL2 gate and bearer-aware same-origin wrapper. The operation,
   offboarding refusal, selected-account race guard, and bounded best-effort
   provider cleanup are shared with the legacy handler; ADR 0001 records the
   named runtime exception. The owner cookie endpoint remains available.
   Route-set equality for this page accounts explicitly for this substitution;
   it does not omit Disconnect or weaken the general parity requirement.

   Rejected: screenshots and sign-off alone (the ticket's answer). It needs
   nothing from #1190, and it leaves "same API paths" as a claim.

   Rejected: route-set equality alone. Cheap and repeatable, but a page can
   reach every route and render the wrong thing — and the house rule is that
   acceptance is "visibly different at a glance", not "technically correct".

3. **The per-page retirement checklist, scoped to what actually breaks.**

   A `/feature` run per tranche executes, in this order:

   1. Confirm **Page parity** (D2) for every page in the tranche.
   2. Delete `src/app/admin/<page>/**`, co-located `__tests__/` included.
   3. **Prune `src/components/admin/nav-config.ts`** (D4), and drop the page's
      `NON_NAV_PAGES` entry if it has one. `AdminSidebar.test.tsx`'s
      nav-versus-filesystem block fails on either omission.
   4. Fix the HARD PINS the deletion breaks — the five files named in Context,
      of which two are new to this checklist. The gate finds them; the list
      exists so the run is not surprised.
   5. Drop the page's row from `docs/directory/app-admin.md`. **Nothing
      enforces this** — `ci:directory-map` does not scan `src/app/**`.
   6. **KEEP the sibling API route.** The **Admin app** calls it.
   7. Run the gate. A red row here is expected work, not a defect.

   **Not on the checklist, deliberately**: the `admin-aal2-audit.test.ts`
   fixtures and `db-imports-audit.test.ts:103`. The ticket asks all sixteen
   runs to update two things that cannot fail. They are swept once instead
   (D5).

4. **Pruning `nav-config.ts` is a step, and the gate enforces it.** A deleted
   page whose nav entry survives would leave the **Legacy admin portal**
   sidebar linking to a 404, and `AdminSidebar.test.tsx`'s nav-versus-
   filesystem block turns red before that ships. Three of its four cases can
   fire on a retirement: a stale href, and — for `/admin/businesses/new` only
   — a stale `NON_NAV_PAGES` entry. Treat the prune as ordinary checklist work
   whose omission the gate reports, not as a hazard the reviewer must catch.
   ADR 0029 D5 drops the sidebar from `AdminShellFrame` at the end, while
   retaining the minimal navigation configuration needed by the permanent
   impersonation pages' shared UI.

   **Corrected 2026-09-07, after this ADR merged.** It first claimed the prune
   was the one omission with a user-visible failure. That was wrong — the
   guard already existed and was not looked for. The claim is recorded here
   rather than deleted, because "we checked and there is a guard" is the fact
   worth inheriting.

5. **The silently-stale references are swept ONCE, at the end — not sixteen
   times.** They stay green after a deletion, so nothing is at risk while they
   rot. The set, named so the sweep is not re-derived:
   `scripts/ci/__tests__/admin-aal2-audit.test.ts`,
   `scripts/ci/__tests__/db-imports-audit.test.ts`,
   `src/__tests__/proxy.test.ts`,
   `src/lib/shared/__tests__/protected-routes.test.ts`,
   `src/lib/auth/__tests__/page-gate.test.ts`,
   `src/components/auth/shared/__tests__/loginDestination.test.ts`,
   and the `docs/directory/app-admin.md` rows.

   Rejected: a new `ci:admin-paths` audit failing on any `/admin/<page>` path
   with no page behind it. It catches the rot in the run that causes it, at the
   cost of a new audit plus its `ci.yml` and `lefthook.yml` wiring — and it
   re-opens `ci:directory-map`'s deliberate exclusion of `src/app/**` for the
   duration of one migration.

   Rejected: per-page by hand, guarded by review. No new tooling, and sixteen
   chances to forget with nothing failing when someone does.

6. **The end-state ticket is cut NOW (#1203), blocked by the last retirement.**
   It removes cookie mode and `withSameOriginUnlessBearer` (ADR 0025 D8) from
   `/api/admin/**` — EXCEPT `/api/admin/impersonation/**`, which keeps cookie
   mode and `withSameOrigin` permanently because impersonation never moves (ADR
   0024 D5, D4 amended at validation 2026-09-08) — narrows the cookie path of
   `src/proxy.ts` branch 4 to that prefix, and carries D5's sweep. This
   graduates map #1159's second fog patch, so the map shows a finish line
   rather than a prose note.

   After it lands, **Admin transport** has one member and the term's cookie arm
   is history rather than behaviour.

7. **Four tickets are cut now; the remaining ten pages are RECORDED, not
   pre-cut.** Sixteen near-identical tickets written before an owner priority
   exists is a tracker full of noise that ages badly. The ten page names live
   in D1's table and on map #1159, and T4's tickets are cut when the priority
   is set.

## Consequences

- Deletions start before the bearer path opens. T1 depends on no ticket in this
  repo; its precondition is **Page parity** sign-off, which is a human gate.
- **Owner ordering correction (2026-09-11):** #1192 + #1201 are one PR after
  Overview parity and #1202. #1193 follows the last tranche-4 retirement and
  precedes #1203; it no longer blocks #1201. ADR 0029 D5 retains the minimal
  UI dependencies of the permanent impersonation pages and the nav-counts API
  used by the separate Admin app. No shared module is deleted while a remaining
  page still imports it.
- **Owner execution amendment (2026-09-11):** the remaining split uses the
  LEAN sequence recorded in the orchestrator handoff §4 and map #1159 Notes.
  The earlier blanket high-risk `/feature` requirement is superseded. Only
  #1192 (proxy redirects, including its retirement batch) and #1203 (cookie
  removal) retain a staging ride and one red-team pass.
- **Recorded reservation on D5**: `docs/directory/app-admin.md` is a live
  inventory that coding agents read, so sweeping its rows at the end leaves it
  describing deleted pages for the whole migration. The owner chose the single
  sweep; D3 step 5 keeps the per-page row drop in the checklist as the
  mitigation, unguarded. Revisit if a session is ever misled by a stale row.
- The `admin-aal2-audit` PAGES contract needs no migration work at all. It is
  derived, and the shrinking page set is exactly what it is built to scan.

## Alternatives rejected

- **One ticket per page, sixteen cut today.** The ticket's literal reading. It
  makes the dependency graph complete immediately, and it fills the tracker
  with identical bodies for pages whose order nobody has decided.
- **Delete the sibling API route with the page.** It would shrink the surface
  fastest and would break the **Admin app** on the same day.
- **Keep `/admin/security` and `/admin/runbook` on the legacy portal.** The
  ticket floated it. ADR 0027 D3 already refused: both read nothing and need no
  route, so keeping them buys a shell nobody else needs.

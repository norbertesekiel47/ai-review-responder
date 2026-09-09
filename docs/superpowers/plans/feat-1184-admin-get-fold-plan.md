# feat/1184-admin-get-fold — plan

Ticket: [#1184](https://github.com/RepWorth/ai-review-responder/issues/1184) ·
Design of record: `docs/adr/0025-dual-mode-admin-gate.md` D5 (with D6, D9, D10) ·
Contract-reuse constraint: `docs/adr/0028-admin-api-contract.md` D2 ·
Intake: `docs/superpowers/plans/feat-1184-admin-get-fold-intake.json` (locked;
the ticket body plus ADR 0025 D5 ARE the signed-off intent).

RISK = high (auth) · SIZE = standard · SURFACE = mixed · `db_touching: false`.

## Modules and seams (`codebase-design` pass)

Nothing new is designed here. Three existing seams absorb the change and one
test-only module is added:

| Seam | Deepen or add | Why |
|---|---|---|
| `src/lib/auth/admin-mfa-gate.ts` → `requireAdminWithAal2` | **unchanged** | Already the one admin control-plane preamble, already dual-mode (#1183). Nine more callers is exactly what a deep module is for. |
| `scripts/ci/admin-aal2-audit.ts` → `scanRouteFile` | **deepen** | Its verb filter is one constant. The reachability walk, the provenance rule, the deny rule and the fail-closed posture are untouched; only the SET of handlers it binds grows. Exported helpers stay exported so `ci:admin-contract` (#1190) reuses this resolver instead of forking one (ADR 0028 D2). |
| `src/lib/auth/page-gate.ts` → `requireAdminPage` | **unchanged** | `{ aal2: true }` is an existing parameter that eight admin pages already pass. |
| `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts` | **add (test-only)** | The #1183 carry-forward: 22 suites carry a byte-identical gate-dependency shim (verified by hash) and this ticket would add seven more copies. Its miss mode is a silently vacuous authorization test, so it gets ONE owner. Precedent for the shape: `worker/__tests__/helpers/mock-sql.ts`, consumed from a `vi.hoisted` async factory exactly as `src/app/api/admin/costs/__tests__/route.test.ts` already does. |

No interface widens. No abstraction is added for a single caller.

## The shared shim — locked API

```ts
// src/lib/auth/__tests__/helpers/admin-gate-mocks.ts
export interface AdminGateMocks {
  /** Says whether there is a live admin. Suites keep using it verbatim. */
  mockRequireRole: Mock;
  /** Says whether the AAL2 step-up passed. */
  mockRequireCurrentAal2FromSupabase: Mock;
  /** Stand-in for @/lib/db/auth loadAppUser. */
  mockLoadAppUser: (authUserId?: string) => Promise<unknown>;
  /**
   * Stand-in for @/lib/auth/verified-identity resolveDualModeIdentity. A
   * vi.fn, so a suite can assert WHICH request reached the seam.
   */
  mockResolveDualModeIdentity: Mock;
}
export function makeAdminGateMocks(): AdminGateMocks;
```

Consumed as:

```ts
const { mockRequireRole, mockRequireCurrentAal2FromSupabase,
        mockLoadAppUser, mockResolveDualModeIdentity, /* suite-specific… */ } =
  await vi.hoisted(async () => {
    const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
    return { ...makeAdminGateMocks(), /* suite-specific handles */ };
  });
```

**Transport is DERIVED FROM THE REQUEST, never from a knob** (plan-skeptic
round 1, finding 4). The helper calls the production predicate
`isBearerRequest(request)` from `@/lib/auth/admin-transport` — a real import, not
a mock, and safe because that module is Edge-safe with zero imports of its own —
so `transport` is `'bearer'` exactly when the test built a request carrying a
real `Authorization` header. A `gateTransport: { current }` knob was the first
draft and is REJECTED: it lets a "bearer ok" test produce the cookie test's 200
without ever sending the header, which is the vacuity this ticket cannot afford.
Each per-route bearer test therefore builds
`new NextRequest(url, { headers: { authorization: 'Bearer <token>' } })` and
asserts the seam received a request whose `authorization` header is present.

Two constraints bind the implementation and both are load-bearing:

1. **`vi.mock` factories are hoisted above imports**, so the helper is reachable
   ONLY through a `vi.hoisted` async `import()` (or an `await import()` inside
   the factory). A plain top-level import referenced from a factory is a TDZ
   error at collection time.
2. The helper must **not** import `@/lib/db/auth` or `@/lib/auth/verified-identity`
   at runtime (`import type` only) — those are the modules it stands in for.

The behaviour it preserves, byte-for-byte from the 22 existing copies:
`mockRequireRole` rejecting with `statusCode` 401 → the resolver returns `null`
(the gate's 401); 403 → the resolver still returns an identity and
`mockLoadAppUser` reports `null` (the gate's 403 Forbidden); any other throw
propagates (the gate's 500). The AAL is read from
`mockRequireCurrentAal2FromSupabase`: `{ ok: true }` → `'aal2'`,
`{ ok: false, reason: 'mfa_check_failed' }` → `null`, otherwise `'aal1'`.
The ONE addition to that copied behaviour is that `transport` is now DERIVED
from the request through the production `isBearerRequest`, where the 22 copies
hard-coded `'cookie'` — see the paragraph above for why a knob was rejected.

## Tracers

Marked **(independent)** tasks share no files and no blocking edge.

### T1 — EVAL (first, alone): the shim + 48 failing tests

The `tests_to_add` bodies, committed red before any implementation.

1. Write `src/lib/auth/__tests__/helpers/admin-gate-mocks.ts` to the API above.
2. Migrate the four existing role-only read suites onto it and add the five
   owed cases to each — `costs`, `jobs`, `nav-counts`,
   `businesses/[id]/channels`. These four mock `requireRole` /
   `requireRoleOr401` directly today; leaving them there would make the new
   assertions vacuous.
3. Add the five owed cases to the two existing mixed-verb suites that already
   carry the shim — `businesses`, `businesses/[id]` — via the shared helper.
4. Create three new suites: `demos`, `notifications`, `overview`.
5. Add the three audit cases to `scripts/ci/__tests__/admin-aal2-audit.test.ts`:
   *a GET with a recognized gate passes* · *a GET with `requireRoleOr401` is a
   finding* · *a GET with an unrecognized imported wrapper is a finding*.

6. Write `src/lib/auth/__tests__/admin-gate-mocks.test.ts` (**surface
   amendment #1**, auto-approved: one file inside `src/lib/auth/__tests__/`,
   which the surface already reaches). It carries the helper's own unit tests
   AND the anti-vacuity pin from plan-skeptic finding 5: a `readFileSync` pin
   over the nine folded suites asserting none of them mocks
   `@/lib/auth/admin-mfa-gate`, so a suite can never green its 401/403
   assertions with the gate itself stubbed out. Scoped to the nine this ticket
   owns — four OTHER admin suites legitimately mock the gate today
   (`suppressions`, `solicitation/breaker` get-route, `channels/bindings`,
   `_shared/channels/resolve-actor`) and a blanket ban would need an allowlist,
   which is a new mechanism this ticket did not ask for. Repo precedent for the
   shape: `src/app/admin/businesses/[id]/__tests__/page-source.test.ts`.

Titles are the intake's `tests_to_add` VERBATIM (the gate's `promised-tests`
row is a literal match, not a judgement).

**Beyond the 48** — added from plan-skeptic round 1 and NOT in `tests_to_add`,
because the gate checks that promised titles exist, never that no others do:

- Finding 3 (the accepted 5xx change is unpinned). Every per-route refusal test
  also asserts `Cache-Control` is the gate's no-store value, which is what
  catches a fold that REWRAPS `gate.response` instead of returning it. Plus a
  dedicated 500 case on the two routes where the risk is concrete:
  `costs` (whose hand-written catch masked any non-`AuthError` as 401 and is
  being deleted) and `businesses/[id]/channels` (which has no try/catch at all
  around its read today).
- Finding 2 (the widened verb set is unpinned for the two verbs the tree does
  not use): audit fixtures `a HEAD with requireRoleOr401 is a finding` and
  `an OPTIONS with requireRoleOr401 is a finding`.

**Exit**: 48 tests present and RED for the right reason (403/401 expected,
200 received, or the audit returning no finding). Blocking edge: none.

### T2 — Share the shim across the remaining 22 suites (independent of T3)

Replace the verbatim-duplicated `resolveDualModeIdentity` and `loadAppUser`
blocks in the 22 suites listed in the intake surface with the helper.
Green→green: those suites' assertions must not change, which is itself the
proof the helper is faithful.

**Exit**: `pnpm vitest run src/app/api/admin` no worse than before T1; zero
remaining copies of the shim body (`rg -n "resolveDualModeIdentity: async"` finds
only the helper). That grep alone is NOT the anti-vacuity proof — a migrated
suite could stub `@/lib/auth/admin-mfa-gate` instead and keep every assertion
green with no authorization code running (plan-skeptic finding 5). The proof is
T1 item 6's pin over the nine folded suites; T2's 22 suites are mutation suites
whose gate call `ci:admin-aal2` independently asserts.

### T3 — Widen the audit's ROUTES contract (independent of T2)

`scripts/ci/admin-aal2-audit.ts`:

- Bind **every exported Next.js route handler**, not only `MUTATION_VERBS`:
  `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`. `MUTATION_VERBS` disappears
  as the ROUTES filter. No admin route exports `HEAD` or `OPTIONS` today —
  CORS preflight is answered in `src/proxy.ts` (#1186, ADR 0026 D1) and never
  reaches a handler — so including them costs nothing now and makes a future
  admin `OPTIONS` export a deliberate review moment rather than an invisible
  front door.
- Reword the two finding messages and the deny-rule message, which say
  "mutation handler" / "admin mutation route" today. A GET finding that calls
  itself a mutation is a false statement in a security audit.
- Update the file header's contract paragraph (`ROUTES (…) — every EXPORTED
  state-mutating handler`) to the widened rule, and record WHY the allowlist did
  not grow with it.
- The allowlist, `CANONICAL`, `resolveSpecifier`, `collectGateEvidence`,
  `referencesOwnerResolver` (file-scoped), `routeGetRequiresAal2` and every
  export stay as they are. ADR 0028 D2: `ci:admin-contract` REUSES this
  resolver.
- Existing fixtures that assume the narrow contract are updated, not deleted —
  notably `(a) GET-only admin route → no finding`, which is falsified by the
  widening and becomes a GET-with-a-gate case.
- **Add a zero-collection fatal to `main()`** (plan-skeptic finding 1). The
  audit already refuses to run when it derives zero pre-auth admin paths
  (`admin-aal2-audit.ts` `main()`), because a broken derivation that flags
  nothing is worse than a loud failure. The widened ROUTES contract needs the
  same floor: `collectRouteFiles` returns QUIETLY on an unreadable directory —
  documented, and pinned by an existing test at
  `scripts/ci/__tests__/admin-aal2-audit.test.ts:812-817` — so an admin subtree
  that cannot be read yields zero findings and the widened guarantee passes
  vacuously. The correction goes in `main()`, mirroring the existing fatal, and
  does NOT change the pinned collector behaviour. Two halves, because a
  zero-count floor alone is not enough (verification round, finding 1
  residual): `collectNamedFiles` swallows a `readdir` error per DIRECTORY and
  keeps walking its siblings, so an unreadable NESTED subtree can hide one route
  while 34 others scan clean and the audit still passes.
  - `collectNamedFiles` / `collectRouteFiles` / `collectAdminPageFiles` take an
    OPTIONAL error sink as a trailing parameter and push `{ dir, error }` into
    it. Called WITHOUT the sink — which is how the existing pin at
    `scripts/ci/__tests__/admin-aal2-audit.test.ts:812-817` calls it — the quiet
    return is byte-for-byte what it is today, so that test stays green verbatim.
  - `main()` passes a sink and exits non-zero on ANY recorded traversal error,
    and on zero collected route files or zero collected pages. The header
    sentence "An unreadable directory returns quietly by design — a permissions
    error must not fail the build" is rewritten to the posture that actually
    holds after this ticket: the COLLECTOR stays quiet for callers that do not
    care; the AUDIT fails, because after #1184 a directory it could not read is
    a guarantee it cannot make.

**Exit**: the three new audit tests green, the whole audit suite green,
`pnpm ci:admin-aal2` RED against the real tree with exactly nine route findings
plus the page findings T5 clears. Blocking edge: T1 (its tests).

### T4 — Fold the nine GET handlers

Each handler's preamble becomes, verbatim, the `offboardings` shape:

```ts
const gate = await requireAdminWithAal2(request);
if (!gate.ok) return gate.response;
```

Per-route specifics:

- `costs/route.ts` — the hand-written try/catch around `requireRole` goes
  entirely, including the non-`AuthError` 401 mask. The `parseCostQuery` 400 and
  the best-effort `margin: null` fallback are untouched.
- `businesses/[id]/channels/route.ts` — the gate moves to the FIRST statement of
  the handler, ahead of `await params` / `asLocationId`, so a malformed id
  cannot answer an unauthenticated caller differently from a well-formed one.
- `businesses/route.ts` and `businesses/[id]/route.ts` — both verbs now end on
  `requireAdminWithAal2`; `requireRoleOr401` leaves the import list.
- The other six are a straight preamble swap.
- The 5xx change is recorded in each file's header comment where one exists, and
  in the deviations file. Nothing else is unified onto the gate.

**Exit**: the 45 route tests green; `pnpm ci:admin-aal2` reports no ROUTES
finding. Blocking edge: T1, T3.

### T5 — Page parity (P2) and the falsified worked example

`routeGetRequiresAal2` turns true for six sibling routes, so six pages must pass
`{ aal2: true }`: `/admin/overview`, `/admin/businesses`,
`/admin/businesses/[id]`, `/admin/costs`, `/admin/jobs`,
`/admin/notifications`.

`/admin/businesses/[id]` is the anchor the ticket names. Its recorded reason —
"Gate parity with GET /api/admin/businesses/[id] — plain admin role, no AAL2" —
is **falsified by this ticket**, so rule P2 applies and the page flips with the
rest. Two places state that reason and both must change with it: the page's own
comment, and the audit header's "WHAT P2 IS DELIBERATELY NOT" worked example at
`admin-aal2-audit.ts:126-138`, which must be restated so it still teaches the
rule (a page hosting mutation surfaces is not thereby AAL2) without citing a
page that is now AAL2. Recorded in the deviations file.

Not touched: `/admin/demos`, `/admin/flagged`, `/admin/offboardings`,
`/admin/suppressions`, `/admin/locations/csv-import` already pass `aal2: true`
and stay a superset. `/admin/autonomy`, `/admin/security`, `/admin/runbook`,
`/admin/impersonate`, `/admin/businesses/new` have no sibling route and keep the
recorded P2 limitation.

**Exit**: `pnpm ci:admin-aal2` GREEN. Blocking edge: T3, T4.

### T6 — Rules and ledgers

- `.claude/rules/channels.md` § Traps owns the admin-MFA-gate sentence
  ("`ci:admin-aal2` compensates") — restate it for the widened contract, one
  clause, no second copy.
- `.claude/rules/admin-portal.md` § Traps (a) claims `admin-aal2-audit.test.ts`
  "passes a path STRING plus synthetic text and stays green" per page — verify
  it is still true after T3 and correct it if not.
- `.claude/reference/arch-review-log.md` merge counter;
  `scripts/ci/tenant-scope-allowlist.ts` if `ci:tenant-scope` asks for it.

**Exit**: `pnpm lint && pnpm typecheck && pnpm test` plus every `ci:*` audit
green. Blocking edge: T5.

## What this plan deliberately does NOT do

- Does not add a fourth gate shape (ADR 0025 "Alternatives rejected").
- Does not teach `src/proxy.ts` anything (ADR 0025 D6; #1185 owns it).
- Does not build `ci:admin-contract` or `docs/admin-api/` (#1190).
- Does not unify `requireRoleOr401`'s re-throw onto the gate's 500 anywhere
  outside the nine handlers (`route-helpers.ts:73-80` says why).
- Does not touch impersonation behaviour — those routes already bind credited
  gates and are only re-scanned.

## Verification

`bash scripts/verify-gate.sh` (then `--review` last), plus the intake's
`verification_commands`: `pnpm ci:admin-aal2`,
`pnpm vitest run scripts/ci/__tests__/admin-aal2-audit.test.ts`,
`pnpm vitest run src/app/api/admin src/app/admin src/lib/auth`.

## Review appendix

### Plan-skeptic round 1 (Codex, thread `01a0836d-6da6-75f2-9388-f2eeaa16ef58`)

`VERDICT: REVISE`, 5 findings, all at the failability axis. The cited-artifact
axis returned clean: "No requested path, symbol, line-range, nine-route,
six-page, 22-suite, or HEAD/OPTIONS inventory citation was otherwise
contradicted at HEAD."

| # | Finding | Verdict | Where it landed |
|---|---|---|---|
| 1 | T3's audit scope can pass vacuously — `collectRouteFiles` returns quietly on a read failure (`admin-aal2-audit.ts:654-685`, pinned at `admin-aal2-audit.test.ts:812-817`), so an unreadable admin subtree yields zero findings. | **ACCEPT, narrowed** | T3 bullet 5. The fix is a `main()` fatal mirroring the existing zero-pre-auth-paths fatal, NOT a change to the collector — the collector's quiet return is a recorded design decision with its own pin, and reversing it is a different ticket. |
| 2 | The widened verb set is unpinned for `HEAD` and `OPTIONS`, which the tree does not use, so a verb list that omits them passes today. | **ACCEPT** | T1 "Beyond the 48": two audit fixtures. |
| 3 | The accepted 5xx change is unpinned; a fold that rewraps `gate.response` or keeps the old fault behaviour passes the 45 owed tests. | **ACCEPT, narrowed** | T1 "Beyond the 48". Rewrapping is caught cheaply by asserting the no-store header on every per-route refusal; the 500 arm gets a dedicated case on the two routes where the risk is concrete (`costs`, `businesses/[id]/channels`) rather than table-driving 18 more cases over a gate behaviour `src/lib/auth/__tests__/admin-mfa-gate.test.ts` already owns. |
| 4 | "bearer ok" is transport-blind as specified — the gate reads only `authUserId` and `aal` (`admin-mfa-gate.ts:101-108`), so flipping a mocked field reproduces the cookie test's 200 without an `Authorization` header. | **ACCEPT** | The shim API section. The `gateTransport` knob is deleted; the helper calls the production `isBearerRequest` and each bearer test sends a real header. Strictly stronger than the proposed correction. |
| 5 | T2's grep does not prove a suite uses the real gate — a migrated suite could mock `@/lib/auth/admin-mfa-gate` and keep every assertion green. | **ACCEPT, narrowed** | T1 item 6 + T2 exit. A repo-wide ban is impossible: four admin suites legitimately mock the gate today, so a blanket rule would need an allowlist — a new mechanism. The pin is scoped to the nine suites this ticket owns. |

No finding contradicted a locked ADR decision, and none required widening the
gate allowlist, adding a fourth gate shape, or touching `src/proxy.ts`, CSRF,
impersonation or a flag.

### Plan-skeptic round 2 — verification only (same thread, resumed)

`VERDICT: REVISE`, two residuals, both on findings it had already raised. No new
fronts.

- **Finding 1 residual — ACCEPT.** The zero-count floor catches an unreadable
  admin ROOT but not an unreadable nested subtree: `collectNamedFiles` swallows
  a `readdir` error per directory and keeps walking siblings, so one route can
  be hidden while 34 scan clean. Fixed to its own prescription (optional error
  sink; the pinned quiet return unchanged; `main()` fatal on any recorded
  error). T3 bullet 5.
- **Finding 4 residual — ACCEPT.** Two statements still described the deleted
  `gateTransport` knob: `plan.md`'s "the ONLY addition" sentence and the
  intake's `edge_cases` entry requiring a "transport-answering shim". Both
  rewritten to require request-derived transport.

It explicitly confirmed findings 2, 3 and 5 as addressed, and confirmed that
importing `isBearerRequest` into the shim creates neither a cycle nor a hoisting
problem (`admin-transport.ts` has zero imports; the helper stays behind a
`vi.hoisted` dynamic import).

### Plan-skeptic round 3 — final verification (same thread, resumed)

Scoped to the two residuals only. `VERDICT: APPROVED`. Plan locked.

### Surface amendments

1. **+1 file: `src/lib/auth/__tests__/admin-gate-mocks.test.ts`** — the new
   helper's own suite plus the finding-5 anti-vacuity pin. Auto-approved
   (one file, inside `src/lib/auth/__tests__/`, which the surface already
   reaches). Recorded in the deviations file; both intake copies updated.

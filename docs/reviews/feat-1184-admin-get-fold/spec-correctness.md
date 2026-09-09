# Spec & correctness review — `feat/1184-admin-get-fold`

- **Repo/worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1184-admin-get-fold`
- **Range reviewed:** `e8893544..fa2e6e34` (HEAD `fa2e6e34`, clean tree apart from untracked `docs/reviews/feat-1184-admin-get-fold/`)
- **Mode:** read-only. Commands run: `pnpm ci:admin-aal2`, `pnpm typecheck`, `pnpm vitest run scripts/ci/__tests__/admin-aal2-audit.test.ts src/app/api/admin src/app/admin src/lib/auth src/lib/admin/__tests__/denorm-queries.test.ts`. No source file edited; `scripts/verify-gate.sh` not run.
- **Evidence SHA:** all assertions below re-derived at `fa2e6e34`.

## Verdict

The contract is met on every field I could mechanically check. All 48 `tests_to_add`
titles exist verbatim, each asserts what its title claims, all nine bearer cases send a
real header and assert it reached the seam, every refusal case asserts `no-store` and a
non-redirect JSON body, the allowed edit surface is not exceeded, no non-goal is
violated, and the gate-shape allowlist did not grow.

Two findings, both LOW/MEDIUM and neither a bypass: one invalid assumption in
`user_visible_behavior` about the step-up path for an **unenrolled** admin, and one
stale enumeration in a security-audit header the branch itself re-verified.

---

## 1. Field-by-field against the intake

### 1.1 `goal`

> "the nine role-only GET handlers end on `requireAdminWithAal2` … and the audit's ROUTES
> contract proves the property for GET as it already does for the mutation verbs."

**MET.** All nine GETs call the gate as their auth preamble:

| Route | Gate call |
|---|---|
| `src/app/api/admin/costs/route.ts:18` | `requireAdminWithAal2(request)` |
| `src/app/api/admin/businesses/route.ts:38` (GET) / `:72` (POST) | both |
| `src/app/api/admin/businesses/[id]/route.ts:35` (GET) / `:61` (PATCH) | both |
| `src/app/api/admin/businesses/[id]/channels/route.ts:34` | first statement of the handler |
| `src/app/api/admin/demos/route.ts:15` | ✓ |
| `src/app/api/admin/jobs/route.ts:22` | ✓ |
| `src/app/api/admin/nav-counts/route.ts:18` | ✓ |
| `src/app/api/admin/notifications/route.ts:19` | ✓ |
| `src/app/api/admin/overview/route.ts:19` | ✓ |

`scripts/ci/admin-aal2-audit.ts:204-212` replaces `MUTATION_VERBS` with
`HANDLER_VERBS = [GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS]`, consumed at `:538`.
`pnpm ci:admin-aal2` passes on the real tree: *"passed (35 admin route files, 21 admin
pages scanned)"*.

### 1.2 `user_visible_behavior` — all nine routes, all four refusal shapes

Each of the nine per-route gate blocks asserts, per refusal:

- status (`401` / `403`), and
- the exact JSON body (`{error:'Unauthorized'}` / `{error:'Forbidden'}` / `{error:'mfa_required'}`), and
- `res.headers.get('Cache-Control') === 'no-store, private'` (`NO_STORE_HEADERS`), and
- that the data read did **not** run (`expect(mockGetX).not.toHaveBeenCalled()` or `expect(mockSql).not.toHaveBeenCalled()` / `expect(sqlCalls).toHaveLength(0)`).

No refusal case is a redirect — every one asserts a JSON body off a `NextResponse.json`,
which is what `requireAdminWithAal2` returns (ADR 0025 D9 satisfied).

Success-path payload parity is preserved by the pre-existing assertions in each suite,
which were **not** deleted — test counts moved only upward in every file:

```
5 -> 10   businesses/[id]        5 -> 11   businesses/[id]/channels
34 -> 39  businesses             26 -> 32  costs
10 -> 15  jobs                    3 -> 8   nav-counts
0 -> 6    demos / notifications / overview (new suites)
0 -> 11   admin-gate-mocks        80 -> 91  admin-aal2-audit
```

and every already-migrated suite (autonomy, grant-extension, keywords, ranking,
resend-invite, zernio-queue, telegram×3, whatsapp×3, demos/generate, flagged,
impersonation×2, csv-import, offboardings, solicitation×2, denorm-queries) kept its
exact test count, i.e. the shim migration removed no assertion.

The 5xx change is pinned where it matters: `costs/__tests__/route.test.ts` —
*"a non-AuthError gate failure is internal_error, not a 401 mask"* (500 +
`{error:'internal_error'}` + no-store), and the same for channels.

### 1.3 The bearer cases — the sharpest check in the brief

All nine build a `NextRequest` carrying `authorization: 'Bearer test-admin-access-token'`
and assert on the request the seam actually received:

```ts
const seen = mockResolveDualModeIdentity.mock.calls[0]![0] as NextRequest;
expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token');
```

Verified present in all nine files (costs, businesses, businesses/[id],
businesses/[id]/channels, demos, jobs, nav-counts, notifications, overview). **Removing
the header would fail every one** — `headers.get('authorization')` returns `null` and the
assertion is a strict equality, not a truthiness check.

The knob risk D3 raised is genuinely closed at the source:
`src/lib/auth/__tests__/helpers/admin-gate-mocks.ts` derives transport by calling the
**production** `isBearerRequest` (`src/lib/auth/admin-transport.ts`), and
`admin-gate-mocks.test.ts` pins both directions (`cookie` / `bearer`) plus the
malformed-header case (`Basic abc` → still `bearer`, presence wins).

Per-suite mock hygiene checked: the suites that do not call `vi.clearAllMocks()` in the
gate block (channels, jobs) clear `mockResolveDualModeIdentity` inside `seedPassingAdmin`
(`channels/__tests__/route.test.ts:70-76`), so `mock.calls[0]` is this test's call and
`toHaveBeenCalledOnce()` is not accidentally satisfied by a neighbour.

### 1.4 The anti-vacuity guarantee

`src/lib/auth/__tests__/admin-gate-mocks.test.ts` reads all nine folded suites by path and
asserts (a) none of them `vi.mock`s `@/lib/auth/admin-mfa-gate` (absolute **or** relative
specifier), (b) each reaches the shim through `makeAdminGateMocks` and mocks
`@/lib/auth/verified-identity`, and (c) none carries a hand-rolled `resolveDualModeIdentity:
async` copy. This is the property that makes the 45 route cases non-vacuous, and it is
itself tested rather than asserted in a comment.

### 1.5 `invariants`

| Invariant | Verdict | Evidence |
|---|---|---|
| ci:admin-aal2 fail-closed, allowlist does not grow | HOLDS | `GATE_FN`/`GATE_JSON_FN`/`GATE_FNS`/`ADMIN_RESOLVER`/`OWNER_RESOLVER`/`CANONICAL` are byte-identical to `e8893544` (only line numbers moved). New fixture *"a GET with an unrecognized imported wrapper is a finding"* pins the fail-closed direction on GET. |
| Provenance by resolved import, not basename | HOLDS | `CANONICAL` block at `:258-263` unchanged; `importedAs(..., CANONICAL.gate)` at `:478` unchanged. |
| Deny rule FILE-scoped and outranks the allowlist | HOLDS | `scanRouteFile:541-548` still returns early on `referencesOwnerResolver`; new fixture *"the deny rule message no longer calls an admin route a mutation route"* keeps it green with a gated GET present. |
| P1/P2 hold both directions, zero allowlist entries | HOLDS at runtime | `pnpm ci:admin-aal2` green with 21 pages, 0 findings. (Doc nit: see Finding 2.) |
| `MFA_ENFORCEMENT_ENABLED` never read by gate or route | HOLDS | no occurrence in the nine routes or `admin-mfa-gate.ts`. |
| #12 orchestration only | HOLDS | every fold is a 2-line preamble swap; no business logic moved. |
| #15 composition roots | HOLDS | the nine route files keep their `@/lib/db/server` import; no `src/lib/**` module gained one. `pnpm typecheck` clean. |
| #1 no LLM/external/long work in a route | HOLDS | no new imports beyond `@/lib/auth/admin-mfa-gate`. |
| Audit gate resolver stays ONE implementation | HOLDS (with a note) | nothing forked; `HANDLER_VERBS` newly exported with the #1190 reuse contract in its docblock. See Appendix A3. |

### 1.6 `edge_cases`

- **HEAD/OPTIONS bound though unused** — confirmed no admin route exports either
  (`grep 'export (async function|const) (HEAD|OPTIONS)' src/app/api/admin` → empty), and
  both are pinned by dedicated fixtures plus an all-seven-verb loop.
- **Config-only route early-out** — pinned: *"a route exporting only config is still not a finding"*.
- **Message wording** — both the deny message (`admin route must not reference …`) and the
  per-handler message (`handler ${verb} must use …`) dropped "mutation"; the GET fixture
  asserts `not.toContain('mutation handler')`. Remaining occurrences of "mutation" in the
  file are prose in correct context (`:60, :152-169, :196, :220, :578`).
- **Mixed-verb files** — `(H3-a)/(H3-a2)` retargeted to the new message and a new fixture
  *"a gated GET still does NOT clear an ungated sibling mutation"* pins the property directly.
- **P2 anchor flip** — all six pages carry `aal2: true` with a parity comment naming #1184
  (`overview:16`, `businesses:22`, `businesses/[id]:38`, `costs:24`, `jobs:17`,
  `notifications:17`). The falsified `/admin/businesses/[id]` reason is replaced, and the
  header's worked example is rewritten to `/admin/businesses/new` with the old case kept as a
  dated historical note — exactly what the edge case demanded.
- **P2 supersets stay legal** — `suppressions/route.ts` and `locations/csv-import/route.ts`
  export no GET, so their `aal2: true` pages have no anchor and are P1-only; `demos`,
  `flagged`, `offboardings` are now exact parity. Audit green confirms.
- **nav-counts has no sibling page** — confirmed; its aal1 403 is the declared behaviour.
- **channels gate moved to the first statement** — confirmed at `channels/route.ts:34`,
  ahead of `await params` / `asLocationId`.
- **costs 401-mask deleted** — confirmed; parse-error 400 and margin null-fallback tests survive.
- **The 22-suite shim migration** — all 26 suites now consume `makeAdminGateMocks()`; the four
  suites that previously mocked `requireRole`/`requireRoleOr401` directly (costs, jobs,
  nav-counts, channels) plus `denorm-queries` moved onto it with zero assertion changes.
- **`vi.hoisted` + TDZ** — every consumer reaches the helper through
  `await vi.hoisted(async () => { const { makeAdminGateMocks } = await import(...) })`. No
  top-level import of the helper referenced from a factory.
- **`readFileSync`-only page suites stay green without edits** — `page-source.test.ts`,
  `page-chrome.test.ts`, `console-admin-palette.test.ts` are unmodified and pass in the
  targeted run (81 files / 842 tests, all green).

### 1.7 `non_goals` — all clean

`git diff --name-only e8893544..fa2e6e34` contains **no** `src/proxy.ts`, no
`route-helpers.ts` / `withSameOrigin*` change, no `next.config.mjs` / CORS /
`ADMIN_APP_ORIGINS`, no impersonation route (`impersonation/**/route.ts` untouched — only
their test files migrated to the shim), no `supabase/migrations/**`, no `package.json` /
`pnpm-lock.yaml`, no env-var or flag file, no `docs/admin-api/`, no
`scripts/ci/admin-contract-audit.ts`. Gate-shape allowlist unchanged (§1.5). No page
retirement or nav-config prune.

### 1.8 `allowed_edit_surface`

Every one of the 57 changed paths is listed in `allowed_edit_surface`. Zero out-of-surface
edits. The three owner-approved amendments are the ones actually used:

- D1 → `src/lib/auth/__tests__/admin-gate-mocks.test.ts` (changed) ✓
- D4 → `src/lib/admin/__tests__/denorm-queries.test.ts` (changed) ✓
- D5 → `src/app/admin/__tests__/page-aal2-parity.test.tsx` (changed) ✓

Eight surface entries went unused (the five `docs/reviews/**` review artifacts, the two
red-team artifacts, and `scripts/ci/tenant-scope-allowlist.ts`) — unused entries are not a
violation.

### 1.9 Blast radius / caller-side regressions

Every importer named in `blast-radius.md` is a test file, and all of them pass. I extended
the check beyond TS imports, since the routes' real consumers are HTTP callers:

- **Client fetchers.** `CostsClient:429`, `BusinessesClient:158`, `useBusinessDetail:91,115`,
  `JobsClient:268`, `DemosClient:200`, `OverviewClient:133`, `CsvImportClient:66`,
  `ChannelsPanel`, `AdminSidebar` (nav-counts poll). All live on `/admin/**` pages that are
  now `aal2: true` (or already were — `locations/csv-import`), so a caller that can render
  the page holds an aal2 session and the fetch succeeds.
- **E2E.** `e2e/admin-14b-runtime.spec.ts` and `admin-14c-runtime.spec.ts` exercise only the
  **unauthenticated** path (proxy branch 3/4 answers before the route), and every
  authenticated admin flow in `admin-channels-refactor.spec.ts` is `test.fixme`. No e2e
  regression.
- **Worker / server.** No worker or server module calls these HTTP routes.

### 1.10 Verification commands re-run at `fa2e6e34`

| Command | Result |
|---|---|
| `pnpm ci:admin-aal2` | PASS — 35 route files, 21 pages |
| `pnpm vitest run scripts/ci/__tests__/admin-aal2-audit.test.ts` | PASS (inside the combined run) |
| `pnpm vitest run src/app/api/admin src/app/admin src/lib/auth` (+ audit + denorm) | PASS — 81 files, 842 tests |
| `pnpm typecheck` | PASS |

---

## 2. Findings

### F1 — MEDIUM — `src/app/admin/overview/page.tsx:16`

**Contract field violated:** `user_visible_behavior` bullet 3 —
*"MFA_ENFORCEMENT_ENABLED is true on staging and production (#1182), so the Legacy admin
portal redirects that admin to /mfa/challenge and **the step-up path exists**."*
Also the `risk_reasons` entry naming "admin lockout" as one of the two defect modes.

**The assumption is invalid for an admin with no enrolled MFA factor**, and the fold is what
makes it bite.

Repository evidence:

1. `src/proxy.ts:245-256` — `getAalGate()` is the **lenient** form:
   `data.nextLevel === 'aal2' && data.currentLevel !== 'aal2' ? 'mfa_required' : 'ok'`.
   For an unenrolled admin `nextLevel` is `aal1`, so the proxy returns `'ok'` and lets the
   request through. `src/lib/auth/admin-mfa-gate.ts` documents this in so many words:
   *"never the proxy's lenient nextLevel form, which passes an unenrolled admin."*
2. `src/lib/auth/page-gate.ts:71-83` — with `aal2: true` the page gate is **strict**
   (`requireCurrentAal2FromSupabase`), and on refusal it `redirect(mfaChallengePath(from))`.
3. `src/app/mfa/challenge/MfaChallengeForm.tsx:276-296` — when `factors.length === 0` the
   screen renders *"No verified authenticator is available for this account."* with links only
   to `/login` and support. **There is no enrollment path from that screen.**
4. `src/app/admin/login/page.tsx:9` — `defaultRoute="/admin/overview"`, i.e. Overview is the
   post-login landing page.
5. `src/components/admin/nav-config.ts:40` — `/admin/security` (the `useMfaEnrollment` page,
   still plain-admin) is reachable only through the admin sidebar, which renders on admin
   pages.

**Failure scenario.** An admin account exists with no enrolled TOTP factor (permitted today —
the proxy does not force enrollment). Before this branch: sign in → land on `/admin/overview` →
sidebar renders → click **Security** → enroll → done. After this branch: sign in → land on
`/admin/overview` → strict page gate → redirect to `/mfa/challenge` → dead-end screen with no
sidebar and no enrollment link. The same is now true of Businesses, Business detail, Costs,
Jobs and Notifications, so the only admin surfaces such an account can still reach are
`/admin/security` and `/admin/runbook`, and it can reach them **only by typing the URL**.
Recovery requires out-of-band knowledge; nothing in the UI points there.

Note the direction: this is a lockout, not a bypass, and it is self-recoverable by a person
who knows the URL. Eight admin pages already had this property before the branch, so the
*kind* of failure is pre-existing — what is new is that it now covers the **landing page**
and the whole read surface, which is what removes the last in-product route to enrollment.

**Suggested resolution (not applied — read-only review):** either confirm every production and
staging admin identity has a verified factor before merge (an introspection, not a claim), or
record the gap explicitly in the ticket / `observability` so the operator knows the recovery
URL. A product fix (linking `/admin/security` from the zero-factor branch of
`MfaChallengeForm`) is outside this ticket's surface.

### F2 — LOW — `scripts/ci/admin-aal2-audit.ts:178-187`

**Contract field violated:** `edge_cases` — *"the audit header's worked example … must be
rewritten to a still-true example or restated, because **a false comment in a security audit
is worse than none**"* — applied to the paragraph the branch rewrote, but not to the
enumeration immediately below it, which the branch also re-verified.

The branch rewrites `:178-180` to:

> *"Verified against the tree after #1184: P1 and P2 hold in BOTH directions for all 21 admin
> pages with zero findings and zero allowlist entries."*

and leaves `:182-187` unchanged:

> *"RECORDED LIMITATION (P2): a page with no sibling `route.ts` has no parity anchor and is
> checked by P1 only — /admin/autonomy …, /admin/security, /admin/runbook, /admin/impersonate,
> /admin/businesses/new. **All five** are correct today; four are AAL2 anyway."*

**The list is incomplete: it is six, not five.** Evidence:

- `src/app/admin/solicitation/page.tsx:52` — `requireAdminPage(sql, { from: '/admin/solicitation', aal2: true })`, and the page reads `solicitation_send_breaker` directly via `sql`.
- `siblingRouteFile()` (`admin-aal2-audit.ts:666-668`) maps that page to
  `src/app/api/admin/solicitation/route.ts`, which **does not exist** — the routes live one
  segment deeper (`ls src/app/api/admin/solicitation` → `batch`, `breaker`).
- Therefore `/admin/solicitation` is P1-only and belongs in the limitation list.
- This was already documented in-repo:
  `docs/reviews/PATHFINDER-2026-08-22/01-flowcharts/F3-send-breaker.md:370-382` —
  *"Six, not five."*

**Failure scenario.** A future reader trusts the "all five" enumeration and the freshly dated
"Verified against the tree after #1184" sentence above it, and flips
`src/app/admin/solicitation/page.tsx:52` to `aal2: false` believing P2 would catch it.
`ci:admin-aal2` passes (no sibling anchor), and an aal1 admin is refused by
`GET /api/admin/solicitation/breaker` (`breaker/route.ts:20`, `requireAdminWithAal2`) while
being served the same breaker state by the page — the exact "parallel read path around the
API" P2 exists to close.

Pre-existing, and outside the ticket's stated scope. It is reported because the branch
re-asserted the verification claim sitting directly above the wrong list, in a file the
ticket edited, under a rule the ticket itself invoked. One-line fix: add
`/admin/solicitation` and change "All five" to "All six".

---

## Appendix — non-actionable observations

**A1. `businesses/[id]/route.ts` keeps `await params` + `asLocationId` before the gate
(`:33-35`).** The intake's edge case demanded the reorder only for `channels`, and the
asymmetry is harmless: `asLocationId` (`src/lib/shared/ids.ts:54-56`) is
`return value as LocationId` — a zero-cost cast that cannot throw. So the "malformed id
leaks a different status to an unauthenticated caller" hazard the edge case describes is
hypothetical on both routes, and the channels reorder is defensive rather than a fix. Worth
knowing if a future change makes `asLocationId` validating: `businesses/[id]` would then
have the hazard the channels comment says was closed.

**A2. The nine bearer cases prove transport reached the seam, not that the production seam
accepts a bearer.** `@/lib/auth/verified-identity` is mocked in all nine, so the assertion
is "the route handed the gate a request carrying the header, and the gate handed it to the
seam". Production bearer verification (`getClaims` → `getUser`) is covered by #1183's own
suite. This is exactly what the intake specified, so it is not a gap — only a boundary worth
stating so nobody reads the nine cases as end-to-end bearer proof. (`src/proxy.ts` branch 4
still refuses a bearer-only request, per the non-goal, so it is unprovable on staging until
#1185 either way.)

**A3. ADR 0028 D2 reuse is prepared but not yet complete.** `HANDLER_VERBS` is exported with
a docblock naming #1190 as the consumer, and nothing was forked — the invariant's operative
clause holds. But the per-handler gate *resolver* (`indexModule`, `collectGateEvidence`) is
still module-private; the exported surface gives #1190 findings-strings
(`scanRouteFile`) and a GET boolean (`routeGetRequiresAal2`), neither of which names a
route's gate. #1190 will need a one-line export, not a second reader — so this is a note, not
a finding.

**A4. Stale constant reference in a dated review artifact.**
`docs/reviews/PATHFINDER-2026-08-22/01-flowcharts/F3-send-breaker.md:382` still says
*"`MUTATION_VERBS` (`:139`) is POST/PUT/PATCH/DELETE only"*, which #1184 falsifies. It is a
dated snapshot outside `allowed_edit_surface`; flagged only so the next reader of that file
knows half its argument has since been closed.

**A5. The audit gained traversal-error reporting (`TraversalError`, `assertAuditCoverage`,
`admin-aal2-audit.ts:717-721, 769-790, 846-877`).** This is beyond the literal `goal`
sentence but is planned work, not creep — `feat-1184-admin-get-fold-plan.md:189-200, 304`
records it as plan-skeptic round-2 finding 1 with the narrowing rationale (fix in `main()`,
collector's quiet return preserved with its existing unit pin). Both directions are tested.

**A6. Shim reset semantics.** `makeAdminGateMocks()` builds `mockLoadAppUser` and
`mockResolveDualModeIdentity` via `vi.fn(impl)`. Suites clear them with `vi.clearAllMocks()`
(calls only) or `mockClear()`, never `mockReset()` on those two, so the implementations
survive between cases. Confirmed green across all 26 migrated suites. A future suite that
calls `vi.resetAllMocks()` would be relying on Vitest ≥2 restoring the `vi.fn(impl)` body —
true today, worth not depending on.

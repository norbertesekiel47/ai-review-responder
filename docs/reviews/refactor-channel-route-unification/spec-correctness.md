# Step-7 review — Spec & correctness

**Branch:** `refactor-channel-route-unification` · **Fork point:** `682681ab3f656a8bad2811dbf50176070343370f`
**Reviewer:** spec-correctness agent · **Date:** 2026-08-15
**Scope:** correctness defects in the diff, drift vs `.feature/intake.json`, unnamed user-visible
behaviour, missing `tests_to_add`, unhandled `edge_cases`, violated `invariants`, and semantic breaks
at the callers listed in `blast-radius.md`.

---

## Findings (≥80% confidence)

| Severity | file:line | Finding |
|---|---|---|
| MEDIUM | `src/lib/notifications/channels/__tests__/telegram-env.test.ts:3` · `src/lib/notifications/channels/__tests__/whatsapp-env.test.ts:3` | These two `import { flagOff } from '@/app/api/_shared/channels/flag-off'` lines are the **only** `src/lib → src/app` imports in the whole repo (`grep -rn "from '@/app/" src/lib` → exactly 2 hits, both new on this branch), violating the intake invariant "No backwards dependency from `src/lib/**` into `src/app/**`" — the exact dependency direction this refactor exists to delete. |
| LOW | `src/lib/notifications/channels/enrollment-reducer.ts:68-70` | The §4.3 403→404 change on owner cancel/disable silently changes the owner-facing error banner, which `user_visible_behavior` does not name: `classifyConnectError` maps 401/403 → "Session expired — please sign in again." and 404 → "This channel is currently unavailable.", so an owner whose session `locationId` points at a deleted business now sees a different message on Disconnect/Cancel. |
| LOW | `docs/currents.md:1740` | Stale cross-reference to a path deleted by this branch — still says `src/app/api/admin/channels/_shared/flag-off.ts ← NEW: single source for the disabled-channel 404 (telegram + whatsapp re-export it)`; the file moved to `src/app/api/_shared/channels/flag-off.ts` and nothing re-exports it any more. CLAUDE.md working rule: "grep the filename to clean every cross-reference in the same change." |
| LOW | `src/app/admin/businesses/[id]/_components/ChannelsPanel.tsx:34` | Same class: the comment anchors the panel's entitlement rule to "the API gate at `admin/channels/_shared/start.ts`", a file deleted by this branch. |

Notes on the two doc findings: `docs/currents.md` and `src/app/admin/businesses/**` are **outside
`allowed_edit_surface`**, and the amendment budget already stands at 1 of 2 (a second triggers the
abort criteria). Both are legitimately deferrable to the `/document-feature` sweep — they are recorded
here so the sweep has the exact lines, not as a demand to amend the surface.

---

## What I verified and found clean

### Contract check against `.feature/intake.json`

| Field | Verdict | Evidence |
|---|---|---|
| `tests_to_add` (44 titles) | **PASS** | Scripted literal-string grep over `src/` + `scripts/`: 44/44 present, 0 missing. The 7 `%s` entries appear verbatim as `it.each` templates, as the intake note requires. |
| `allowed_edit_surface` | **PASS** | `pnpm ci:feature-surface` → "passed (50 changed file(s) within the declared surface)". |
| `invariants` #1 / #8 / #13 / #15 / #773 / #5 / CSRF | **PASS** | See per-invariant notes below. |
| `invariant` "no backwards `src/lib` → `src/app`" | **FAIL** (finding 1) | Modules are clean; the two moved *test* files are not. |
| `user_visible_behavior` | **PASS with one omission** (finding 2) | Statuses/bodies/headers all match; the derived UI-banner change is unnamed. |
| `edge_cases` (13) | **PASS** | Walked all 13 against the code; details below. |
| `dependencies_added: []` | **PASS** | No `package.json` change in the diff. |
| `db_touching: false` | **PASS** | No `supabase/migrations/` change. |

### The security-critical portal asymmetry — no path found

I looked specifically for a way an owner request could reach the admin body-read, or for a runner to
second-guess the resolver. There is none:

- `ChannelActorResolver = (sql, req) => Promise<ChannelActorResult>` — **no source parameter**. The
  admin/owner split is two separate exported functions, not a runtime branch
  (`resolve-actor.ts:45-48`).
- All 12 routes bind the resolver as a **literal** in the config object; I read all 12 files. Owner
  routes bind `resolveOwnerActor` bare; admin routes bind
  `(db, request) => resolveAdminActor(db, request, { requireFullAccess: … })`.
- `resolveOwnerActor` (`resolve-actor.ts:114-140`) never calls `req.json()` and never touches
  `req.body`; `businessId` on the returned actor is the **session** `user.locationId`
  (`resolve-actor.ts:122, 134`). Pinned by `resolve-actor.test.ts:179-195`, which passes
  `{ businessId: 'body-biz', locationId: 'body-biz' }` in the body and asserts the actor carries
  `session-biz`.
- `resolveAdminActor` (`resolve-actor.ts:65-101`) reads the body only **after**
  `requireAdminWithAal2` returns `ok`. Pinned by `resolve-actor.test.ts:115-126`, which puts
  `locationId: 'session-biz'` on the admin gate result and asserts the bound query value is
  `'body-biz'` and *not* `'session-biz'`.
- The three runners consume the outcome and nothing else: `if (!resolved.ok) return resolved.response;`
  (`start.ts:49`, `action.ts:53`, `action.ts:82`). No runner re-reads the body, re-runs a gate, or
  inspects the failure response. `gateAndResolveActor` (`action.ts:22-33`) only prepends the two
  channel gates.
- An **admin** route binding `resolveOwnerActor` (the real escalation shape — an admin mutation
  skipping MFA step-up) is now CI-flagged: `GATED_SHARED_HELPERS = ['resolveAdminActor']`
  (`scripts/ci/admin-aal2-audit.ts:40`) names the function that *calls* the gate rather than the
  portal-agnostic runners, and case `(k)` (`scripts/ci/__tests__/admin-aal2-audit.test.ts:150`) pins
  it. `pnpm ci:admin-aal2` → passed, 32 admin route files scanned. This is strictly stronger than
  the three names it replaced; the naive rename would have opened the hole.
- The reverse (an owner route binding `resolveAdminActor`) is not CI-guarded but is not exploitable:
  `requireAdminWithAal2` rejects a non-admin session, so it fails closed.

### §4.2 gate asymmetry — all 12 bindings verified individually

| Route | Bound gate | Correct per §4.2 |
|---|---|---|
| admin telegram/whatsapp `start` | `resolveAdminActor(..., { requireFullAccess: true })` | ✅ |
| admin telegram/whatsapp `cancel` | `resolveAdminActor(..., { requireFullAccess: false })` | ✅ |
| admin telegram/whatsapp `disable` | `resolveAdminActor(..., { requireFullAccess: false })` | ✅ |
| owner telegram/whatsapp `start`/`cancel`/`disable` (6) | `resolveOwnerActor` → `resolveWritableAccountForLocation` on all three | ✅ |

Positive route-level proof exists on both sides, not just `not.toBe(403)`:
`bindings.test.ts:129-148` seeds a **cancelled** account and asserts `cancelEnrollmentMock` /
`disconnectMock` were each called once — an accidental `requireFullAccess: true` would short-circuit
before either. `bindings.test.ts:115-122` asserts the inverse for `start`.

### The frozen-fixture amendment — the "identical in production" claim holds

The claim is that `{ account_id: 'acct-1' }` → `{ id: 'acct-1', subscription_status: 'active' }` is
prod-neutral because the join predicate is `b.account_id = a.id`. I checked the schema rather than
taking the prose:

- `supabase/migrations/034_multi_location_schema.sql:88` adds `businesses.account_id UUID` nullable,
  backfills it (§5c), and **line 277** sets `ALTER TABLE businesses ALTER COLUMN account_id SET NOT NULL`
  with an FK to `accounts(id)`.
- Therefore `SELECT account_id FROM businesses WHERE id = $1` and
  `SELECT a.id FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE b.id = $1` return the
  same value for every row, and the JOIN cannot drop a row the old query returned (no NULL, no
  dangling FK). **The claim is true; the 6-site fixture amendment is behaviourally inert.**

Worth recording *why* this mattered: five of the six sites were passing **vacuously** with
`accountId === undefined` flowing into the advisory-lock key `mobile_enroll:undefined`, the cache
label, and — at `whatsapp/__tests__/disable.test.ts` — the very account-scoping assertion whose
comment reads "Reverting to `business_id` fails here". That guard is now real again.

### Hunting the false-green class further

I re-derived the three known false greens and looked for a fourth. The suites now defend against
each:

- **Memoized `getServerConfig()`** — `bindings.test.ts:108` and `deep-links.test.ts:16` both call
  `resetServerConfigForTests()` in `beforeEach`, and the wa.me tests set their env value *after* the
  reset and *before* the first `getServerConfig()` read. I traced the read order: nothing on the
  route chain forces a config read before `buildMobileDeepLink`. Assertion is live, not vacuous.
- **Look-alike `AuthError`** — `resolve-actor.test.ts:24` imports `AuthError` from the **mocked**
  `@/lib/db/auth`, so `requireRoleOr401`'s `err instanceof AuthError` branch is genuinely taken; a
  local stub would have surfaced as a rethrow, not a 401. The comment at :20-23 records this.
- **Fixture artefacts in scoping assertions** — checked every test that asserts an account id.
  `runners.test.ts:212` derives the expected lock key *from* `startEnrollmentMock`'s recorded
  argument (`log[0].values === ['mobile_enroll:' + accountId]`), so a divergence between the lock key
  and the enrollment call cannot pass. `bindings.test.ts:179` asserts the join's bound value is
  `'biz-1'`, not a fixture echo. `dashboard/channels/telegram/__tests__/disable.test.ts` (pre-existing)
  asserts `values` contains `'acct-1'` and **not** `'L2'`.
- **Cache label** — `bindings.test.ts:154` pins `admin.telegram.cancel`;
  `dashboard/channels/telegram/__tests__/disable.test.ts` pins `dashboard.telegram.disable`. Both
  values are distinct from the other surface, so a collapsed `surface` fails one of them.
- **Token-outside-tx** — `runners.test.ts:13-31` mocks `node:crypto` and records the
  `sql.begin` depth at call time. This is the only construction that can catch the regression (a
  sha256 hex string looks identical either way); the wiring guard at :159 proves the spy intercepts.
  Deviations file records the guard PASSED, and I re-ran it.

I did not find a fourth false green.

### Semantic walk of `blast-radius.md`

| Changed file | Callers walked | Verdict |
|---|---|---|
| `src/lib/notifications/channels/{telegram,whatsapp}-env.ts` | `settings/channels/page.tsx`, `api/dashboard/channels/route.ts`, 6 owner routes, 6 admin routes | Bodies are byte-equivalent to the deleted `admin/channels/{telegram,whatsapp}/_shared.ts` (I diffed them line by line), including the `MOCK_EXTERNAL_APIS` bypass at `telegram-env.ts:25` / `whatsapp-env.ts:33`. The only deletions are the `isTelegramEnabled`/`isWhatsAppEnabled` **pure passthroughs**, whose two call sites now call `channelsTelegramEnabled()` directly. |
| `settings/channels/page.tsx` | 5 test files listed | No test in `src/app/(authenticated)`, `src/app/__tests__`, `src/app/(public)` or `e2e/` mocks the old `admin/channels/*/_shared` paths (grepped). No dangling `vi.mock` left pointing at a moved module — this was the highest-risk break and it is clean. |
| `_shared/channels/action.ts` (10 importers) · `start.ts` · `resolve-actor.ts` (17) | all 12 routes + 3 suites + the aal2 audit test | Typecheck clean; behaviour walked per-route above. |
| `flag-off.ts` (4 importers) | 2 runners + the 2 moved env suites | Response is `NextResponse.json({error:'not_found'}, {status:404})` with **no** no-store header — byte-identical to the deleted `admin/channels/_shared/flag-off.ts`, which is what the existing flag-off tests assert. Finding 1 is about *where* two of those importers live, not about the response. |
| `enroll-e2e.integration.test.ts` (the only end-to-end proof of the owner start path) | — | Ran it explicitly: 4/4 pass. It still drives `../start/route` through to the worker's Twilio inbound handler. |

### Edge cases from the intake — all 13 walked

1. **One admin query shape serving both postures** — ✅ single `SELECT a.id, a.subscription_status … JOIN` (`resolve-actor.ts:84-89`), gate applied only under `options.requireFullAccess` (:93). No second query; `bindings.test.ts:171-180` asserts exactly one `FROM accounts a` per request.
2. **`blocked` must not fold into the §4.3 404** — ✅ `resolve-actor.ts:127-129` returns `errorResponse(gate.error, gate.status)` verbatim; pinned at `resolve-actor.test.ts:167` and by the two `it.each` runner tests at `runners.test.ts:278, 294`.
3. **`no_account` vs `blocked/subscription_not_active` distinguishable** — ✅ 404 `not_found` vs 403 `subscription_not_active` on separate branches.
4. **403 `no_business` before any DB read** — ✅ `resolve-actor.ts:123` precedes the account lookup; `resolve-actor.test.ts:151-152` asserts zero queries and that `resolveWritableAccountForLocation` was never called.
5. **Flag/env gates run before auth** — ✅ `start.ts:43-46`, `action.ts:27-31`. Pinned for all three runners by the two `it.each` blocks at `runners.test.ts:251, 264`, which use a `neverResolve` resolver that throws if reached and assert zero statements.
6. **`MOCK_EXTERNAL_APIS=true` bypass preserved** — ✅ `telegram-env.ts:25`, `whatsapp-env.ts:33`.
7. **`whatsappEnvReady()`'s non-route consumer** — ✅ `settings/channels/page.tsx:22` and `api/dashboard/channels/route.ts:15` both import it from `src/lib`; this is why the module belongs there.
8. **6 admin route suites** — broken deliberately at 6 sites in 4 files, owner-approved, prod-neutral (verified above). The 2 `start` suites are untouched.
9. **Owner queue-mock alignment** — ✅ `resolveOwnerActor` issues exactly one query (`resolveWritableAccountForLocation`, one statement at `writable-subscription.ts:220-249`, with the second offboarding query only on the `offboardingGate` override path, which the routes do not pass). Query count and order are unchanged from the merge base, so no owner queue mis-aligns.
10. **`enroll-e2e.integration.test.ts`** — ✅ passes.
11. **Sentry `endpoint` tag** — ✅ now `${surface}/channels/${channel}/start` (`start.ts:70`) → `admin/channels/telegram/start` / `dashboard/channels/telegram/start`, matching `observability`. Nothing consumes the old values (grepped code + runbooks).
12. **`flagOff()` collapsed into the runners, response unchanged** — ✅ see blast-radius table.
13. **`surface` union `'admin' | 'dashboard'`, no mapping layer** — ✅ `resolve-actor.ts:38` reuses `disconnectChannel`'s union; spec §4.1 amended in the diff and `CONTEXT.md` glossary matches.

### `CONTEXT.md` "Channel actor" glossary entry

Added at `CONTEXT.md:35`. It defines the term the way the code implements it —
`{ businessId, accountId, actorUserId, surface }`, `surface ∈ {'admin','dashboard'}`, the body/session
asymmetry as a security boundary, the resolver owning the gate outcome. **No rename or redefinition
of an existing concept**; `_Avoid_` lists the four near-misses. No finding.

### Invariants

- **#1 (Vercel = UI only)** — the three `_shared/channels` modules import `postgres` **type-only**
  (`start.ts:18`, `action.ts:10`, `resolve-actor.ts:22`). `src/__tests__/eslint-boundaries.test.ts`
  passes; `pnpm exec eslint` over every changed directory is clean.
- **#8 (auth scope app-enforced)** — covered above. Advisory-lock key and cache label now carry a
  real account id at all 6 previously-vacuous fixture sites.
- **#13 (flags server-authoritative)** — no new `NEXT_PUBLIC_*`; `pnpm ci:static-policy` passed
  (1138 files).
- **#15 (explicit DB client)** — the runners/resolvers take `sql: postgres.Sql`; only the 12 route
  composition roots import `@/lib/db/server`; the `src/lib/notifications/channels/*-env.ts` modules
  import no DB at all. `pnpm ci:db-imports` → "passed (strict)".
- **#773 admission chokepoint** — no `Promise.all` over `sql` anywhere in the diff. Resolver query
  → then `sql.begin` — strictly sequential (`start.ts:48` then :60; `action.ts:52` then :56).
  `runners.test.ts:177-181` asserts exactly one `begin` for start, and `:234-243` asserts
  `runChannelDisable` opens **zero** transactions of its own (`disconnectChannel` owns it), so the
  refactor did not wrap a second tx around an existing one.
- **#5 applied to enrollment tokens** — `randomUUID`/`createHash` at `start.ts:54-55`, outside
  `sql.begin` (:60); only `tokenHash` reaches Postgres (:62); the raw token appears only in the deep
  link (:90). `reportCaughtError` context is `{ failure, channel, businessId, accountId }` (:70-75) —
  `runners.test.ts:333-347` serialises it and asserts no 64-hex and no UUID appear.
- **CSRF** — `withSameOrigin()` present on all 12 exported `POST` handlers (read all 12).
- **Owner surfaces no longer import `src/app/api/admin/**`** — `grep -rn 'app/api/admin/channels' src/app/api/dashboard src/lib 'src/app/(authenticated)'` → **no matches**.

### Verification commands run

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean, no output |
| `vitest run src/app/api/{admin,dashboard}/channels src/app/api/_shared/channels src/lib/notifications/channels scripts/ci/__tests__/admin-aal2-audit.test.ts` | 33 files / 328 tests, all pass |
| `vitest run .../whatsapp/__tests__/enroll-e2e.integration.test.ts` | 1 file / 4 tests pass |
| `vitest run src/__tests__ scripts/ci/__tests__` | 51 files pass, 1 skipped (DB-gated) |
| `ci:admin-aal2` · `ci:process-env` · `ci:static-policy` · `ci:db-imports` · `ci:config-coverage` · `ci:feature-surface` · `ci:live-db-suites` · `ci:response-status` · `ci:tenant-scope` | all exit 0 |
| `eslint` over every changed directory | clean |
| intake copy vs `.feature/intake.json` | byte-identical after JSON normalisation |

---

## Low-confidence appendix (NOT findings — do not act on these without a second opinion)

1. **Duplicate `NO_STORE` constant.** `src/app/api/_shared/channels/start.ts:29` and
   `action.ts:19` each declare `const NO_STORE = { 'Cache-Control': 'no-store, private' }` while
   `src/lib/shared/constants.ts:12` already exports `NO_STORE_HEADERS` with the byte-identical value
   (I compared them; there is **no** wire difference, so the owner routes' migration from
   `errorResponse()` to the local constant is inert). This pattern is inherited verbatim from the
   deleted `admin/channels/_shared/{start,action}.ts`, so the branch neither introduced nor worsened
   it. Consolidating is a judgement call, not a defect.

2. **Mangled comment formatting in the frozen-six amendment.** The 6 amended fixture sites (e.g.
   `src/app/api/admin/channels/telegram/__tests__/cancel.test.ts:80-89`) carry a blank line between
   every single comment line, producing a 10-line block where 5 were intended. Purely cosmetic, but
   it is in a suite the process treats as a frozen regression net, so a reviewer diffing it later
   will notice.

3. **404 ambiguity on owner `disable`.** After §4.3, owner disable returns 404 `not_found` for two
   different conditions: "the location has no billing account" (resolver) and "there is no verified
   enrollment to disable" (`action.ts:91-93`). The spec's stated goal for §4.3 was *disambiguation*,
   and on `disable` specifically it trades one ambiguity for another. `cancel` and `start` are
   unaffected. I do not think this rises to a defect — the resolver case is a broken-data state that
   should be rare, and the intake explicitly locked the status — but the `observability` bullet
   ("the 404 rate on owner cancel/disable should rise by exactly the volume that previously returned
   403") will be harder to read on `disable` than on `cancel` because of the overlap.

4. **`reportCaughtError('telegram-admin', …)` / `('whatsapp-admin', …)`** in the moved env modules
   (`telegram-env.ts:31`, `whatsapp-env.ts:48`) still carry an `-admin` suffix now that the modules
   are portal-neutral and read by owner routes and the owner settings page. This is pre-existing —
   the owner routes already called these functions through the admin module before the move — so it
   is not branch-introduced drift, but the tag is now actively misleading.

5. **`admin-aal2` audit is a text scan.** An admin route that *imports* `resolveAdminActor` but
   *binds* `resolveOwnerActor` would still pass. This is strictly no weaker than the pre-branch
   allowlist and the realistic regression (case `(k)`) is pinned, so I do not treat it as a defect —
   noting it only so a future reader does not mistake the audit for an AST-level guarantee.

---

## VERDICT

**PASS with 1 MEDIUM and 3 LOW findings.** No correctness defect, no unapproved drift outside
`allowed_edit_surface`, no missing promised test, no unhandled edge case, and no semantic break at
any caller in `blast-radius.md`. The security-critical portal asymmetry is structurally enforced
(two separate resolvers, no source parameter, literal per-route binding, runners that never
second-guess the outcome), the §4.2 gate asymmetry is correct on all 12 routes with positive
route-level proof on both sides, and the frozen-fixture amendment's "identical in production" claim
is true against the real schema (`businesses.account_id` NOT NULL + FK). The one MEDIUM finding is a
test-only structural violation of the branch's own stated dependency-direction invariant.

---

## Step-7 triage verdicts (orchestrator, round 1)

- **MEDIUM — `src/lib → src/app` imports in the two env suites: ACCEPTED, FIXED.** Verified
  independently: these are the only two such imports in the repo (`rg "from '@/app/" src/lib/`),
  both new on this branch, and neither `flagOff` title is on the promised-tests list — so they are
  pre-existing cases carried along by the module move, not new coverage. Root cause: `flag-off.ts`
  stayed in `src/app/api/_shared/channels/` while the env suites moved to `src/lib`. Fixed by moving
  the coverage beside its module (new `src/app/api/_shared/channels/__tests__/flag-off.test.ts`, the
  same home as `runners.test.ts` / `resolve-actor.test.ts`) and de-duplicating — the function is
  channel-agnostic and was tested twice. Both cross-tree imports are gone; no promised title touched.
- **LOW — owner banner copy changes for the §4.3 403→404: ACCEPTED as an observation, NO code
  change.** The status flip is a locked spec decision; the banner shift is its consequence, and the
  new copy is arguably less wrong for the state (it is not a session failure). Recorded as a
  `user_visible_behavior` correction in the deviations file — an intake-field correction, explicitly
  not an `allowed_edit_surface` amendment.
- **LOW — `docs/currents.md:1740` stale cross-reference: ACCEPTED, DEFERRED to step 8.** Outside
  `allowed_edit_surface`. Pulling it in would be amendment #2, which trips the abort criteria — a
  disproportionate price for a stale reference to a moved file. Routed to step 8's
  `document-feature` sweep and recorded in the deviations file so it cannot be lost.
- **LOW — `ChannelsPanel.tsx:34` stale comment: ACCEPTED, DEFERRED to step 8.** Same reasoning,
  same routing.
- **Appendix item 5 (the audit is a text scan) — recorded dissent from the adversarial axis.** This
  report judges it "strictly no weaker than the pre-branch allowlist" and not a defect. The
  orchestrator ACCEPTED the adversarial axis's version instead, because the two axes are measuring
  different things: the substring hole is indeed old, but the mis-binding it now fails to catch is
  new — the pre-branch allowlist named admin-ONLY helpers, so there was no owner counterpart to bind
  by mistake. Old = hole × no reachable mis-binding; new = hole × reachable mis-binding. Fixed in
  `scripts/ci/admin-aal2-audit.ts` with cases (l)–(n); see `adversarial-approach-codex.md`. Both
  positions recorded here per the round protocol.

# Standards & maintainability review — `refactor-channel-route-unification`

**Range:** `git diff 682681ab3f656a8bad2811dbf50176070343370f...HEAD` (20 commits)
**Instrument:** `thermo-nuclear-code-quality-review` skill (loaded and applied) +
`codebase-design` skill for the depth vocabulary. Neither errored.
**Scope:** review only. No source file was modified.

---

## Verification actually run (not claimed)

| Command | Result |
|---|---|
| `npx vitest run src/app/api/_shared/channels src/app/api/admin/channels src/app/api/dashboard/channels src/lib/notifications/channels` | **32 files / 317 tests, all pass** |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `pnpm lint` | clean |
| `pnpm ci:static-policy` · `ci:admin-aal2` · `ci:db-imports` · `ci:process-env` · `ci:config-coverage` · `ci:feature-surface` · `ci:response-status` · `ci:tenant-scope` | all **PASS** |

No finding below is a red gate. Everything here is maintainability, test honesty,
or a boundary that should be made explicit.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium | `src/lib/notifications/channels/deep-links.ts:30` | `getServerConfig().TWILIO_WHATSAPP_NUMBER!` asserts non-null on a `rawOpt` field whose only guard (`assertWhatsAppEnvReady`) returns `null` unconditionally under `MOCK_EXTERNAL_APIS=true`; the resulting `TypeError` fires **after** the enrollment row is committed and the cache invalidated. |
| 2 | Medium | `src/app/api/_shared/channels/start.ts:29,66,76,82` + `action.ts:19,65,92,94` | Six hand-written `NextResponse.json({error},{status,headers:NO_STORE})` calls plus a duplicated local `NO_STORE` constant bypass the canonical `errorResponse()`, whose docstring says *"Use this instead of hand-writing `NextResponse.json({ error }, { status })`"*; the six owner routes used `errorResponse` before this branch. |
| 3 | Medium | `src/lib/notifications/channels/__tests__/deep-links.test.ts:33-43` | `it('admin and owner build the same wa.me deep link for the same token')` calls the same pure function twice with identical arguments and asserts the results match — a tautology that cannot fail for any implementation, and touches neither portal. |
| 4 | Low | `src/app/api/_shared/channels/start.ts:31-36` (vs `deep-links.ts:17`, `flags.ts:36`) | The branch applies the `Record<MobileChannel, …>` exhaustiveness pattern in two sibling files but not to `ChannelRouteConfig`, so the *channel* axis stays spread over 3 config fields × 6 route files with no compile-time forcing point. |
| 5 | Low | `src/app/api/admin/channels/telegram/__tests__/cancel.test.ts:80-90` (+5 more sites) | The 5-line fixture-rationale comment landed with a blank line injected between every line, and the identical 5-line block is duplicated verbatim at 6 sites across 4 files. |
| 6 | Low | `src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts:129-146` | A test named `'runChannelStart returns the flag-off 404 …'` lives inside `describe('POST /api/dashboard/channels/telegram/disable')`, and duplicates `runners.test.ts:251-258` which already parameterises `runChannelStart` over the same case. |
| 7 | Low | `src/lib/notifications/channels/telegram-env.ts:31` · `whatsapp-env.ts:48` | The Sentry tag is still `'telegram-admin'` / `'whatsapp-admin'` although this branch relocated these modules precisely because they serve both portals — while the runner it added in the same change derives its tag correctly as `${surface}/channels/${channel}/start`. |
| 8 | Low | `docs/currents.md:1740` | Live layout doc still names `src/app/api/admin/channels/_shared/flag-off.ts`, deleted by this branch; `directory.md` was swept, `currents.md` was not. |
| 9 | Low | `src/lib/config/server.ts:221,224` | The `TWILIO_WHATSAPP_NUMBER` / `TELEGRAM_BOT_USERNAME` call-site inventories still point at "admin+dashboard whatsapp/start" and "admin `??` … dashboard `?.trim() ||`" — both expressions now live only in `deep-links.ts`. |
| 10 | Low | `src/app/api/_shared/channels/action.ts:17` | `ChannelRouteConfig` is owned by `start.ts` and imported by `action.ts`; the cancel/disable runners take their whole contract from the heavier start runner rather than a neutral sibling. |
| 11 | Low | `src/lib/notifications/channels/__tests__/whatsapp-env.test.ts:5-12` · `telegram-env.test.ts:12-15` | `flagOff()` now lives at `src/app/api/_shared/channels/flag-off.ts` but its only direct tests are duplicated across two suites in a different directory tree. |

---

## Finding detail

### 1 — `deep-links.ts:30` non-null assertion is unguarded on the mock path (Medium)

```ts
const digits = getServerConfig().TWILIO_WHATSAPP_NUMBER!.replace(/\D/g, '');
```

`TWILIO_WHATSAPP_NUMBER` is declared `rawOpt` (`src/lib/config/server.ts:229`), and
the root server schema is documented as *shape-only, never throws* — so
`getServerConfig()` returns `undefined` for an unset var rather than failing.

The only thing that makes the `!` safe is `assertWhatsAppEnvReady()`. Trace it:

- `whatsapp-env.ts:33` — `whatsappEnvReady()` returns `true` immediately when
  `MOCK_EXTERNAL_APIS === 'true'`.
- `whatsapp-env.ts:45` — `assertWhatsAppEnvReady()` returns `null` (proceed).
- `start.ts:45-46` — runner proceeds.
- `start.ts:60-79` — **enrollment row commits.**
- `start.ts:88` — **cache invalidated.**
- `start.ts:90` → `deep-links.ts:30` — `undefined.replace(…)` throws.

Concrete scenario: the exact local configuration CLAUDE.md prescribes
(`MOCK_EXTERNAL_APIS=true` in `.env.local`) without `TWILIO_WHATSAPP_NUMBER` set
yields a 500 **after** a committed `pending_verification` row and an invalidated
cache — an orphaned enrollment holding the migration-027 partial-unique slot, with
a token the owner never receives. The Telegram sibling two lines above handles the
same case correctly (`?.trim() || 'RepWorthBot'`).

The `!` is carried over from the pre-refactor routes, but this branch made
`deep-links.ts` the single owner of that expression — which is the moment the
invariant should become explicit rather than asserted. No test covers it:
`bindings.test.ts:103` and `whatsapp/__tests__/start.test.ts:56` both set the var
in `beforeEach`.

### 2 — the runners bypass the canonical `errorResponse()` (Medium)

`src/lib/auth/route-helpers.ts:100-105`:

> The single error-response shape for owner/account JSON routes: `{ error: code }`
> at `status`, with the standard no-store headers (via `jsonResponse`). **Use this
> instead of hand-writing `NextResponse.json({ error }, { status })`** so every
> dashboard error returns the same body shape and cache semantics.

`start.ts` and `action.ts` each redeclare a local `NO_STORE` constant and hand-write
six such responses. The branch is internally inconsistent about this: `resolve-actor.ts:76-78`
adopts `errorResponse()` and *cites this exact reason* —

> `errorResponse()` (not a bare `NextResponse.json`) so every admin failure carries
> `Cache-Control: no-store, private`

— while its two sibling runners in the same folder do not. This is a regression on
the owner surface specifically: the pre-refactor owner routes used `errorResponse`
for `multiple_mobile_channels`, `already_verified`, `internal` and `not_found`
(`682681ab:src/app/api/dashboard/channels/telegram/start/route.ts:53,57,63`).

Concrete: a change to `NO_STORE_HEADERS` in `route-helpers.ts` now reaches the
resolver's errors and the twelve routes' other errors, but silently misses every
error the two runners emit. Remedy is a deletion, not an addition — drop both local
`NO_STORE` constants and call `errorResponse(code, status)`.

### 3 — a test that cannot fail (Medium)

```ts
it('admin and owner build the same wa.me deep link for the same token', () => {
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
  const first  = buildMobileDeepLink('whatsapp', 'tok-2');
  const second = buildMobileDeepLink('whatsapp', 'tok-2');
  expect(first).toBe(second);
  expect(first).toBe('https://wa.me/15551234567?text=start-tok-2');
});
```

Two calls to the same pure function with identical arguments. `expect(first).toBe(second)`
holds for any deterministic implementation — including one that reintroduced a
per-portal branch keyed on something other than its two parameters. The word
"admin" and the word "owner" appear only in the title and the comment; neither
portal is exercised. The second assertion is a restatement of the test 8 lines above
(`deep-links.test.ts:25-31`), which already pins digit-stripping.

This is the same class the deviations log records as Task 2b Defect 3 ("the wa.me
deep-link test passed VACUOUSLY … exactly the failure class the two review rounds
were hunting") — that entry is about `bindings.test.ts`, so this one is fresh.

The property the title claims **is** covered elsewhere, honestly: `bindings.test.ts:197`
(admin route → wa.me) and `dashboard/channels/whatsapp/__tests__/start.test.ts:154`
(owner route → wa.me) both drive real routes. Either delete this test or replace it
with an assertion those two suites cannot make on their own.

### 4 — the missed code-judo move: the channel axis was never collapsed (Low)

The plan's central claim is that `ChannelRouteConfig` is deliberately 4 fields and
"a fifth field means the seam is wrong". Judged against that claim, the seam is
genuinely deep — see the depth assessment below — but the field *count* hides that
the config carries **two** axes, not four:

| Field | Axis |
|---|---|
| `channel` | channel |
| `isEnabled` | channel |
| `assertEnvReady` | channel |
| `resolveActor` | portal |

The branch already knows the right shape for the channel axis and applies it twice
in this same diff:

- `deep-links.ts:17` — `const BUILDERS: Record<MobileChannel, …>`, with the header
  comment *"The `Record<MobileChannel, …>` makes this exhaustive: adding a mobile
  channel forces a deep-link decision at THIS one site."*
- `flags.ts:36` — `const enabled: Record<ChannelId, () => boolean>`, with the same
  argument spelled out again.

A third `Record<MobileChannel, {isEnabled, assertEnvReady}>` beside those would
reduce `ChannelRouteConfig` to `{ channel, resolveActor }` — 2 fields, one per real
axis — and give the route layer the same exhaustiveness property the other two
sites were given.

Concrete failure this leaves open: adding a third mobile channel (the design doc's
Discord/Slack path, already anticipated in `enrollment-reducer.ts`) means writing 6
new route files with 3 bindings each. Binding `isEnabled: channelsTelegramEnabled`
into a WhatsApp route compiles, passes lint, passes typecheck, and passes every CI
audit — nothing forces the decision and nothing catches the mistake. The two files
that did adopt the registry would catch their own equivalent at compile time.

This does not make the current seam wrong. It makes the "4 fields is the right
number" claim in `start.ts:9-13` a description of where the work stopped rather than
where it should have landed.

### 5 — six mangled, duplicated fixture comments (Low)

Verified in the working tree, not just the diff:

```
telegram/__tests__/cancel.test.ts   1 site
telegram/__tests__/disable.test.ts  2 sites
whatsapp/__tests__/cancel.test.ts   1 site
whatsapp/__tests__/disable.test.ts  2 sites
```

Each is the same 5-line block with a blank line injected between every comment line
— the signature of a scripted insertion joined on `\n\n`:

```ts
    // Seeds the accounts join (SELECT a.id, a.subscription_status FROM accounts a

    // JOIN businesses b ...) that resolveAdminActor issues. Before the channel-route

    // unification the resolver was SELECT account_id FROM businesses, so this row
    …
```

Prettier and ESLint do not collapse blank lines inside a comment run, which is why
lint is green. Two separate problems: the formatting artifact, and the same 90-word
rationale stated six times. The fact belongs once — in `resolve-actor.ts:83-89`,
where the query lives — with a one-line pointer at each fixture.

To be explicit: the *decision* to break the frozen six is TRIAGED/ACCEPT in the
deviations log (Task 6) and I am not re-litigating it. The reasoning there is sound
— five of the six were passing vacuously with `accountId === undefined` flowing into
the advisory-lock key, and fixing only the loud one would have silently neutered the
`account_id` scoping guard. This finding is about how the approved edit landed.

### 6 — a runner test filed under a route it does not test (Low)

`dashboard/channels/telegram/__tests__/disable.test.ts:129-146` adds
`it('runChannelStart returns the flag-off 404 without reading the database')` inside
`describe('POST /api/dashboard/channels/telegram/disable')`. It imports
`@/app/api/_shared/channels/start` and drives the runner with a synthetic config —
no owner telegram disable route is involved.

It is also redundant: `runners.test.ts:247-258` already covers all three runners for
this case via `it.each`, with the same `neverResolve` guard and an additional
`expect(log).toHaveLength(0)`.

Concrete: deleting the owner telegram disable route deletes a shared-runner test,
and a maintainer auditing runner coverage will not find it.

### 7 — `-admin` Sentry tags on modules that are no longer admin-only (Low)

`telegram-env.ts:5-7` states the branch's own rationale for moving these files:

> It was previously `api/admin/channels/telegram/_shared.ts`, which forced every
> owner surface — including the settings PAGE — to import from an admin route folder.

The Sentry tag inside did not follow: `reportCaughtError('telegram-admin', …)`
(line 31) and `reportCaughtError('whatsapp-admin', …)` (`whatsapp-env.ts:48`).
Callers now include the six owner routes, `src/app/(authenticated)/settings/channels/page.tsx:38`
and `GET /api/dashboard/channels` (`route.ts:28`). An owner-portal env outage files
under an admin tag.

The inconsistency is visible inside the branch: `start.ts:70` derives its tag
correctly as `` `${surface}/channels/${config.channel}/start` ``. Pre-existing
mislabeling — the owner routes already imported these gates — but this is the change
that made the sharing structural, and the fix is one string each.

### 8 / 9 — stale cross-references (Low)

CLAUDE.md working rule: *"When deleting a doc or ticking a checklist item, fix its
audit tick and grep the filename to clean every cross-reference in the same change."*

- `docs/currents.md:1740` still lists
  `src/app/api/admin/channels/_shared/flag-off.ts ← NEW: single source for the
  disabled-channel 404 (telegram + whatsapp re-export it)`. That file is deleted and
  nothing re-exports anything. `docs/directory.md` was swept thoroughly (good — the
  new `_shared/channels/` table is exactly right); `currents.md`, which CLAUDE.md
  names as the layout-reasoning owner, was missed. It is the only live-doc hit;
  everything else in the grep is `docs/reviews/**/blast-radius.md` or
  `docs/progress-archive/**`, which are point-in-time records and correctly untouched.
- `src/lib/config/server.ts:221-224` still inventories the deleted call sites:
  `TWILIO_WHATSAPP_NUMBER: admin+dashboard whatsapp/start` and
  `TELEGRAM_BOT_USERNAME: admin '?? RepWorthBot', dashboard '?.trim() || RepWorthBot'`.
  After this branch there is exactly one reader of each, in `deep-links.ts`, and the
  `??` variant no longer exists anywhere. A maintainer changing the fallback semantics
  is sent to two route files that no longer contain the expression — in a comment
  block whose whole purpose is to record where a migrated env read is consumed.

### 10 — `ChannelRouteConfig` ownership is inverted (Low)

`action.ts:17` — `import type { ChannelRouteConfig } from './start';`

The two lighter runners take their entire contract from the heavier one. A reader of
`action.ts` must open `start.ts` to learn what a config is, and a field added for the
start runner's benefit silently retypes both action runners. `resolve-actor.ts`
already demonstrates the alternative — it owns `ChannelActorResolver`, which both
runners import from a neutral file. Move `ChannelRouteConfig` beside it (or into a
sibling `config.ts`) and the folder has no start→action dependency at all. Folds
naturally into finding 4 if that is taken.

### 11 — `flagOff()`'s tests live two directories away, twice (Low)

`flag-off.ts` sits at `src/app/api/_shared/channels/`. Its only direct tests are
`src/lib/notifications/channels/__tests__/whatsapp-env.test.ts:5-12` (a top-level
`describe('flagOff')` in a file named for a different module) and
`telegram-env.test.ts:12-15` — duplicated, and both inherited from the old
co-located `_shared.ts`. The deviations log (Task 3) argues these cases should be
*kept*, and they should; where they are kept was not argued, and the module has since
moved to a different tree. Behaviour is covered a third time through the runners
(`runners.test.ts:251-258`), so the honest move is to delete both copies rather than
relocate them.

---

## Depth assessment (axis 2)

**Verdict: the seam is genuinely deep. The runners are real abstractions, not
pass-throughs, and the shims are thin in the good sense.**

Applying the deletion test from `codebase-design`:

- Delete `runChannelStart` → ~55 lines reappear four times: token mint ordered
  *outside* the transaction, the account-scoped advisory lock, the two-class error
  mapping, the cache invalidation, the QR encode. That is not rearranged complexity;
  it is complexity that had already been copy-pasted four ways and had already
  diverged twice (`deep-links.ts:6-9` documents both divergences). **Earning its keep.**
- Delete `runChannelCancel` → ~12 lines × 4, but the non-obvious part — that cancel
  must take the *same* `mobile_enroll:${accountId}` lock as start, or a concurrent
  start overwrites the `disabled` transition — is exactly the kind of fact that a
  deep module should hold once. `action.ts:41-46` holds it. **Earning its keep.**
- Delete `runChannelDisable` → thinnest of the three (~10 lines × 4). Alone it would
  be a borderline wrapper; as the sibling that keeps `disconnectChannel`'s
  cache-invalidation ownership documented in one place (`action.ts:68-75`), it holds.
- Delete `resolveAdminActor`/`resolveOwnerActor` → the tenant-isolation asymmetry
  (body vs session) becomes a per-route convention again, which is what the audit
  this branch is remediating found. **Strongly earning its keep.**

Seam placement passes the two-adapter rule: `ChannelActorResolver` has two real
adapters that differ in auth gate, id source, and gate outcome. Keeping them as
separate functions rather than one function with a `source: 'body' | 'session'`
parameter is the right call and the header comment (`resolve-actor.ts:9-14`) argues
it correctly — a runtime branch there would make a tenant boundary conditional.

The shims are thin in the good sense: 22 lines, zero business logic, one call, all
twelve structurally identical. Invariant #12 ("entry points orchestrate; modules own
failure behavior") is satisfied — no error-handling branch survives in any route.

Where the depth stops short is finding 4: the interface still makes the caller learn
three channel facts instead of one. A caller currently must know that Telegram means
*(`'telegram'`, `channelsTelegramEnabled`, `assertTelegramEnvReady`)* — three
correlated facts that can be mis-paired. Depth is leverage per unit of interface
learned; collapsing those three into one `channel` key is a 33% reduction in what the
caller must know, using a pattern this diff already applies twice.

---

## Repo-standards sweep (axis 1)

| Invariant / rule | Verdict |
|---|---|
| #1 Vercel = UI only | **PASS.** New `src/app/**` files use `import type postgres from 'postgres'` only (`start.ts:18`, `action.ts:10`, `resolve-actor.ts:22`). ESLint boundary test green. |
| #8 Auth scope app-enforced | **PASS, and improved.** The body-vs-session asymmetry is now a structural fact rather than a per-route convention, and `resolve-actor.test.ts:115-126` / `179-195` pin both directions explicitly. `ci:tenant-scope` passes. |
| #10 `node:crypto` | **PASS.** `start.ts:16`. No `crypto-js`. `ci:static-policy` passes. |
| #12 Entry points orchestrate | **PASS.** All twelve routes are parse-nothing/call-one-function/return. Longest new module is 140 lines. No file approaches 1000. |
| #13 Flags server-authoritative | **PASS.** `flags.ts` header restates it; no `NEXT_PUBLIC_*` added; `ci:static-policy` allowlist unchanged. |
| #15 DB client as explicit parameter | **PASS.** The three runners and both resolvers take `sql: postgres.Sql`; only the twelve `route.ts` composition roots import `@/lib/db/server`. `ci:db-imports` (strict, no baseline) passes. |
| No `any` | **PASS in source.** Tests use `as never` / `as []`; see appendix A1. |
| No silent catches | **PASS.** `start.ts:78` rethrows unrecognised errors, and `runners.test.ts:361-366` pins that. |
| No string literals for statuses | **PASS.** `subscriptionGrantsFullAccess` is used, never `=== 'active'` (`resolve-actor.ts:93`). |
| "Default is no new file" | **PASS with justification.** Net −676 lines of route code for 4 new shared modules; `docs/directory.md` updated for all of them. |

### CI-audit changes — both are strengthenings, correctly argued

`scripts/ci/admin-aal2-audit.ts` deserves specific credit. The naive successor to
`GATED_SHARED_HELPERS = ['runAdminChannelStart', …]` would have been
`['runChannelStart', …]`, which would silently exempt an admin route that bound
`resolveOwnerActor` — MFA step-up gone. The branch instead narrowed the list to the
single token that actually calls the gate (`['resolveAdminActor']`) and added case
`(k)` (`admin-aal2-audit.test.ts:135-155`) proving the naive version would have let
that file through. The audit is strictly stronger after this change than before it.

`scripts/ci/process-env-baseline.ts` is a 2-out/2-in move with the ratchet size
unchanged. Correct.

## Glossary compliance (axis 4)

**Clean — zero violations.** `rg -i "principal|caller identity|auth ?context|channel session"`
across `src/app/api/_shared/channels`, `src/lib/notifications/channels`,
`src/app/api/admin/channels`, `src/app/api/dashboard/channels` returns nothing. The
coined term is used consistently in code (`ChannelActor`, `ChannelActorResult`,
`ChannelActorResolver`, `resolveActor`), in file headers (`resolve-actor.ts:3`,
`start.ts:5`, `action.ts:5`), and in `docs/directory.md`. The `CONTEXT.md:35` entry
is unusually good — it records not just the term but why the two resolvers must never
collapse, which is the fact most likely to be lost.

## Fowler smell baseline (axis 3)

| Smell | Before | After |
|---|---|---|
| Duplicated Code | 12 routes, 4 copies of the start chain, 2 divergent deep-link builders | Gone from source. **Reappears in tests** — finding 5 (6× identical comment), finding 11 (2× `flagOff`), finding 3/6 (2 duplicate test cases). |
| Divergent Change | admin `_shared/` forced owner surfaces to import from an admin route folder | Resolved — `src/lib/notifications/channels/` |
| Shotgun Surgery | a channel-wide fix touched 12 files | Reduced to 1–2 files, **except** adding a channel (finding 4) |
| Long Function | owner start route 84 lines with 6 responsibilities | `runChannelStart` 60 lines, one responsibility |
| Primitive Obsession | `businessId`/`accountId`/`actorUserId`/`surface` passed loose | `ChannelActor` — a real type |
| Middle Man | — | Watch `runChannelDisable`; still net-positive |
| Speculative Generality | — | None. `ChannelRouteConfig` has no unused field. |

## Fowler smell — the one that got worse

Every regression in the table above landed in **test code**. Source-side smells all
improved. Findings 3, 5, 6 and 11 are one pattern: the branch was rigorous about
source deduplication and comparatively loose about test deduplication and test
placement. Given that this branch's stated worst prior defect was "tests that passed
while asserting nothing", finding 3 is the one to fix before merge.

---

## Test quality (axis 5) — the three shared-runner suites

**`runners.test.ts` — exhaustive-assertion. The strongest suite in the diff.**

- `mkSql()` records every statement with bound values and tx-nesting, and tests use
  `toEqual` on the *complete* log (`:189`, `:204`, `:229-230`, `:240`). With the
  enrollment helpers mocked, the advisory lock is the only statement a runner issues
  on its own, which is what makes the expected log short enough to assert
  exhaustively. The header comment explicitly forbids relaxing to `toContain`. An
  added or reordered query fails.
- The `node:crypto` spy (`:13-31`) is the right instrument for the right reason, and
  the reason is written down (`:8-11`): asserting the hash *shape* cannot distinguish
  mint-before-tx from mint-inside-tx, only call-time depth can. The wiring guard at
  `:159-163` runs first and would catch a dead spy — the failure mode where the
  token-timing test passes vacuously. Deliberate, and correct.
- `neverResolve` (`:127-129`) turns "the gate short-circuited" into a positive proof
  rather than an absence of a 403.
- Gaps: `invalidateMock` is registered (`:49`) and never asserted anywhere in the
  file; no case pins that `runChannelStart` invalidates with `${surface}.${channel}.start`.

**`bindings.test.ts` — exhaustive-assertion where it counts.** The `FROM accounts a`
filter with `toHaveLength(1)` (`:177-179`) is a real single-query proof, not a
hand-counted fixture list. Repeatedly uses positive proof over absence
(`:135` `expect(cancelEnrollmentMock).toHaveBeenCalledTimes(1)`; `:147` likewise,
with `:145-146` explaining why `not.toBe(403)` would be insufficient). The
`resetServerConfigForTests()` call at `:108` with its four-line rationale exists
because the omission produced a real vacuous green — that is a lesson correctly
converted into a guard.

**`resolve-actor.test.ts` — fixture-queue shaped, but safely so.** `mkSql(rows)` is a
shift-queue and returns `[]` when exhausted, which is the misalignment hazard. It is
defused here because each resolver issues at most one query, and `:151` asserts
`calls` is empty on the no-locationId path. The two strongest cases are `:115-126`
and `:179-195`: each seeds *both* a body value and a session value and asserts the
right one won — the security asymmetry, pinned from both sides.

**Do the ~44 new titles pin what they name?** Substantially yes. One does not
(finding 3), and one names a module it is not filed under (finding 6). That is a good
ratio, and the two exceptions are both cheap deletions.

**Coverage gap worth naming, though it does not reach the table.** No test asserts
the owner-side cache labels `dashboard.{telegram,whatsapp}.{start,cancel}` or
`dashboard.whatsapp.disable`. `CONTEXT.md:35` names the cache label as one of the two
things `surface` is load-bearing for, and the admin counterpart *is* pinned
(`bindings.test.ts:152-155`). The gap is smaller than it looks: `resolve-actor.test.ts:188-192`
pins `surface: 'dashboard'` at the resolver, and the owner start suites mock
`requireRole` from `@/lib/db/auth` — which only `resolveOwnerActor` calls — so a shim
that bound the wrong resolver would fail those suites loudly. An owner-side
`bindings.test.ts` mirroring the admin one would close it symmetrically.

---

## Appendix — low confidence / not findings

**A1 — cast density in the new test harnesses.** `sql as never` (`runners.test.ts:102`),
`mkReq() … as never`, and `(...a: unknown[]) => mock(...(a as []))` recur ~10 times
across the three suites. Test-only, and the alternative (typing a full `postgres.Sql`
double) is worse. Noting the pattern, not objecting.

**A2 — `flagOff()` returns 404 with no cache headers** (`flag-off.ts:12`) while every
sibling error in the same runner carries `no-store, private`. All twelve routes are
POST-only, so practical impact is near zero. Behaviour preserved byte-for-byte from
`682681ab:src/app/api/admin/channels/_shared/flag-off.ts`.

**A3 — "a fifth field means the seam is wrong" is unenforceable as written.**
`start.ts:12-13` states a durable rule, but the actual escape valve is partial
application of the resolver — already used six times
(`resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true })`).
The `requireFullAccess` axis is real and varies across routes; it simply lives in a
lambda instead of the config. Putting the gate with the actor is defensible and
`CONTEXT.md:35` documents it. The observation is only that the field-count rule
measures something narrower than it sounds like it measures; a future maintainer may
read "4 fields" as "4 varying axes" when there are 5.

**A4 — `resolveAdminActor`'s query now `JOIN`s `accounts`** where the old
`resolveAdminChannelAccount` read `businesses` alone, so admin cancel/disable now
select and discard `subscription_status`. Semantically identical given the FK; one
extra projected column. Not worth changing.

**A5 — `runners.test.ts:148-149` mutates `process.env` in `beforeEach` with no
restore.** Vitest file-level isolation makes this safe today. The sibling
`deep-links.test.ts:19-22` does restore. Inconsistent, not broken.

**A6 — `telegram-env.test.ts:8` still deletes `CHANNELS_TELEGRAM_ENABLED` in
`beforeEach`** although `telegram-env.ts` no longer reads it (the flag moved to
`flags.ts`, which has its own suite at `__tests__/flags.test.ts:25`). Dead setup,
harmless.

---

## Bottom line

This is a good refactor. The seam is in the right place, it has two real adapters,
the deletion test says the runners earn their keep, the twelve shims are correctly
thin, every invariant in scope holds, the glossary is clean, and the branch made a
security audit *stronger* on its way past. Lint, typecheck, 317 tests and eight CI
audits are green.

Fix findings 1–3 before merge: a non-null assertion that 500s after commit on the
prescribed local config, six error responses that bypass the helper documented as
their single owner, and one test that cannot fail. The rest are cheap and can ride
along.

Finding 4 is the one worth an explicit decision rather than a reflex: the branch
invented the right pattern twice in this same diff and did not apply it to its own
config. Taking it now is a small change; taking it when a third mobile channel lands
is a re-plan.

---

## Step-7 triage verdicts (orchestrator, round 1)

- **1. Medium — `TWILIO_WHATSAPP_NUMBER!` non-null assertion: ACCEPTED, FIXED.** The most serious
  finding of the whole review, and verified end to end: `TWILIO_WHATSAPP_NUMBER` is `rawOpt`,
  `whatsappEnvReady()` returns `true` on `MOCK_EXTERNAL_APIS=true` **without** the var being set, and
  `runChannelStart` built the link at line 90 — after the `sql.begin` commit at 60-63 and after the
  cache invalidation. So the TypeError landed on a committed `pending_verification` row holding the
  migration-027 unique slot, which the owner cannot retry past. Fixed on both axes: the builder now
  throws with named context instead of dereferencing through `!`, AND `runChannelStart` builds the
  deep link **before** the write, so the failure can no longer strand a row. New case pins it.
  (Pre-existing — both portals carried the same `!`, per `src/lib/config/server.ts:221` — but this
  branch consolidated it into one site and the failure ordering is in-diff.)
- **2. Medium — hand-written `NextResponse.json` bypassing `errorResponse()`: ACCEPTED, FIXED.**
  Decisive evidence: `resolve-actor.ts:76`, written in this same refactor, carries a comment
  explaining why it uses `errorResponse()` "not a bare `NextResponse.json`" — so this is an
  inconsistency inside the branch's own new code, not merely a repo-standard nit, and it is a
  regression for the owner routes that used the helper before. `NO_STORE_HEADERS`
  (`src/lib/shared/constants.ts:12`) is byte-identical to the runners' local `NO_STORE`, so the swap
  is behaviour-preserving. Both local `NO_STORE` consts deleted; success paths now use
  `jsonResponse()`.
- **3. Medium — tautological deep-link test: ACCEPTED, FIXED.** `expect(first).toBe(second)` over a
  pure function called twice with identical arguments cannot fail. Fixed **without** retitling, so
  the promised-tests gate needs no intake edit: the case now feeds the two env spellings the two
  portals' copies actually disagreed about (`whatsapp:+1555…` and `+1 (555) 123-4567`) through the
  one surviving builder and requires an identical result — which is what makes the title's claim
  mean something.
- **4. Low — no `Record<MobileChannel, …>` exhaustiveness on `ChannelRouteConfig`: REJECTED.**
  Correctly identified as the finding deserving an explicit decision, and the decision is no. The
  plan's locked tripwire says a fifth `ChannelRouteConfig` field means the seam is wrong and the
  answer is to re-plan at step 3, not to widen it during a review round; restructuring the channel
  axis is that same class of change. The risk it names requires a third mobile channel to exist,
  and the report itself concedes that is the moment to re-plan. Recorded as the trigger to do so.
- **5. Low — blank-line-injected fixture comment, 6 sites in 4 frozen files: ACCEPTED, FIXED.**
  Cheap and it is our own artefact (a scripted `\n\n` join in the approved frozen-fixture
  amendment), so tidying it completes that change rather than reopening the freeze for unrelated
  reasons. Comments only.
- **6. Low — `runChannelStart` case misfiled in the owner disable suite: REJECTED.** The title is on
  the promised-tests list and its placement was a locked plan decision (Task 2 Step 5). Moving a
  promised test to satisfy a taxonomy preference is churn against a locked artefact; the duplication
  with `runners.test.ts` is redundant coverage, not wrong coverage.
- **7. Low — Sentry tags still `'telegram-admin'` / `'whatsapp-admin'`: REJECTED for this branch,
  recorded as a follow-up.** Three reasons, and the first is decisive: the plan LOCKED it
  ("preserved verbatim — it is the existing value and nothing consumes a new one",
  `2026-08-15-channel-route-unification.md:1386`). It is also pre-existing rather than
  branch-introduced — the spec axis independently confirmed owner routes already reached these
  functions through the admin module before the move — and changing a `reportCaughtError` endpoint
  tag re-groups live Sentry issues and any alerting keyed to them. That is an operational decision
  deserving its own change, not a drive-by in a review round. The tag IS now misleading; promoting
  it to a follow-up.
- **8. Low — `docs/currents.md:1740`: ACCEPTED, DEFERRED to step 8** (duplicate of the spec axis's
  finding). Outside `allowed_edit_surface`; pulling it in is amendment #2, which trips the abort
  criteria. Routed to step 8's `document-feature` sweep.
- **9. Low — `src/lib/config/server.ts:221,224` stale env inventory comments: ACCEPTED, DEFERRED to
  step 8.** Same reasoning — outside `allowed_edit_surface`.
- **10. Low — `ChannelRouteConfig` owned by `start.ts`, imported by `action.ts`: REJECTED.** A
  neutral third module for one interface is a new file for a single shared type, against the repo's
  "default is no new file" rule and "no abstractions for a single caller". `start.ts` is the richest
  consumer and the single owner; the import direction is legible.
- **11. Low — duplicated `flagOff` tests in the wrong tree: ACCEPTED, FIXED.** Same finding the spec
  axis rated MEDIUM on dependency-direction grounds; fixed there. Two axes reaching it independently
  by different routes is the strongest signal in this round.

# Deviations — refactor-channel-route-unification

Notes on things the locked plan did not anticipate. No deviation from the plan's
instructions was taken; each entry records an observation for the plan owner.

## Task 1 — spec §4.5 residual contradiction (observation, not a deviation)

Step 3 replaced only the **first** §4.5 bullet, exactly as the plan quotes. The
replacement's third new bullet says:

> There are no existing owner `cancel`/`disable` tests for the `no_account`
> condition, so §4.3's change is covered by **new** tests, not updated ones.

The section's pre-existing **last** bullet was left untouched by the plan and now
reads against it:

> Update the owner `cancel`/`disable` tests for the 404 change (§4.3).

Both are now in §4.5. If the intent was for the new bullet to supersede the old
one, the trailing bullet should be dropped in a later task (T7 or T8's doc sweep)
— but that is outside Task 1's `allowed_edit_surface`, so it was left as-is.

**VERDICT: ACCEPT** (orchestrator, immediately after T1). The catch is correct and
the contradiction was real — the plan's Task 1 Step 3 quoted only the first bullet
for replacement and did not notice the trailing one said the opposite. Resolved in
place rather than deferred to T8, because a spec that contradicts itself is
precisely the defect class this whole PR exists to fix, and leaving it live risks a
later task following the stale bullet.

The stale `Update the owner cancel/disable tests for the 404 change (§4.3)` bullet
is replaced by two bullets naming the coverage the round-1/2 plan reviews added and
the spec had never mentioned: the runner **transaction protocol** (unpinned by
anything in the repo today) and the admin **binding** posture (§4.2), including the
fact that admin Telegram `start` has no inactive-subscription test today while
WhatsApp `start` does. §4.5 now matches the plan's Task 2 + Task 2b.

No intake field changed; `allowed_edit_surface` already covers the spec file, so
this is a deviations entry and not an amendment.

## Task 2 — one of the two Step 5 tests is GREEN on arrival (observation, not a deviation)

Every file was written verbatim from the plan and Step 6's RED matched the
prediction on 6 of the 7 reported failures. The one mismatch is in the plan's own
Step 6 expectation line:

> the two appended runner/label tests fail at `Cannot find module
> '@/app/api/_shared/channels/start'`

Only **one** of those two tests imports that module. `runChannelStart returns the
flag-off 404 without reading the database` fails as predicted. The other —
`the channel cache label keeps the admin and dashboard surfaces distinct` — calls
the existing `POST` from `../disable/route` and asserts
`safeInvalidateChannelCache(..., 'dashboard.telegram.disable')`, which the owner
route already does today, so it **passes** against unrefactored code.

That is arguably the correct shape for it: it is a *regression guard* pinning a
label the refactor must not silently flip to `admin.*` once both portals share one
runner, not a spec for new behaviour. It was left exactly as the plan wrote it (the
title is on the gate's verbatim-grep list). Flagging only so the plan owner is not
surprised that Task 2's RED is 5 failing tests + 2 failing suites rather than the
6 + 2 the Step 6 wording implies.

No file content deviates from the plan.

## Task 2b — three harness defects in the plan's `bindings.test.ts`, and the crypto spy is still UNVERIFIED

`runners.test.ts` was written **verbatim** from the plan; no character deviates.
`bindings.test.ts` required three minimal harness repairs, described below. None
touches a test title, an assertion, a mock target, or the shape of any
expectation — every change is to suite setup, and the six frozen admin route
suites remain byte-for-byte unmodified (`git diff --quiet` verified).

### The crypto-spy wiring guard is UNVERIFIED and must be re-checked when Task 5 lands

`runners.test.ts` cannot execute a single test yet: it fails at
`import { runChannelStart } from '../start'` with `Cannot find module
'/src/app/api/_shared/channels/start'`, which is the ONLY error the run reports —
no mock-factory error, no hoisting error, nothing else. The `../action` and
`../resolve-actor` imports are never reached, so they are unverified too, but
there is no evidence of a defect in them.

Because of that, **`the node:crypto spy intercepts the runner token mint` has
never run.** The plan flagged the technique as precedent-free in this repo (there
is no existing instance of mocking a `node:` builtin here), and that remains
true — the guard proves nothing until the runner modules exist.

**Action for whoever lands Task 5:** run
`pnpm test src/app/api/_shared/channels/__tests__/runners.test.ts` as the FIRST
thing after the runner modules are created, and read that guard's result before
reading any other result in the file. If it fails, do **not** weaken
`runChannelStart mints the enrollment token outside the transaction` to a
hash-shape assertion (`/^[0-9a-f]{64}$/` alone) — round 2 rejected that form as
vacuous, because a sha256 string looks identical whether it was minted before or
inside `sql.begin`. Use the plan's documented fallback instead (Task 2b Step 1,
"Fallback if the wiring guard fails"): a `begin` that throws before invoking its
callback, so a mint placed inside the transaction cannot complete. Record which
route was taken here.

One structural note in the spy's favour: the runner will import
`{ createHash, randomUUID } from 'node:crypto'` as named bindings (that is how
the module it replaces, `_shared/start.ts`, does it), and the factory spreads
`...actual` before overriding exactly those two names, so the shape is right.
Only the interception itself is unproven.

### Defect 1 — TDZ crash: the `db/server` mock factory dereferenced `record` before initialisation

As written, the suite could not load at all:

> `[vitest] There was an error when mocking a module.`
> `Caused by: ReferenceError: Cannot access 'record' before initialization`

`vi.mock` is hoisted above the file's top-level `const record = …`, and this
particular factory dereferences `record` **in its body**
(`sql: Object.assign(record, …)`) rather than inside a closure. The factory runs
while the hoisted route imports resolve, which is before the `const` executes.
(The sibling mocks — `startEnrollmentMock`, `disconnectMock` and friends, and the
same pattern throughout `runners.test.ts` — are safe precisely because they only
dereference their captured `vi.fn()` at *call* time, so the plan's pattern is
correct everywhere except this one site.)

Fix: move `record` inside the existing `vi.hoisted` block next to `sqlLog` and
`accountRow`, the state it closes over. Behaviour is identical.

### Defect 2 — every route 403'd: the harness never set `NEXT_PUBLIC_APP_URL`

With defect 1 repaired, all 15 tests failed with 403 and an empty `sqlLog`. All
six routes are wrapped in `withSameOrigin()`, which compares the request `Origin`
against `NEXT_PUBLIC_APP_URL` and returns `403 forbidden` when the var is unset —
before any handler code runs. The plan's `beforeEach` sets six env vars but not
that one; the six frozen route suites all set it (`process.env.NEXT_PUBLIC_APP_URL
= APP_URL`).

Fix: `process.env.NEXT_PUBLIC_APP_URL = 'http://localhost'` in `beforeEach`,
matching the frozen suites' convention. `runners.test.ts` is unaffected — it calls
the runners directly, below the wrapper.

### Defect 3 — the wa.me deep-link test passed VACUOUSLY (this one was a false green)

Worth recording in its own right, because it is exactly the failure class the two
review rounds were hunting. With defects 1–2 fixed, `the wa.me deep link strips
every non-digit from TWILIO_WHATSAPP_NUMBER` came back **green against
unrefactored code** — which is impossible if it is testing what it claims, since
today's builder only strips `/^whatsapp:\+?/`.

Root cause: `getServerConfig()` memoizes `process.env` on first read
(`src/lib/config/server.ts` — `if (!memo) memo = serverSchema.parse(process.env)`).
The memo was filled from the `beforeEach` value `whatsapp:+15551234567` during an
earlier test in the file, so the test's own
`process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567'` never reached the
builder and the assertion matched the *beforeEach* number. The test would have
stayed green through the whole refactor without ever exercising a formatted
number.

Fix: call the module's own test seam `resetServerConfigForTests()` at the end of
`beforeEach` (precedent: `src/lib/costs/__tests__/tracker.test.ts` and seven other
suites). The test is now correctly RED — today's builder yields
`https://wa.me/+1 (555) 123-4567?text=…`.

**Carry-forward for Task 3:** the shared deep-link builder must read the number in
a way this test can actually vary. If it too goes through a memoized
`getServerConfig()`, the `beforeEach` reset keeps the test honest — but do not
"fix" a future failure here by removing that reset.

### Step 3 result — which `bindings.test.ts` cases were already green

15 tests: **8 green, 7 red.** The plan's Step 3 prediction was right in substance
(no-gate cases pass, no-store/label/single-join/deep-link cases fail) with two
refinements: `admin telegram start … single accounts join` is also already green,
and `admin disable forwards surface admin to disconnectChannel` is already green.

Already GREEN before the refactor — these pin EXISTING behaviour the refactor must
not change (a legitimate and intended role per §4.2, which says admin
cancel/disable must not *change*):

1. `POST /api/admin/channels/telegram/start returns 403 subscription_not_active for a cancelled account`
2. `POST /api/admin/channels/whatsapp/start returns 403 subscription_not_active for a cancelled account`
3. `admin telegram cancel succeeds on a cancelled account`
4. `admin whatsapp cancel succeeds on a cancelled account`
5. `admin telegram disable reaches the disconnect on a cancelled account`
6. `admin whatsapp disable reaches the disconnect on a cancelled account`
7. `admin disable forwards surface admin to disconnectChannel`
8. `admin telegram start resolves the actor with a single accounts join`

RED — these specify NEW behaviour the refactor must deliver:

1. `the channel cache label keeps the admin and dashboard surfaces distinct` —
   fails for a reason worth knowing: today's admin cancel resolves through
   `resolveAdminChannelAccount`, which reads `SELECT account_id FROM businesses`,
   so against this suite's `accounts`-shaped fixture row it produces
   `accountId === undefined` and `safeInvalidateChannelCache` is called with a
   non-`anything()` first argument. The unified resolver's accounts join fixes
   both the label call and the id.
2. `admin telegram cancel resolves the actor with a single accounts join`
3. `admin telegram disable resolves the actor with a single accounts join`
   — (2) and (3) fail because admin cancel/disable query `FROM businesses`, not
   `FROM accounts a`.
4. `admin telegram start missing businessId response sets Cache-Control: no-store, private`
5. `admin telegram start unknown business response sets Cache-Control: no-store, private`
6. `admin telegram start inactive subscription response sets Cache-Control: no-store, private`
   — (4)–(6) fail because `runAdminChannelStart` returns its 400/404/403 without
   the `NO_STORE` headers it applies to its 409/500 paths.
7. `the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER`

`pnpm ci:live-db-suites`, `pnpm ci:db-imports` and `pnpm ci:static-policy` all
pass with both new files present, and `npx eslint` is clean on both.

## Task 3 — executed verbatim; one stale `describe` title left in place (observation, not a deviation)

Every file was written exactly as the plan quotes it, and Step 7 matched the
prediction: `pnpm test src/lib/notifications/channels` is **15 files / 192 tests,
all green**, including all four `deep-links.test.ts` cases — the Task 2 Step 2
red (and the Task 2b Defect-3 wa.me case it shares a subject with) is now closed
by the shared builder's `/\D/g` normalisation. The carry-forward was honoured:
`deep-links.ts` reads both vars through the memoized `getServerConfig()` exactly
as written, and the suite's `resetServerConfigForTests()` calls were not touched.

One cosmetic residue the plan did not mention. Step 5 specifies only the import
rewrite and the deletion of the `isTelegramEnabled` / `isWhatsAppEnabled` cases,
so `telegram-env.test.ts` still opens with `describe('admin telegram _shared', …)`
— a name that now points at a deleted file in a directory that is no longer under
`admin/`. The three surviving cases inside it are all env/flag-off cases the plan
explicitly says to keep, so nothing is mis-covered; only the label is stale.
Renaming it was outside Task 3's instructions (which scope the edit to the import
line and the two deleted cases), so it was left verbatim. Task 8's doc/name sweep
is the natural place to rename it to `telegram-env`. `whatsapp-env.test.ts` has
no equivalent problem — its `describe` blocks are named after the functions.

Typecheck is RED at commit time, as Step 6 predicts. The failing set is exactly
the repair surface Tasks 6–8 own: the 6 admin + 6 owner channel routes,
`api/dashboard/channels/route.ts`, and `dashboard/channels/telegram/__tests__/disable.test.ts`
— plus the three eval suites (`resolve-actor.test.ts`, `runners.test.ts`,
`bindings.test.ts`) that were already red pending Tasks 4/5. No file outside that
set regressed. No compatibility re-export shim was left behind for the deleted
`_shared.ts` modules. `pnpm ci:static-policy`, `pnpm ci:db-imports` and
`pnpm ci:live-db-suites` all pass, and `npx eslint` is clean on all six touched
files.

## Task 4 — a fourth harness defect in the Task 2 eval: the role-gate test rejected with a look-alike class

`resolve-actor.ts` was written **verbatim** from the plan; no character deviates,
and `git rm src/app/api/admin/channels/_shared/account.ts` ran as specified.
Step 3 came back **10 green / 1 red**, not 11 green. The single red is a defect in
the committed eval, not in the plan's resolver.

`resolveOwnerActor returns the role gate response when requireRoleOr401 fails`
declared its own throwable inline:

```ts
class AuthErrorStub extends Error { statusCode = 401; }
requireRoleMock.mockRejectedValue(new AuthErrorStub('Unauthorized'));
```

`requireRoleOr401` (`src/lib/auth/route-helpers.ts`) branches on
`err instanceof AuthError` and **deliberately re-throws** anything else — the
documented "an unexpected (non-auth) failure must not be masked as a 401" rule
that spans ~40 routes. A structurally identical stub is not an instance of the
suite's own mocked `AuthError`, so the rejection took the re-throw path and the
test died on `Error: Unauthorized` instead of receiving a 401 response. The
resolver never had a chance to be wrong here; the harness could not reach it.

Fix (two lines, in `__tests__/resolve-actor.test.ts` — which is neither one of the
six frozen admin route suites nor `bindings.test.ts`): import `AuthError` from the
already-mocked `@/lib/db/auth` and reject with `new AuthError('Unauthorized', 401)`.
That is the convention in every other suite that mocks this module — e.g.
`src/lib/auth/__tests__/route-helpers.test.ts:298` and
`src/app/api/settings/channels/override/__tests__/route.test.ts:82` both do
exactly this. No test title, assertion, mock target, or expectation shape changed;
the test still pins the same contract, and it now actually executes the branch it
names. A comment records why the local look-alike cannot come back.

Result: **11 / 11 green.** The six frozen admin route suites are byte-identical
(`git diff --quiet` verified). `bindings.test.ts` is untouched and still fails at
**suite collection** — `Cannot find module '../_shared'` from
`admin/channels/telegram/start/route.ts`, whose imports Tasks 6–8 repair — so its
split is 0 green / 15 uncollected rather than the partial split Task 4's brief
anticipated; this is the Task 3 typecheck-RED surface, not a new regression.
`npx eslint`, `pnpm ci:db-imports` and `pnpm ci:static-policy` are clean.

**Carry-forward:** one latent trap left in place deliberately. The suite's mock
factory is `AuthError: class extends Error { statusCode = 401; }` — a class *field*,
so the constructor's second argument is ignored at runtime and every instance is a
401 regardless. That is correct for the one auth-failure case this suite has, but a
future 403 case added here would silently assert 401. Give the factory a real
`constructor(message, statusCode)` (as the two precedent suites above do) at the
moment a second status is needed, not before.

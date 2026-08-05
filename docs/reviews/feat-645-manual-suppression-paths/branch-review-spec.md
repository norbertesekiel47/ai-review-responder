# Branch review — spec & correctness axis

**Branch:** `feat-645-manual-suppression-paths` · **Fork point:** `361dd074` ·
**Reviewed:** 2026-08-03 · **Axis:** conformance to `.feature/intake.json`, the
plan, spec §7/§8/§9, and correctness of the changed code. Code quality and
design approach are owned by other reviewers and are deliberately not covered.

---

## Verdict

The diff implements the intake contract faithfully. All 18 `tests_to_add`
titles exist, every `user_visible_behavior` item is reachable, every `invariant`
holds where I could trace it end to end, every `edge_case` is handled at the
layer the intake names, nothing from `non_goals` was built, and no file changed
outside `allowed_edit_surface`.

Three findings above the reporting bar, none of them blocking-severity. Two are
in the admin console client (a false compliance statement on the correction
`not_found` path, and the recipient handle placed in a URL). One is a contract
test whose title promises more than its body checks.

---

## Findings

### F-1 · MEDIUM · `src/app/admin/suppressions/SuppressionsClient.tsx:538-541`

**A `not_found` correction tells the admin "the suppression is still in place"
— the opposite of the truth.**

`submitCorrection` throws `new Error(body.error ?? …)` for any non-OK response
(line 123-125). The correct route answers a vanished row with
`404 { error: 'not_found' }`
(`src/app/api/admin/suppressions/correct/route.ts:54-59`). The client then
renders:

```
not_found — the suppression is still in place.
```

Concrete failure scenario — and it is precisely the intake edge case *"A
correction on a row that another admin already removed reports not-found rather
than writing an orphan correction record"*:

1. Admin A looks up `person@example.com`, clicks **Correct this record**,
   starts typing a reason.
2. Admin B (or A in a second tab) corrects the same row. The ledger row is gone;
   the recipient is **no longer suppressed**.
3. Admin A clicks **Confirm correction** → 404 → the page states the
   suppression is still in place.

The direction of the error matters: the file's own header comment guards the
inverse hazard (*"believing an opt-out was removed when it was not"*) but this
path produces the other one — believing an opt-out **is** in place when it is
not. An admin who trusts that sentence will not re-enter the opt-out, and the
address is now mailable. The panel also stays open on the stale `target`, so
retrying reproduces the same message indefinitely.

The raw enum `not_found` also surfaces verbatim to the user, which is how the
mis-statement is visible at all.

**Not covered by any test.** `SuppressionsClient.test.tsx:192` ("keeps the live
suppression visible when correction fails") exercises only a 500, where "still
in place" is correct.

---

### F-2 · MEDIUM · `src/app/api/admin/suppressions/route.ts:27` and `src/app/admin/suppressions/SuppressionsClient.tsx:58`

**The recipient's raw email address travels as a URL query parameter, so the
Normalized handle lands in platform request logs.**

```ts
// route.ts:27
const email = request.nextUrl.searchParams.get('email') ?? '';
// SuppressionsClient.tsx:58
fetch(`/api/admin/suppressions?email=${encodeURIComponent(email)}`)
```

Spec §9.5, named verbatim in the intake `invariants`: *"Never log the raw
handle, the raw token, or any part of the ask body… a handle must never be
interpolated into a log message."* The branch is scrupulous about this
everywhere it controls: the correct route logs only `suppressionId`
(`correct/route.ts:65-68`), the owner route logs only `accountId`, the audit
payload is asserted not to contain the handle
(`owner-do-not-contact.integration.test.ts:526`), and the analytics properties
are `{source, scope, channel}` only.

A query string is the one channel the code does not control: this route runs on
Vercel, and Vercel runtime logs / log drains record the request path including
its query string. Every `?email=` lookup therefore writes an identified
recipient's address into retained platform logs readable by anyone with project
access — the exact retention §9.5 exists to prevent — plus the admin's browser
history and any intermediate proxy.

The neighbouring admin read this route was modelled on (`/api/admin/flagged`)
takes no PII in its query string, so there is no precedent being followed here.
The entry route already POSTs the same address in a body; the lookup is the only
place it is in a URL.

*Confidence note:* I am confident about the mechanism and about §9.5's wording.
Whether the reviewer-of-record treats a query string as "a log message" is a
judgement call — the intake phrases the invariant as "analytics property or log
message", which this does not literally violate.

---

### F-3 · LOW · `src/lib/solicitation/__tests__/suppression-display.test.ts:55-62`

**Contract test title promises a double match the body never constructs.**

`tests_to_add` entry: *"global wins the display state when both a global and an
account row match"*. The whole body is:

```ts
expect(toSuppressionDisplay({ scope: 'global' })?.state).toBe('global');
```

No account row exists anywhere in the test; the "both match" condition is never
created, and the assertion would pass identically if G3's ordering were
reversed, deleted, or never written. The test proves only that the mapper echoes
whatever scope it is handed.

The test's own comment is honest about this and points at the real proof, which
does exist: `src/lib/solicitation/__tests__/suppression.integration.test.ts:574`
("suppressionMatchSql projects scope global when global and account rows both
match") seeds both rows against the live DB and asserts the `ORDER BY` picks
`global`. So the **behaviour** is covered; it is the **contract title** that is
mis-filed — a reader auditing the 18 titles against their bodies would conclude
G3 is covered by a test that cannot fail on it.

---

## Verification of the two flagged deviations

### D-A7 — flag gate on both new owner routes, before auth · **CONFIRMED COVERED**

The promised title landed in
`src/app/api/dashboard/contacts/__tests__/flag-404.test.ts` rather than the
suppression route suite. It genuinely covers both new routes and genuinely
proves ordering:

- The diff adds **both** entries to the shared route table — `POST` at
  `flag-404.test.ts:69-78` and `DELETE` at `:79-88`.
- Structural ordering: `requireContactsWriteAccess`
  (`src/app/api/dashboard/contacts/location-scope.ts:50-56`) checks
  `solicitationWatchEnabled()` and returns the 404 **before**
  `requireWritableOwner` is reached; both handlers call it as their first
  statement (`suppression/route.ts:34` and `:63`).
- Behavioural ordering: `flag-404.test.ts:107-108` asserts
  `mockRequireWritableOwner` and `mockRequireOwnerWithAccount` were never
  called.
- The file does **not** mock `../location-scope`, so the real gate runs — unlike
  `suppression-route.test.ts`, where a second copy of this test would have been
  vacuous.
- Non-vacuity check: `mockRequireWritableOwner` is a bare `vi.fn()` returning
  `undefined`, and the handler dereferences `owner.ok` outside its `try`. If the
  flag gate were removed, the loop would throw a `TypeError` rather than
  silently pass.

Ran green: `flag-404.test.ts` 1/1.

### D-A6 — `@/` alias vs. `vi.mock('../location-scope')` · **CLAIM VERIFIED**

The route imports `@/app/api/dashboard/contacts/location-scope`
(`suppression/route.ts:19-22`); the suite mocks `'../location-scope'`
(`suppression-route.test.ts:29-32`). From
`src/app/api/dashboard/contacts/__tests__/`, `../location-scope` resolves to the
same absolute module id as the alias, and the mock does intercept. Proof that
this is not merely asserted:

- `suppression-route.test.ts:134` ("derives account business contact and actor
  ids only from authenticated scope and route params") expects **status 200**
  for both POST and DELETE, and expects the repo mock to have been called with
  `{accountId: ACCOUNT_ID, businessId: LOCATION_ID, contactId: CONTACT_ID,
  actorUserId: OWNER_USER_ID}` — values that exist **only** inside
  `mockRequireContactsWriteAccess` / `mockResolveContactsScopedId`.
- If the mock had stopped intercepting, the real gate would run:
  `solicitationWatchEnabled()` → 404, or (flag on) `requireWritableOwner(sql,
  request)` against the stubbed `sql: vi.fn()` → not a 200, and the repo would
  never be reached.
- Note the first test in that file (`:88`, uniform 404) *would* still return 404
  from the real gate with an identical `{error:'Not found'}` body — so it is the
  `:134` test, not the `:88` one, that keeps the suite honest. That test passes.

Ran green: `suppression-route.test.ts` 4/4.

---

## Contract conformance tables

### `user_visible_behavior` (10/10)

| # | Behaviour | Where | Verdict |
|---|---|---|---|
| 1 | Admin lookup shows every ledger row for a handle with scope, source, recorded-at | `suppressions-service.ts:62-135`; `SuppressionsClient.tsx:145-187` | ✅ |
| 2 | Admin manual entry: raw address + required note → `global`/`admin_manual`/`created_by_user_id` | `route.ts:38-88`; `suppressions-service.ts:151-169` | ✅ |
| 3 | Unnormalizable address rejected with a visible error | `suppressions-service.ts:69,156`; `SuppressionsClient.tsx:100-108,137-143` | ✅ (entry-path rendering untested — see appendix A-4) |
| 4 | Re-entry of a globally suppressed address → "already suppressed", no second row | `recordSuppression` ON CONFLICT; `SuppressionsClient.tsx:482-487` | ✅ |
| 5 | Correction path: free-text reason, record naming who + why, same transaction as delete | `suppressions-service.ts:193-216` (single CTE) | ✅ |
| 6 | Correction labelled error correction, never re-subscribe; no owner/recipient surface | `SuppressionsClient.tsx:31-33`; admin-only AAL2 routes | ✅ |
| 7 | Owner marks do-not-contact → `account`/`owner_manual`/their `account_id`/actor | `contacts-repo.ts markContactDoNotContact` | ✅ |
| 8 | Owner clears own row; control **absent** for a global row | `ContactList.tsx:570` returns `null` | ✅ |
| 9 | Suppressed contact shown as opted out, never "skipped" | `SUPPRESSION_DISPLAY_COPY` | ✅ (see appendix A-2) |
| 10 | Owner's own row visually distinguishable from a global one | distinct label + badge palette, `ContactList.tsx:511-537` | ✅ |

### `invariants` (14/14)

| Invariant | Verdict | Evidence |
|---|---|---|
| #8 tenant isolation; global `account_id` never on an owner surface | ✅ | `listContacts` projects `suppression.scope` only (`contacts-repo.ts:74`); `toSuppressionDisplay` returns a closed 4-key object; integration assertion at `owner-do-not-contact.integration.test.ts:607-636` greps the serialized API payload for `account_id`/`accountId`/`accountName`/`source`/`note`/the account uuid/`owner_manual`; component assertion at `contacts-ui.test.tsx:274-302` feeds a widened payload and greps the DOM |
| #14 server-owned, RLS deny-all | ✅ | migration 098 enables RLS with zero policies; `ci:rls-audit` green; only `import type` crosses into the client |
| #15 explicit `Sql`/`TransactionSql` parameter | ✅ | `ci:db-imports` green (strict); the two routes + the page are the only importers of the singleton |
| #10 `node:crypto` only | ✅ | no `crypto-js` in the diff; `ci:static-policy` green |
| §8.1 no re-subscribe / no expiry / attestation never overrides | ✅ | no TTL/reaper; `owner-do-not-contact.integration.test.ts:554` proves delete-and-re-upload does not launder the row; `SuppressionsClient.test.tsx:108` greps every button for re-subscribe vocabulary |
| §7.6 owner may never clear a global row | ✅ | SQL predicate `scope='account' AND account_id = <caller>` (`contacts-repo.ts`); proven at `owner-do-not-contact.integration.test.ts:446`; the UI renders **no** control (`ContactList.tsx:570`), asserted at `contacts-ui.test.tsx:242` for `/allow\|undo\|clear/i` **and** `/don'?t contact/i` |
| G7 `suppressionMatchSql` sole owner | ✅ | 2 composers (`batch-builder.ts:447`, `contacts-repo.ts:84`); no `isSuppressed()` wrapper; `unsubscribe.ts` documents why it deliberately uses a different, narrower predicate |
| G3 global wins, lookup + display | ✅ | `ORDER BY (s.scope='global') DESC` retained; live proof at `suppression.integration.test.ts:574` (see F-3 for the unit-test title gap) |
| G11 one-directional source/scope pairing | ✅ | DB CHECK unchanged; the `RecordSuppressionInput` union still makes `owner_manual`+`global` untypeable |
| §2.1 first-write-wins | ✅ | `suppressions-correction.integration.test.ts:201,305` (note survives; not one column moves across sources) |
| DR1 no `SOLICITATION_SEND_ENABLED` read | ✅ | grep over every new/changed suppression-path file: zero hits |
| DR2 ledger stays solicitation-only | ✅ | no transactional/notification path added |
| §9.4/§9.5 handle never in analytics or a log line | ✅ in code | properties are `{source, scope, channel}`; `distinctId` falls back to the row id, never the handle; the only log calls in new production code are two `reportCaughtError(ENDPOINT, error, { accountId })`. **But see F-2** for the URL channel |
| Correction path admin-only, AAL2-gated, no owner/recipient entry | ✅ | `requireAdminWithAal2` on all three routes, asserted at `route.test.ts:93` |

**Invariant #2 (no `job_outbox` row):** ✅ — the string `job_outbox` appears
nowhere in the diff except the intake copy. `enqueueAnalyticsEvent` inserts into
`analytics_events` (`src/lib/analytics/enqueue.ts:30`), a durable table, in the
same transaction, exactly as §9.3 requires. `ci:outbox-seam` and
`ci:outbox-status` both green.

### `edge_cases` (12/12)

| Edge case | Verdict |
|---|---|
| Global `admin_manual` has `account_id = NULL`; correction record must not require one | ✅ migration 098 has no `account_id` column at all; `suppressions-correction.integration.test.ts:432` |
| `provider_suppressed` mirror is the second NULL-account case | ✅ same sink, source enum includes it (migration 098 CHECK) |
| Repeat admin entry on a globally suppressed handle is a no-op **success** | ✅ `:201`; UI copy at `SuppressionsClient.tsx:482-487`, tested `:140` |
| Admin entry writes a global row even when only an account row exists | ✅ `:271` |
| Owner mark on a contact with no email refused | ✅ `owner-do-not-contact.integration.test.ts:263`; route 409 |
| Owner clear with both global + own account row removes only the account row | ✅ `:285`, `:404` (repo/route level — see appendix A-3 for the UI tension) |
| Owner clearing a global row refused; control not rendered | ✅ `:446` + `ContactList.tsx:570` |
| Foreign contact id → same uniform 404 | ✅ `:371` (repo) + `suppression-route.test.ts:88` (route mapping + body-leak grep) |
| Correction on an already-removed row → not-found, no orphan | ✅ `:465`, `:483` (concurrent pair) — **but the UI mis-states this case, F-1** |
| Correction record survives its account — no FK | ✅ migration 098 has no FKs at all; shape test `migration-098:232` |
| §7.4 read helper distinguishes global from account without re-deriving | ✅ `suppressionMatchSql` projects `s.scope`; allowlist snippet updated (D-A5) |
| Contacts store the already-normalized email; only the admin path calls `normalizeEmail` | ✅ verified by grep — `normalizeEmail` appears only in `suppressions-service.ts` |

### `non_goals` (11/11 — none built)

No recipient-facing surface changed (`src/app/(public)/u/**`,
`worker/ingress/unsubscribe.ts` untouched). No change to
`/dashboard/requests/**` outside the `contacts/` sub-tree that
`user_visible_behavior` explicitly names. No re-subscribe control. No TTL,
expiry, or reaper. No bulk owner import. No reply/mailto parsing (the
`channels-rollout.md` addition is a documented human ritual — "no flag, no
deploy, no code path runs it"). No owner-visible reason detail (`source` stops
at the display seam). No mailbox-liveness poller. No `job_outbox` row. No new
env var or feature flag (`process.env` appears in no new production file; only
in a test's `NEXT_PUBLIC_APP_URL` stub).

### `allowed_edit_surface`

All 35 changed paths fall inside the declared surface, including
`src/lib/shared/__tests__/**` added by surface amendment D-A1. No violation.

---

## Behaviour built but not named in `user_visible_behavior`

Two, both benign and both traceable to a deviation entry:

1. **A confirm step on owner *clearing*** (D-A8). `user_visible_behavior` item 8
   says only that the owner "can clear"; the plan put a confirm step only on
   marking. Clearing now confirms too, with deliberately distinct copy
   (`SUPPRESSION_CONFIRM_COPY`, `ContactList.tsx:594-607`). This is additive
   caution on the consequential direction and is squarely inside §7.6's "the two
   controls must not read as the same thing". Not a defect.
2. **The admin lookup also renders prior Correction path records** for the
   handle (`suppressions-service.ts:92-107`, second `DataTable`). Not in
   `user_visible_behavior`, but it is the natural read companion to item 1 and
   is admin-only. Not a leak — corrections carry no `account_id`.

---

## Gate evidence (re-run at review time)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `ci:tenant-scope` | pass — 419 entries / baseline 419 |
| `ci:rls-audit` | pass (static; 42 tenant tables) |
| `ci:static-policy` | pass (1079 files) |
| `ci:outbox-status` | pass |
| `ci:outbox-seam` | pass |
| `ci:live-db-suites` | pass |
| `ci:db-imports` | pass (strict) |
| unit/route suites (5 files) | 19/19 pass |
| component suites (3 files) | 23/23 pass |
| live-DB suites w/ `TEST_DATABASE_POOL_URL` (5 files) | 47/47 pass |
| `table-disposition` + `eslint-boundaries` + `ci-audit-wiring` | 85/85 pass |

Note for whoever runs the gate next: in this worktree
`TEST_DATABASE_POOL_URL` is **not** exported in the shell, and a plain
`vitest run` on the integration files reports *"TEST_DATABASE_POOL_URL unset —
DB-gated integration suites SKIPPED"*. The suites only actually execute when the
variable is exported (I read it out of `.env.local:301`). All 47 pass once it
is. This is environment, not branch.

---

## Appendix — low-confidence observations (below the reporting bar)

**A-1 · Route-suite titles that describe a condition the suite stubs.**
`suppression-route.test.ts:88` ("…for a contact belonging to another account")
and `:114` ("refuses to clear a global row…") both mock the repo result rather
than creating the condition. This is a legitimate unit seam — the route's job
is the status mapping, and the conditions themselves are proven live at
`owner-do-not-contact.integration.test.ts:371` and `:446` — so I did not raise
it as F-3's sibling. Noted only because the same reading applies.

**A-2 · The account-scope badge never says "opted out".**
`SUPPRESSION_DISPLAY_COPY.account.label` is "You marked this contact
do-not-contact". §7.4's first bullet says a suppressed contact is shown "as
opted out of RepWorth review requests", and the contract test title (#14)
generalises to "a suppressed contact", but the body only exercises `global`.
I read §7.4's third bullet as an explicit carve-out for the account-scoped
presentation, and the detail copy ("You asked us not to send this contact review
requests") is honest and is not "skipped" — so not a violation. Flagging only
because the test title is broader than both the body and the copy.

**A-3 · The UI cannot reach the "clear my row while a global row also exists"
edge case.** G3 makes the display `global` whenever both rows match, and
`ContactList.tsx:570` then renders no control — so the owner cannot clear their
own account row through the surface once a global row lands. The edge case is
satisfied at the repo and route layers (and is exercised at
`owner-do-not-contact.integration.test.ts:285`), and the `user_visible_behavior`
item "the control is absent for a contact suppressed by a global row" positively
requires this. Consistent, but the two intake bullets are in tension and a
future reader may re-litigate it.

**A-4 · The entry path's `invalid_handle` rendering is untested.**
`SuppressionsClient.test.tsx:238` covers the *lookup* path's invalid-handle
copy; the equivalent branch in `recordManualEntry`
(`SuppressionsClient.tsx:100-108`) has no test. Not one of the 18 contract
titles.

**A-5 · "Don't contact" is offered on phone-only contacts.**
`SuppressionControl` renders the mark button whenever `suppression === null`,
including for a contact with `email: null`, where the POST is guaranteed to
return 409. The edge case says such a mark is "refused", and it is — so the
contract holds; the control is simply optimistic.

**A-6 · `internalError` console-logs the whole error object.**
`admin-mfa-gate.ts:17` does `console.error(label, error)`. A postgres.js
`PostgresError` carries an enumerable `detail`, which for a constraint violation
includes the failing row — i.e. potentially the Normalized handle. No such
violation is reachable on these paths today (`ON CONFLICT DO NOTHING` covers the
unique indexes; the pairing CHECKs cannot fire for `admin_manual`+`global`), and
`query`/`parameters` are non-enumerable unless `debug` is on. Speculative.

**A-7 · `lookupSuppressions` runs its two reads with `Promise.all` on the pooled
client**, so a correction landing between them can render a live row alongside
its own correction record (or neither). Cosmetic on an admin read.

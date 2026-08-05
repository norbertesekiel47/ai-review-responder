# Branch review — spec & correctness axis, ROUND 2 (verification only)

**Branch:** `feat-645-manual-suppression-paths` · **Delta reviewed:** `48c11018..HEAD`
(`a0674ed6`, `4c157435`, `4af0af58`, `8361ad42`, `efe15be4`) · **Reviewed:** 2026-08-03

Scope is deliberately narrow: verify the three round-1 findings are addressed,
verify the D-A11 schema change did not break the contract clauses it could
plausibly break, and check that the fixes introduced no new defect. **No new
fronts are opened against unchanged code**; anything noticed outside that remit
is quarantined in the appendix and does not affect the conclusion.

---

## Verdict

| Finding | Status | Evidence |
|---|---|---|
| F-1 · `not_found` claimed "still in place" | **ADDRESSED** | `not_found` is a returned outcome, not a thrown error; its own amber branch, truthful copy, forced re-read; both branches tested |
| F-2 · raw handle in a GET query string | **ADDRESSED** | GET deleted outright; `POST /api/admin/suppressions/lookup` with the address in the body; AAL2 + same-origin (new) + `z.strictObject` all present and tested |
| F-3 · contract title on a test that proved nothing | **ADDRESSED** | Title exists verbatim exactly once in `src/`, on the live-DB test that seeds a real global + account double match |
| D-A11 re-check | **CONTRACT HOLDS** | New columns reach no surface at all; 18/18 titles verbatim; one file outside surface, fairly characterised; §8.2 atomicity unchanged |

**No fix introduced a new defect** at or above the reporting bar.

---

## F-1 — `not_found` correction copy · ADDRESSED

### The two branches cannot be confused

`submitCorrection` (`src/app/admin/suppressions/SuppressionsClient.tsx:151-172`)
now returns a closed two-member union instead of throwing on every non-OK
response:

```ts
type CorrectionOutcome = 'corrected' | 'already_removed';
…
if (response.status === 404 && body.error === 'not_found') return 'already_removed';
if (!response.ok || body.corrected !== true) {
  throw new Error(errorSentence(body.error, `Correction failed (${response.status})`));
}
return 'corrected';
```

Three render branches, mutually exclusive by construction
(`SuppressionsClient.tsx:576-602`):

| Branch | Guard | Copy | Wash / role |
|---|---|---|---|
| removed by this admin | `isSuccess && data === 'corrected'` | "Record corrected. The removal is in the audit trail." | green / `role="status"` |
| already removed (404) | `isSuccess && data === 'already_removed'` | "This record was already removed — another admin corrected it first. **It is no longer suppressing anyone.**" | amber / `role="alert"` |
| genuine failure | `isError` | `<sentence> — the suppression is still in place.` | red / `role="alert"` |

`isSuccess` and `isError` are mutually exclusive TanStack Query states, and
`data` is a 2-member literal union, so no input can render two of these. The
only route that can produce the 404 is `correct/route.ts:53-58`, and it emits it
on exactly one condition — `correctSuppression` returned `'not_found'`, which
`suppressions-service.ts:225` derives solely from "the DELETE matched zero
rows". So the amber branch's claim ("no longer suppressing anyone") is exactly
the fact the status encodes; the red branch's "still in place" is retained only
where the row genuinely was not removed.

### The direction hazard is closed at both ends

`onSuccess` now clears the panel **and** invalidates the lookup query for both
outcomes (`SuppressionsClient.tsx:379-392`), so the admin is left reading
current ledger state rather than the stale row they acted on. That is what makes
the sentence checkable rather than merely asserted.

### Raw tokens no longer render

`ERROR_COPY` + `errorSentence` (`SuppressionsClient.tsx:47-71`) map every code
the three endpoints can return to a sentence and fall back to a status-shaped
sentence for anything unrecognised. All three network helpers route through it
(`:120`, `:140`, `:169`). `invalid_handle` still maps to `INVALID_HANDLE_COPY`,
so `user_visible_behavior` #3 is intact on both the lookup and entry paths
(`renders an unnormalizable address as an invalid email and never as not found`
— green).

### The distinction is tested

- `SuppressionsClient.test.tsx:214-249` — *"tells the admin an already-corrected
  record was removed and never that it is still in place"*. Asserts
  `/already removed/i`, `/no longer suppressing anyone/i`, **`not` `/still in
  place/i`** on the alert **and** `queryByText(/still in place/i)` null on the
  whole page, `queryByText(/not_found/)` null, **two** calls to the lookup URL
  (the forced re-read), and `Not suppressed` rendered afterwards.
- `SuppressionsClient.test.tsx:194-212` — the pre-existing 500 test survives and
  still asserts `/still in place/i` plus row survival, so the two branches are
  pinned in opposite directions by two tests that would both have to be deleted
  to lose the distinction.

Non-vacuity: the 404 test drives the real component through the real mutation;
if `submitCorrection` reverted to throwing, the red branch would render and both
`not.toHaveTextContent(/still in place/i)` assertions would fail.

Both green (25/25 across `SuppressionsClient.test.tsx` + `contacts-ui.test.tsx`).

---

## F-2 — raw handle in the URL · ADDRESSED

### No GET path still accepts the handle

`rg "export (async function|const) (GET|PUT|PATCH|DELETE)" src/app/api/admin/suppressions/`
returns **nothing** (exit 1). The old handler was deleted, not shimmed — the
diff removes the whole `export async function GET` block from
`src/app/api/admin/suppressions/route.ts` and leaves a header comment pointing
at the replacement. There is no redirect, no re-export, no compatibility path.

### The client is fully migrated

`SuppressionsClient.tsx:91-99` is the only lookup call site and posts a JSON
body. The only other `fetch` targets are `/api/admin/suppressions` (entry, POST,
body) and `/api/admin/suppressions/correct` (POST, body). The stale
`detail="GET /api/admin/suppressions failed"` string in the `ErrorState` was
also updated, so the UI does not describe a route that no longer exists.

Pinned by `SuppressionsClient.test.tsx:250-270` — *"sends the looked-up address
in the request body and never in the URL"*: it greps **every** captured request
URL for `person@example.com|person%40example` (so a regression on any of the
three endpoints fails, not just the lookup), then asserts method `POST` and
`body === { email: 'person@example.com' }`.

### AAL2 + same-origin + strict validation all survived

`src/app/api/admin/suppressions/lookup/route.ts`:

| Control | Where | Test |
|---|---|---|
| AAL2 | `requireAdminWithAal2` at `:52`, before any body read | `route.test.ts:105-117` — the "requires admin AAL2 on every suppression admin route" test now imports `../lookup/route` and includes it in the three-route array |
| same-origin | `export const POST = withSameOrigin()(lookup)` at `:96` — **stronger than round 1**, where the GET had none | `route.test.ts:247-263` — 403 from a foreign origin, and `mockRequireAdminWithAal2` asserted *not* called |
| strict validation | `z.strictObject({ email: z.string().trim().min(1).max(320) })` at `:32-34`, plus a JSON-parse guard | `route.test.ts:323-341` — `''`, `'   '`, `{}`, and an unknown extra key all 400, and `mockLookupSuppressions` never called |
| wire-shape closure | `LOOKUP_ERROR_STATUS: Record<LookupFailure['error'], number>` at `:45-47` — adding an `ok:false` variant breaks typecheck | `route.test.ts:288-321` — asserts the 200 body has exactly `['corrections','handle','rows']` |

Two things this move improved beyond the finding: the response no longer
serialises the service union (`ok` stayed internal), and the entry/lookup/correct
acts are now three separate segments that share no handler and no schema.

Ordering check: the AAL2 gate is the first statement in the handler and
`withSameOrigin` wraps the export, so a cross-origin caller is refused before
the gate and the gate refuses before `request.json()` — the raw address never
reaches the service on an unauthenticated call.

---

## F-3 — mis-filed contract title · ADDRESSED

```
$ rg -F "global wins the display state when both a global and an account row match" src/
src/lib/solicitation/__tests__/suppression.integration.test.ts:574
```

**Exactly one occurrence in `src/`.** (Two further occurrences are the intake
copies and one is the plan's code block — none of them a test body.)

The test carrying it genuinely seeds a double match
(`suppression.integration.test.ts:574-606`): inside one rolled-back transaction
it writes an **account** row (`scope:'account'`, `accountId: accountId()`,
`source:'owner_manual'`) and then a **global** row (`scope:'global'`,
`accountId: null`, `source:'complaint'`) on the same `freshHandle()`, then calls
`matchSuppression(tx, handle, accountId())` and asserts
`hit.scope === 'global'` **and** `hit.source === 'complaint'` — the second
assertion is what proves both projected columns come from the same row, so a
fragment that mixed the global scope with the account row's source fails here.
Delete or reverse G3's `ORDER BY (s.scope='global') DESC` and this test fails;
that was the property round 1 said was missing.

The mapper unit test kept an honest title — *"renders whichever row the fragment
selected rather than re-deciding the scope"* — and its body was strengthened to
assert both directions (`global` and `account`), with a comment stating outright
that no double match can be constructed at that seam. No title now over-claims.

Green: `suppression-display.test.ts` and `suppression.integration.test.ts` both
pass (49 tests across the five live-DB suites, run with
`TEST_DATABASE_POOL_URL` exported; verbose run confirms they execute rather than
skip).

---

## D-A11 re-check — did the schema change break the contract?

### Invariant #8 / §7.4 — do the new columns reach an owner-facing surface? · **NO**

Complete reader set for `solicitation_suppression_corrections` (grep over the
whole repo, excluding docs):

| Reader | Projection | Surface |
|---|---|---|
| `src/lib/admin/suppressions-service.ts:96-106` (`lookupSuppressions`) | `id, suppression_id, scope, source, removed_by_user_id, reason, created_at` — **none of the three new columns** | `/admin/suppressions`, behind `requireAdminWithAal2` |
| `src/lib/admin/suppressions-service.ts:205-222` (`correctSuppression`) | write-only `INSERT`, `RETURNING suppression_id` | admin route |
| `src/lib/account-offboarding/purge-verification.ts:679-687` | `COUNT(*)` only | worker-side purge verification |

The DTO `AdminSuppressionCorrectionRow`
(`suppressions-service.ts:38-46`) is a closed seven-key interface that omits
`account_id`, `created_by_user_id` and `note`, so the client physically cannot
render them. **The new columns reach no surface at all — not even the admin
one.** Invariant #8 concerns owner-facing exposure and is untouched; the round-1
justification ("corrections carry no `account_id`") is superseded by a stronger
one (the projection excludes it).

The §7.4 owner seam is likewise unaffected: `listContacts` →
`readPageSuppressionScopes` (`contacts-repo.ts:64-88`) selects only
`h.handle, suppression.scope`, and `toSuppressionDisplay` still returns the
closed four-key display object. The three tests that pin this
(`never exposes the account_id provenance of a global row to an owner`,
`never renders another account name on a suppressed contact`,
`shows an opted-out contact as opted out and offers no way to undo a global row`)
are all green after the contacts-repo refactor.

### All eighteen `tests_to_add` titles still exist verbatim · **YES, 18/18, one occurrence each**

Verified by exact-string count over `src/**/*.{ts,tsx}`:

| Count | Title |
|---|---|
| 1 | records a global admin_manual row with created_by_user_id and the required note |
| 1 | rejects an address that fails normalizeEmail instead of minting a wrong handle |
| 1 | is idempotent against the global partial unique index — a repeat admin entry writes no second row |
| 1 | deletes the suppression row and writes the correction record in the same transaction |
| 1 | rolls back the delete when the correction record write fails |
| 1 | corrects a global row whose account_id is NULL |
| 1 | reports not-found instead of writing an orphan correction record when the row is already gone |
| 1 | requires admin AAL2 on every suppression admin route |
| 1 | writes an owner_manual account-scoped row for the caller's own account |
| 1 | refuses an owner do-not-contact on a contact with no email handle |
| 1 | refuses to clear a global row through the owner path |
| 1 | clears only the account row owned by the caller's account, leaving a matching global row in place |
| 1 | returns a uniform 404 for a contact belonging to another account |
| 1 | reports a suppressed contact as opted out of RepWorth review requests, never as skipped |
| 1 | never exposes the account_id provenance of a global row to an owner |
| 1 | distinguishes the owner's own account row from a global one, because only the former is reversible |
| 1 | global wins the display state when both a global and an account row match |
| 1 | invariant: every scope and source pair maps to exactly one display state and never carries account_id |

Note the AAL2 title's meaning **grew** rather than shrank: "every suppression
admin route" now covers three routes (`lookup/`, entry, `correct/`) instead of
two-plus-a-GET, and the test body was extended to match.

Two new integration tests were added for the D-A11 evidence columns —
*"the correction record keeps the admin_manual entry creator and originating
message reference"* and *"the correction record keeps the account_id of an
account-scoped owner row"* — so the schema change is not merely present but
pinned.

### `allowed_edit_surface` · **one file outside, fairly characterised**

Re-read from `.feature/intake.json` on disk (23 entries; amendment #2 added
`src/lib/account-offboarding/**` and `scripts/ci/tenant-tables.ts`, and the
`docs/superpowers/plans/…-intake.json` mirror carries the same two).

Of the 48 files changed since the fork point, exactly one falls outside:
`docs/security/rls-inventory.md`.

**The D-A11 addendum's characterisation is fair.** `scripts/ci/__tests__/rls-audit.test.ts:45-48`
is literally:

```ts
const inventoryDoc = readFileSync('docs/security/rls-inventory.md', 'utf8');
for (const table of TENANT_TABLES) {
  expect(inventoryDoc).toContain(`| \`${table}\` |`);
}
```

So adding the table to `TENANT_TABLES` — the act the owner authorised — makes
that suite red until a doc row exists. The change is one markdown table row, it
encodes no design decision the owner did not already approve, it was disclosed
rather than hidden, and treating it as amendment #3 would fire teardown on
bookkeeping. I concur with counting it inside amendment #2, and with the note
that the budget remains 2 of 2.

### §8.2 atomicity after the CTE gained three columns · **HOLDS**

`correctSuppression` (`suppressions-service.ts:199-226`) is still **one
statement**: a single data-modifying CTE whose `DELETE … RETURNING` feeds the
`INSERT … SELECT … FROM removed`. No `sql.begin`, no second round trip, no
read-then-write.

Column alignment checked by hand — twelve INSERT columns against twelve SELECT
expressions, in order:

| # | INSERT column | SELECT expression |
|---|---|---|
| 1 | `id` | `${uuidv7()}` |
| 2 | `suppression_id` | `removed.id` |
| 3 | `channel` | `removed.channel` |
| 4 | `normalized_handle` | `removed.normalized_handle` |
| 5 | `scope` | `removed.scope` |
| 6 | `account_id` | `removed.account_id` |
| 7 | `source` | `removed.source` |
| 8 | `suppressed_at` | `removed.suppressed_at` |
| 9 | `created_by_user_id` | `removed.created_by_user_id` |
| 10 | `note` | `removed.note` |
| 11 | `removed_by_user_id` | `${input.adminUserId}::uuid` |
| 12 | `reason` | `${input.reason}` |

No transposition (`account_id`/`created_by_user_id` are both nullable UUIDs and
would not have been caught by types alone — but they sit in non-adjacent
positions and the two new integration tests assert their values, not just their
presence).

The three new columns are all NULLable in migration 098, so adding them cannot
introduce a new abort path that would fail the INSERT where the DELETE
succeeded. `rolls back the delete when the correction record write fails` and
`two concurrent corrections remove one suppression and write exactly one
correction record` both still pass against the live DB.

The tenant-scope allowlist snippet was updated in lockstep (the audit keys on
normalised SQL, the D-A5 lesson) and hoisted to a shared const so the
two-table attribution cannot drift.

---

## Gate evidence (re-run at review time, in the worktree)

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `ci:tenant-scope` | pass — 420 entries / baseline 420 (D-A11's one new entry, baseline bumped in the same commit) |
| `ci:rls-audit` | pass — 43 tenant tables (was 42; the new table is inventoried) |
| `ci:static-policy` | pass (1080 files) |
| `ci:db-imports` | pass (strict) |
| `ci:outbox-seam` | pass |
| `ci:live-db-suites` | pass |
| unit/route/component (26 files) | 168/168 pass |
| `scripts/ci/__tests__` + `eslint-boundaries` + `ci-audit-wiring` (27 files) | 656/656 pass |
| live-DB suites w/ `TEST_DATABASE_POOL_URL` (5 files) | 49/49 pass (verbose run confirms executed, not skipped) |

Local test DB was already provisioned with the post-D-A11 shape (`\d` confirms
`account_id`, `created_by_user_id`, `note` present), so `assertSchemaReady` had
something real to assert.

---

## Appendix: new, untriaged

Recorded per the round-2 remit. **None of this affected the verdict above**, and
none of it was hunted for — each was noticed while verifying something else.

**N-1 · `ERROR_COPY` is a plain object literal, so `errorSentence` can return an
inherited `Object.prototype` member.** `ERROR_COPY[code] ?? fallback`
(`SuppressionsClient.tsx:70`) resolves `code === 'constructor'` or `'toString'`
to a function rather than falling through to the fallback, which would then be
stringified into an `Error` message. **Not reachable today**: the only source of
`code` is a server response, and the three routes emit a closed set
(`invalid_handle`, `invalid_body`, `not_found`, `mfa_required`,
`mfa_check_failed`, `internal_error`, `invalid_request`) or a zod issue message,
none of which are prototype keys. A one-word fix (`Object.hasOwn` or a
null-prototype map) if anyone wants it hardened. Below the reporting bar; noted
because it lives in code the F-1 fix introduced.

**N-2 · `mfa_check_failed` has no `ERROR_COPY` entry.** It falls back to
`"<Act> failed (403)"`, which is a sentence rather than a token, so the fix's
stated property holds. Cosmetic gap only.

**N-3 · The plan doc still describes the deleted GET.**
`docs/superpowers/plans/2026-08-03-645-manual-suppression-paths.md:47` and
`:1644` still say `GET /api/admin/suppressions?email=…`. `CONTEXT.md`,
`docs/directory.md` and `.claude/reference/migrations-log.md` **were** resynced
(commit `efe15be4`), and the deviations file records the change, so the
authoritative layer is correct; the plan is a historical artifact. Flagging only
because a future reader grepping for the endpoint hits the plan first.

**N-4 · The corrections wire projection is not pinned by a test.**
`AdminSuppressionCorrectionRow` deliberately omits `account_id`,
`created_by_user_id` and `note`, and that omission is now load-bearing (it is
why D-A11's columns reach no surface). Nothing asserts it — a future widening of
the interface would be caught by no test. Admin-only surface, so not an
invariant-#8 exposure today; a `Object.keys(...).sort()` assertion on the
corrections rows would close it the way `route.test.ts:305` already closes the
200 body shape.

**N-5 · `readPageSuppressionScopes` adds a third round trip to `listContacts`.**
The §7.4 probe moved out of the page query into a separate handle-keyed query
(commit `4c157435`) with a documented performance rationale. Correctness is
equivalent — handles are already normalized, the map is keyed on the same
`c.email` value, and `suppressionMatchSql` is still the single composed
predicate (G7) — and all owner-facing suppression tests pass. Sequencing, not
`Promise.all`, so it is one extra serial round trip per page render. Design-axis
territory; recorded, not judged.

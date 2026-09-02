# Review — SECURITY / AUTHORIZATION and DATABASE / TENANCY

- **Worktree**: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1014-restraint-tab`
- **FORK**: `b55b07822ef92f6c85047e6f42b5513ea8427257`
- **HEAD reviewed**: `3716d2530251b2ab6f48d1a53023e4bc82393b76` (every citation read via `git show <SHA>:<path>`; the working tree was never read)
- **Axis**: trust boundaries, token handling, confused-deputy paths, server/client authority, denial and replay; tenant predicates, transaction boundaries, locks, retries, partial application.
- **Scope of change**: 25 files, +5,987/−10. Production surface under review: `src/lib/refusals/read.ts` (new, 385 lines), `src/app/api/dashboard/refusals/route.ts` (new, 74 lines), `src/components/dashboard/restraint/*` (new), `src/app/api/dashboard/policy.ts` (unchanged by this branch), `src/components/dashboard/shell/DashboardStatePanel.tsx` (extended).

---

## ACTIONABLE FINDINGS

| id | severity | file:line | violated boundary | evidence | exploit / failure scenario |
|---|---|---|---|---|---|
| **ST-1** | **Medium** | `src/lib/refusals/read.ts:261-322` (both entry arms), `:368` (`total: entries.length`) | The #773 admission chokepoint's stated contract — the Postgres pool is **per Fluid Compute isolate and shared across every tenant's overlapping requests** (`src/lib/db/admission.ts:1-30`). An unbounded per-tenant scan on that pool is a cross-tenant availability hazard. Also migration 116's own stated revisit condition. | Neither entry query carries a `LIMIT`, an `OFFSET`, or any cap; `total` is `entries.length`, so every matching row is serialised and shipped. The write path documents the volume it feeds this read: `src/lib/refusals/write.ts:469-473` — "`ask_withheld` is the **highest-volume lane** in the ledger: `loadCandidateWindow` bounds a batch's evaluated cohort at `MAX_DATA_ROWS` (5,000 …) and a rebuild re-evaluates the whole accumulated pool, so a build in which every candidate fails an individual mapped gate proposes **5,000 Refusals at once**"; same claim at the call site, `src/lib/solicitation/batch-builder.ts:655-660`; `src/lib/solicitation/contacts-csv.ts:22` `MAX_DATA_ROWS = 5000`. Max window is 90 days (`src/lib/kpi/types.ts:14`) against 180-day retention. Migration 116's index comment: "No `business_id` index: … **Revisit if one account's window ever holds enough rows** that filtering locations in memory shows up in the tab's latency" — the ask lane's own documented capacity already meets that condition. | An owner running a weekly solicitation rebuild over a 5,000-contact pool accumulates ~65k `ask_withheld` rows in a 90-day window. `GET /api/dashboard/refusals?scope=all&window=90d` returns **all** of them: a full sort past the `(account_id, occurred_at DESC)` index (the `, r.id DESC` tiebreak forces it), a multi-MB JSON body, and one admission slot held for the whole scan. `RestraintContent.tsx:36-39` re-issues the query on every scope/window change, so a normal user clicking through 4 windows × N locations issues that scan repeatedly. Because the pool is per isolate and the isolate serves other tenants' requests concurrently, one account's Restraint tab degrades unrelated tenants' dashboard reads. The client then renders one `<li>` per row (`RestraintReport.tsx:348`), so the browser tab is the second victim. Fix direction: `LIMIT` + a separate `COUNT(*)` for `total`, and a "showing the most recent N" sentence — the surface already owns a vocabulary for stating what it is not showing (`archivedFootnote`). |
| **ST-2** | **Low** | `src/lib/refusals/read.ts` (no flag read anywhere in the file) + `src/components/dashboard/restraint/RestraintReport.tsx:150-152` (`emptyLine`) and `:45-53`/`:57-72` (route payload) | The surface's own disclosure rule, stated in this branch: `read.ts:209-214` — "that is the **false zero** this whole surface exists to avoid"; `RestraintReport.tsx:136-139` `policyGateLine` exists *precisely* to disclose one silent lane, and covers `AUTO_APPROVAL_ENABLED` **only**. | The ledger has a kill switch the read does not know about: `src/lib/refusals/write.ts:80` `REFUSAL_LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED'`, read **live per call inside the body** of both write arms (`write.ts:369`, `write.ts:512`) — when off, both return without inserting and only emit a warn. `read.ts` imports nothing from `@/lib/config/flags` or `@/lib/refusals/write`; the route ships exactly one flag (`route.ts:53,57,72`). #1002 decided there is **never a backfill**, so rows missed while the switch is off never arrive. | Ops flips `REFUSAL_LEDGER_ENABLED=false` to stop a mis-mapped-category writer bug — the exact use the switch was built for (`src/lib/solicitation/batch-builder.ts:669` — "the lever is the helper's own kill switch"). From that moment every owner's Restraint tab renders `emptyLine`: *"We did not hold anything back between &lt;start&gt; and &lt;end&gt;."* That is a false statement of restraint on the one surface whose entire value is being trustworthy, it persists for the life of the window (up to 90 days after the switch is restored), and the page carries **no** operator signal. The `policyGateLine` precedent shows the correct shape: ship a second server-read boolean and render a "one kind of decision is not being recorded right now" sentence. |

**No tenancy finding.** The scoping on this branch is correct in all six statements, defended at two independent layers, and the answers below carry the trace.

---

## ANSWERS

### Q1 — Can any caller reach another account's rows? Trace `accountId` from the session to every SQL predicate. Is there any path where it is attacker-controlled?

**VERDICT: No. `accountId` is never attacker-controlled, and all six statements bind it.**

Origin (single source): `src/lib/db/auth.ts:62-95` — `cookieBackedServerClient(request).auth.getUser()` (server-validated against Supabase Auth on every call, deliberately not `getSession()`), then `SELECT u.id, u.name, u.email, u.role, u.account_id … FROM users u WHERE u.auth_id = ${authUser.id} LIMIT 1`. `accountId` is `row.account_id`. No request field — header, query, body or cookie — contributes.

Chain: `requireRole(request,'owner')` (`auth.ts:113-121`, exact role match) → `requireRoleOr401` (`route-helpers.ts:85-97`, `AuthError` → typed response, anything else re-thrown as 5xx) → `requireOwnerWithAccount` (`route-helpers.ts:110-119`, 403 when `accountId` is null) → `withDashboardOwnerRead` (`policy.ts:65-81`, auth runs **outside** the try so an auth-infrastructure failure cannot be masked as a data error) → `route.ts:48` destructures `{ user, accountId }`.

Consumption — the route reads no other identity input. There is no `?accountId=` read on this path (`requireSettingsOwner`'s explicit `account_id_not_allowed` rejection is a different gate and is unnecessary here because nothing reads the parameter).

Every statement in `read.ts`:

| # | statement | line | account binding |
|---|---|---|---|
| 1 | coverage, location arm | `:216-221` | `b.account_id = ${scope.accountId}` |
| 2 | coverage, account arm | `:222-227` | `a.id = ${scope.accountId}` |
| 3 | entries, location arm | `:268-289` | `r.account_id = ${scope.accountId}` **and** `b.account_id = ${scope.accountId}` in the EXISTS |
| 4 | entries, account arm | `:299-322` | `r.account_id = ${scope.accountId}` **and** `b.account_id = ${scope.accountId}` in the EXISTS |
| 5 | archived footnote | `:334-346` | `r.account_id = ${scope.accountId}` **and** `b.account_id = ${scope.accountId}` |
| 6 | archived periods | `:352-359` | `l.account_id = ${scope.accountId}` |

All bindings are postgres.js template parameters, never interpolated text. No `SELECT *`. Cross-tenant isolation is additionally proven live: `read.integration.test.ts:423` "isolates one account's refusals from another account's in the same window".

### Q2 — `account_id = $1 AND (business_id = $2 OR business_id IS NULL)`: can a caller pass a foreign `businessId` and still get rows? What stops it, and is that stop inside the read or only at the route?

**VERDICT: No rows. Stopped at the route AND, independently, inside the read.**

`scopeParam` **is** attacker-controlled — `policy.ts:18-35` `resolveDashboardScopePolicy` copies `?scope=` straight into `locationId`. Three things stop it:

1. **Route (`policy.ts:94-134`)** — `isValidUuid` (400), `getLocationById` null (404), `location.account_id !== input.accountId` (404, `:121-126`), `location.archived_at !== null` (404, `:128-133`). `getRefusalLog` is not reached (`route.ts:60`; pinned by `refusals-route.test.ts` "rejects a request for a location outside the caller's account", which asserts `mockGetRefusalLog` was never called).
2. **Read, operator precedence (`read.ts:278-279`)** — `r.account_id = $1` is `AND`-ed **outside** the parenthesised OR. A foreign `$2` can therefore only ever match rows already restricted to the caller's account, of which none carry that `business_id`. The `IS NULL` disjunct admits only the caller's own account-wide `autonomy_suspended` rows, which is the intended behaviour (migration 116 C3, and the `businesses.business_id` column comment says so verbatim).
3. **Read, explicit ownership EXISTS (`read.ts:282-287`)** — `EXISTS (SELECT 1 FROM businesses b WHERE b.id = $2 AND b.account_id = $1 AND b.archived_at IS NULL)` zeroes the whole arm, account-wide rows included, for a foreign or archived `$2`. `b.account_id` is a real column of `businesses` (`scripts/ci/tenant-tables.ts` → `businesses: ['id','account_id']`), so this is a genuine binding and not the outward-resolution trap that file's comment warns about.

The stop is deliberately in both places, and it matters: `read.ts:262-267` documents the module as "a documented public seam" whose own test calls it directly, so "an invariant that only holds at the route is not an invariant of the read". The other two location-scope statements are safe for the same reason — the coverage query (`:216-221`) requires `b.account_id = $1`, and the archived-period query (`:352-359`) is keyed on `l.account_id = $1`.

### Q3 — Is the `uniform-not-found` 404 genuinely uniform for (a) foreign, (b) non-existent, (c) archived?

**VERDICT: Uniform in status, body and headers for all three; no usable timing oracle. One gap: no test pins the archived arm against the other two.**

- **Body** — all three call `errorResponse('Business not found', 404)`: `policy.ts:118` (non-existent), `:123` (foreign), `:130` (archived). Same string literal, same status.
- **Headers** — `errorResponse` → `jsonResponse` → `NO_STORE_HEADERS` (`route-helpers.ts:41-56`; `src/lib/shared/constants.ts:12` `{'Cache-Control':'no-store, private'}`). Identical bytes on the wire: `{"error":"Business not found"}`.
- **Timing** — all three execute exactly one statement, `getLocationById` (`src/lib/locations/repo.ts:160`, a primary-key lookup), and then return. `getRefusalLog` is never called on any of the three, so no downstream work differentiates them. The residual difference is index-hit vs index-miss on a PK, which is not observable across a network at a useful signal-to-noise ratio.
- **Test coverage** — `refusals-route.test.ts` pairs foreign vs non-existent and asserts `absent.status === foreign.status` and an equal body. **The archived arm is not in that comparison.** The uniformity holds by construction (same literal in the source), but a future edit to `:130` would not be caught. Worth a one-line test extension; not a finding on its own.
- **Two deliberately non-uniform arms, neither an existence oracle**: a malformed `?scope=` returns **400** `Invalid scope: location must be a valid UUID` (`policy.ts:109-115`) *before* any DB read — that distinguishes "is a UUID" from "is not a UUID", which reveals nothing about another tenant; and a caller with no location at all gets **403** `No business associated with this account` (`policy.ts:100-106`), a fact about the caller's own account.

### Q4 — The archived-location footnote JOINs `businesses`. Can it leak a count for a location the caller does not own?

**VERDICT: No.**

`read.ts:334-346`:

```sql
FROM refusal_events r
JOIN businesses b ON b.id = r.business_id
WHERE r.account_id = ${scope.accountId}
  AND b.account_id = ${scope.accountId}
  AND b.archived_at IS NOT NULL
  AND r.occurred_at >= ${windowStart} AND r.occurred_at <= ${windowEnd}
```

Both sides of the join carry the account binding independently — the join column `b.id = r.business_id` is never load-bearing for tenancy. The statement runs in **account scope only** (`scope.kind === 'account'`), where `$1` is the session account and **no caller-supplied identifier appears in the statement at all**. `COUNT(DISTINCT r.business_id)` cannot fan out (`businesses.id` is the PK) and cannot count a foreign location because both predicates pin `$1`. Both window bounds are bound, so a writer-supplied `occurred_at` beyond the printed range cannot inflate the count (`read.ts:330-332`; pinned by `read.integration.test.ts:726`).

### Q5 — The archived-period query reads `account_audit_log` filtered by `account_id` AND `location_id`. Can it return another tenant's archive history?

**VERDICT: No.**

`read.ts:352-359`: `WHERE l.account_id = ${scope.accountId} AND l.location_id = ${scope.businessId} AND l.event_type IN ('location_archived','location_reactivated')`.

- `$1` is session-derived (Q1). `$2` has already cleared `resolveDashboardLocation`'s ownership check, and even an unchecked `$2` cannot escape `l.account_id = $1`.
- `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id)` (`supabase/migrations/034_multi_location_schema.sql:64`), so the binding is total — there is no NULL row that could slip the filter.
- Only two columns cross the boundary: an enum `event_type` and a `created_at`. `payload` (JSONB) and `actor_user_id` are never selected, so an admin actor's identity and any audit payload stay server-side.
- Worth noting for the audit story: `scripts/ci/tenant-tables.ts` lists `account_audit_log: ['account_id']` — `location_id` is **not** a recognised tenant-scope column, so `ci:tenant-scope` gives this statement credit for the account binding only. That is the correct reading; the account binding is the tenant proof and `location_id` is a within-tenant filter.

### Q6 — `subject_resolves` is a correlated `EXISTS` over `responses`, which has no `account_id`. Is the correlation sufficient? Can an attacker learn whether a response id exists under another account?

**VERDICT: Sufficient. No probe is reachable.**

`read.ts:271-276` / `:302-307`:

```sql
EXISTS (SELECT 1 FROM responses resp
        WHERE r.subject_type = 'response'
          AND resp.id = r.subject_id
          AND resp.business_id = r.business_id)
```

1. **The probed value is not attacker-supplied.** It is `r.subject_id`, a column of a row already restricted by the outer `WHERE r.account_id = $1`. No request parameter reaches the subquery. There is no shape of request that lets a caller choose which response id is tested.
2. **The correlation is strictly stronger than an id match.** `resp.business_id = r.business_id` means a response id that exists but hangs off a different location — or a different account — evaluates FALSE. Even a mis-written ledger row pointing at a foreign response cannot become an "exists" signal.
3. **`responses` carries only `business_id`** (`scripts/ci/tenant-tables.ts` → `responses: ['business_id']`), so that correlation is the only tenant binding available on that relation, and it is used.
4. **No NULL-comparison hole.** For `business_id IS NULL` rows the comparison would be `resp.business_id = NULL` (never TRUE), but that path is unreachable anyway: CHECK C3 makes `business_id IS NULL` ⟺ `autonomy_suspended`, and CHECK C1 forces that lane to `subject_type IS NULL`, so the first conjunct is already FALSE (`supabase/migrations/116_refusal_events.sql`, C1 and C3).
5. **The boolean is not even shipped.** It is consumed server-side by `resolveLinkKind` (`read.ts:117-127`, called at `:195`) and folded into `linkKind`; `subject_resolves` is absent from `RefusalLogEntry` (`read.ts:33-55`). Ceiling of disclosure: whether the caller's **own** response row still exists — and only as "the link is present or absent".

`read.ts:248-260` explains the `EXISTS`-not-`JOIN` choice in terms of `ci:tenant-scope`'s `scopedFromAncestor` rule. That reasoning is about making the audit able to *prove* the binding; the security property above holds regardless of what the audit can see.

### Q7 — Redaction: prove or disprove that `refusal_code`, `all_refusal_codes`, `refusal_source` and moderation prose cannot reach the response body, the error arm, or the logs.

**VERDICT: Proven for `refusal_code`, `all_refusal_codes` and moderation prose across all three sinks. `refusal_source` is absent as a field but is *inferable* from `subjectType` + `linkKind` — not an ADR 0023 breach, but the module's own comment overstates the guarantee.**

**Body.** The SELECT lists are the complete authority. Both entry arms select exactly `r.id, r.refusal_source, r.refusal_category, r.subject_type, r.subject_id, r.occurred_at` plus the derived boolean (`read.ts:269-276`, `:300-307`). The identifiers `refusal_code` and `all_refusal_codes` appear nowhere in any SELECT list in the file. No `SELECT *` in any of the six statements. `toEntry` (`read.ts:188-197`) builds the DTO field-by-field and **drops** `refusal_source` and `subject_resolves`; the route spreads only `...log` plus `window` and `autoApprovalEnabled` (`route.ts:57`, `:72`). `flagged_responses` — ADR 0023's one true prose column — is not named by any statement on this path. Pinned by `read.integration.test.ts:314` "never selects `all_refusal_codes`" and by the route test's deep body walk.

**Error arm.** `withDashboardOwnerRead` (`policy.ts:73-79`) catches everything and returns `errorResponse(options.errorMessage, 500)` — the fixed literal `'Failed to fetch refusals'` supplied at `route.ts:47`. The caught error is never mapped, spread, or stringified into a body. Independently of that: **no bound parameter on this path is prose.** The only values bound across all six statements are two UUIDs and two `Date`s, so a postgres.js error's `parameters` array cannot carry moderation text here even in principle, and its `query` text names only column identifiers.

**Logs.** `reportCaughtError(context, error, { accountId })` (`policy.ts:77`) → `createWorkerLogger(...).error('Caught handled error', context, error)` (`src/lib/shared/report-caught-error.ts:26-33`). `logger.ts` `serializeError` (`:35-47`) emits **only** `error_name` and `error_message` (plus `error_stack` on non-production lanes) — a postgres.js error's `query` / `parameters` / `detail` are own-enumerable properties this function never reads. The context object passes `sanitizeAnalyticsProperties`. Pinned by the route test's third redaction case, which asserts exactly one log record with `data === { accountId }`.

**Sentry.** `captureException(error, { tags: { endpoint } })`. `Sentry.init` (`src/instrumentation.ts:47-53`) enables **no** `ExtraErrorData` integration, so non-standard error properties are not serialised, and `beforeSend` runs `scrubSentryEvent(event, { scrubRequestData: true })`.

**Client.** `RestraintContent.errorMessageOf` (`:97-101`) renders `body.error` verbatim into the panel — safe because the only bodies this route can produce are four fixed literals (`'Failed to fetch refusals'`, `'Business not found'`, `'Invalid scope: …'`, `'No business associated with this account'`, plus the auth gate's `'Unauthorized'`/`'Forbidden'`).

**The one qualification.** `refusal_source` is not a DTO field, but `subjectType` **is** (`read.ts:39`), and CHECK C1 makes `subject_type` a near-inverse of the lane: `solicitation_ask`→`ask_withheld`, `solicitation_outreach`→`outreach_withheld`, `solicitation_batch`→`batch_halted`, `NULL`→`autonomy_suspended` are each 1:1; only `'response'` is three-way ambiguous, and `linkKind:'review'` narrows that to `held_draft` (`resolveLinkKind`, `read.ts:118`). So an account's own owner can reconstruct the lane for 4 of 7 sources exactly and for a 5th via the link. ADR 0023 §5 classifies only `all_refusal_codes` as non-owner-facing (and §1 the prose); it does **not** classify the lane that way, so this is not a boundary breach. But `read.ts:8-11` — "`RefusalSource` is imported for `EntryRow` and `resolveLinkKind` ONLY … never placed on a DTO field" — is true of the *field* and false of the *information*, and the route's docstring inherits that overstatement. Correct the comment; do not remove `subjectType`.

### Q8 — Is anything about the auto-approval flag leaked beyond the single boolean the payload carries?

**VERDICT: No.**

- The route reads `autoApprovalRuntimeEnabled()` (`route.ts:2`, `:53`), which is `readFlag('AUTO_APPROVAL_ENABLED')` (`src/lib/auto-approval/flags.ts:3-5`), and ships it as `autoApprovalEnabled: boolean` (`route.ts:57`, `:72`). Nothing else: no policy row, no threshold, no daily cap, no rating band, no veto-window length, no `auto_approval_policies` read anywhere on this path (invariant #14 intact).
- `getRefusalLog` stays flag-blind — `read.ts` imports nothing from `@/lib/auto-approval` or `@/lib/config/flags`. That keeps the read table-testable and keeps flag authority in the composition root.
- Invariant #13 satisfied: server-read, delivered in an API response, no `NEXT_PUBLIC_*` companion. The route test greps the route source for `NEXT_PUBLIC_` and asserts absence, and asserts the value is a real `boolean` (not the truthy string `'false'`).
- What the boolean *does* disclose: `AUTO_APPROVAL_ENABLED` is a **global** server flag, not per-account, so the payload tells every owner the platform-wide posture of the autonomy kill switch. Low sensitivity — the Copilot/Autopilot split already makes that posture owner-visible — and not a tenancy leak.
- Accuracy caveat for the correctness axis (not a security finding): `policyGateLine` (`RestraintReport.tsx:136-139`) renders *"It is off **for your account** today"* from a global flag, and renders **nothing** when the flag is on but the account lacks Autopilot — in which case `policy_gate_held` is still silent for that account (invariant #3: auto-policy approval requires `tierGrantsAutopilot`) and the owner is not told. See Appendix A6.

---

## NON-ACTIONABLE APPENDIX

**A1 — Two of the three link targets are dead routes (correctness axis, no security impact).** `hrefFor` (`RestraintReport.tsx:102-112`) emits `/dashboard/reviews/${subjectId}` and `/dashboard/contacts`. Neither route exists at this SHA: under `src/app/(authenticated)/dashboard/reviews/` there is only `page.tsx`, `history/` and `[reviewId]/timeline/` — no `[id]` segment; contacts live at `src/app/(authenticated)/dashboard/requests/contacts/page.tsx`. Compounding it, `held_draft`'s `subject_id` is a **response** id (migration 116 C1, and `worker/jobs/response-generation/persist.ts` passes `responseId`), so even a `/dashboard/reviews/[reviewId]` route would receive the wrong identifier. This is the one affordance ADR 0023 grants the owner and it 404s. No security angle: `encodeURIComponent` plus a fixed literal prefix rules out traversal and scheme injection, and `next/link` cannot be coerced into a `javascript:` href from this shape. Flagged here for whichever axis owns correctness.

**A2 — `refusal_source` is inferable from the payload.** See Q7's qualification. Documentation fix, not a code fix.

**A3 — Read consistency: six statements, six snapshots, no transaction.** `getRefusalLog` issues its statements sequentially with no `sql.begin()`. A location archived between the entry query and the footnote query produces a mildly inconsistent page for one render. This is read-only work with no partial application and nothing to lock; a transaction would buy consistency at the cost of holding an admission slot across all six round trips. Correct as written. (Also correct on the fan-out rule: the six statements are strictly sequential `await`s, not a `Promise` combinator, so `ci:pool-fanout`'s concern does not arise even though `src/lib/refusals/` is outside its watched roots.)

**A4 — The archived-period query has no window bound and no covering index.** `read.ts:352-359` reads the location's **entire** archive history (all time), filtering to the window in JS via `pairArchivedPeriods`. `account_audit_log`'s indexes are `(account_id, created_at)` and `(event_type, created_at)` (`034_multi_location_schema.sql:75-79`); neither covers `location_id`, so this scans every audit row for the account and filters two predicates in memory. Volume is genuinely low today (archive/reactivate events are rare) and the unbounded read is *deliberate* — `pairArchivedPeriods` needs a leading `location_archived` that may predate the window. Noted so a future reader does not mistake the omission for an oversight; it grows with account age and never resets.

**A5 — `subject_resolves` is computed and discarded for two lanes.** The correlated `EXISTS` runs for every `subject_type='response'` row, but `resolveLinkKind` (`read.ts:118`) consumes it only when `source === 'held_draft'`. `auto_post_revoked` and `policy_gate_held` rows pay for a subquery whose result is dropped. Micro-perf; not worth branching for.

**A6 — `policyGateLine` claims a per-account fact from a global flag, and is silent on the tier gate.** See Q8's caveat. Correctness/trust axis.

**A7 — Impersonation is not a confused-deputy path here. No finding.** `getCurrentUser` reads only the Supabase auth cookie (`src/lib/db/auth.ts:64-68`); `IMPERSONATION_COOKIE_NAME` is never consulted on this path, so the cookie cannot redirect the resolved account. The route test exercises the **real** gate (`useRequireRoleMock.value = false`) with the cookie set and asserts the admin account never reaches `getRefusalLog`, plus a negative arm (no session → 401, no read). Separately, `src/lib/admin/impersonation/guard.ts` allowlists `view_dashboard`, so an impersonated Restraint read would be in policy regardless.

**A8 — Subscription guard is correct by omission. No finding.** Reads stay open to `past_due`: `requireOwnerWithAccount` (`route-helpers.ts:110-119`) deliberately does not apply the writable-subscription gate, which invariant #11 reserves for mutations. Pinned structurally — the route test asserts the source names `withDashboardOwnerRead` and names none of `requireWritableOwner` / `assertWritableSubscription` / `subscriptionGrantsFullAccess` / `subscription_status`.

**A9 — Caching and CSRF. No finding.** `export const dynamic = 'force-dynamic'` (`route.ts:41`) and `Cache-Control: no-store, private` on every response, success and error alike, so a per-tenant payload cannot land in a shared cache. No `withSameOrigin` wrapper, correctly: the route is a side-effect-free GET, Next adds no CORS headers, so a cross-origin page can issue the request but cannot read the response.

**A10 — What `ci:tenant-scope` proves here, and what it does not.** It **does** cover this table: `refusal_events` is the last entry in `TENANT_TABLES` with `TENANT_SCOPE_COLUMNS['refusal_events'] = ['account_id','business_id']` and a comment naming this exact predicate shape (`scripts/ci/tenant-tables.ts`), so every query block naming the table must carry a bound predicate on one of those columns, and `scripts/ci/__tests__/tenant-tables.integration.test.ts` asserts both columns against `information_schema` at migrations head. That is why `read.ts:256-260` spells both arms out literally instead of composing a shared fragment — the audit reads query *blocks*. It **does not** prove: (i) that the value bound to `$1` is the session's account — the check is syntactic over template text, and `sql\`… account_id = ${anything}\`` passes it; (ii) anything about `location_id` on `account_audit_log`, which is not a recognised tenant column; (iii) column-level redaction — it never inspects SELECT lists, so it says nothing about `all_refusal_codes`; (iv) the route-level ownership check in `resolveDashboardLocation`. A green `ci:tenant-scope` plus a green `ci:rls-audit` still leaves application scoping and application redaction as the entire access control, exactly as ADR 0023 states. The proofs in Q1–Q7 above are the trace those audits cannot supply.

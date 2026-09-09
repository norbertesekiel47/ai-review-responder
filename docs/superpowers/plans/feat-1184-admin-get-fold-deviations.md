# feat/1184-admin-get-fold — deviations

Entries are things the plan did not anticipate, or a locked expectation the
tree falsified. Every entry carries a **Verdict:** ACCEPT or RE-PLAN before the
review wave (`/feature` step 6).

---

## D1 — Surface amendment #1: one test file for the new shim

**What.** `src/lib/auth/__tests__/admin-gate-mocks.test.ts` was added to
`allowed_edit_surface` after the plan-skeptic round.

**Why.** Plan-skeptic finding 5: the shared shim needs its own suite, and the
anti-vacuity pin (the nine folded suites must not mock
`@/lib/auth/admin-mfa-gate`) needs somewhere to live. `vitest` only collects
`*.test.ts`, so the helper's tests cannot be colocated inside the helper file.

**Authority.** Auto-approved by the step 2 rule — one file, inside
`src/lib/auth/__tests__/`, a tree the surface already reaches. Counted:
`surfaceAmendments=1`. A second amendment is a hard stop for this run.

**Verdict:** ACCEPT

---

## D2 — `/admin/businesses/[id]`'s recorded `aal2: false` reason is falsified

**What.** The audit header (`scripts/ci/admin-aal2-audit.ts`, "WHAT P2 IS
DELIBERATELY NOT") and the page's own comment both record
`/admin/businesses/[id]` as deliberately `aal2: false`, reasoned as "Gate parity
with GET /api/admin/businesses/[id] — plain admin role, no AAL2". Folding that
GET onto `requireAdminWithAal2` makes the sentence false.

**Why it is not a re-plan.** The orchestrator's brief anticipated exactly this:
keep the anchor at `aal2: false` ONLY if its recorded reason still holds, and
otherwise follow rule P2 and record the flip. The reason does not hold, so the
page flips with the other five. P2 itself is unchanged — it was always parity,
never "pages hosting mutations need AAL2", and the header still teaches that,
restated so it no longer cites a page that is now AAL2.

**Verdict:** ACCEPT

---

## D3 — The transport knob in the first shim draft

**What.** The plan's first shim API exposed `gateTransport: { current }` so a
suite could declare bearer mode. Replaced by deriving transport from the request
through the production `isBearerRequest`.

**Why.** Plan-skeptic finding 4: `requireAdminWithAal2` reads only `authUserId`
and `aal`, so a knob-driven "bearer ok" test asserts nothing the cookie test
does not. Deriving from a real `Authorization` header makes the per-route bearer
case a genuine transport test and keeps the predicate single-owner (ADR 0025 D6).

**Verdict:** ACCEPT

---

## D4 — BLOCKING: one collateral suite outside the surface, and it is amendment #2

**What.** `src/lib/admin/__tests__/denorm-queries.test.ts` imports the `costs` and
`notifications` GET handlers directly and mocks `@/lib/db/auth` with `requireRole`
and `AuthError` only. After the fold those handlers reach `requireAdminWithAal2` →
`resolveDualModeIdentity` → `cookieBackedServerClient`, which that mock does not
export, so three of its cases now fail:

```
[admin-mfa-gate] unexpected failure: Error: [vitest] No "cookieBackedServerClient"
export is defined on the "@/lib/db/auth" mock.
```

- `GET /api/admin/costs with account_id filter > queries api_costs WHERE account_id when account_id param is provided` — expected 200, got 500
- `GET /api/admin/costs with account_id filter > aggregates costs across all locations under an account`
- `GET /api/admin/notifications with account_id filter > queries notification_deliveries WHERE account_id when account_id param is provided` — expected 200, got 500

It is the ONLY red row in the tree. The gate at `8818cd33` reports
`Test Files 1 failed | 1063 passed | 99 skipped`, and every other row — lint,
typecheck, all 22 `ci:*` audits including `ci:admin-aal2`, build, `promised-tests`
(48/48) and all three `verification_commands` — is PASS.

**Why this is a stop and not a fix.** The file lives under `src/lib/admin/`, which
no `allowed_edit_surface` entry reaches, so it is not the auto-approved "≤2 files
inside a tree the surface already covers". It is surface amendment **#2**, and the
orchestrator's brief names a second amendment as a hard stop. The runner does not
self-authorize it.

**The fix, if approved — one file, ~15 lines, zero assertion changes.** Exactly the
migration the other 26 suites already took: spread `makeAdminGateMocks()` into the
existing `await vi.hoisted(async () => …)` block; add `loadAppUser: mockLoadAppUser`
and `cookieBackedServerClient: () => ({ auth: { mfa: {} } })` to the `@/lib/db/auth`
factory; add `vi.mock('@/lib/auth/mfa', …)` and
`vi.mock('@/lib/auth/verified-identity', …)`; set a passing `mockRequireRole` and
`mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true })` in `beforeEach`.
The three cases then assert the same SQL shapes they assert today.

**No production change can avoid it.** The suite does not mock
`@/lib/auth/verified-identity` at all, so the only alternatives are editing it or
weakening the gate, and the second is not on the table.

**Owner decision 2026-09-08: APPROVED.** Recorded as `surfaceAmendments=2` with the
reason "owner-approved 2026-09-08: migrate denorm-queries.test.ts onto the shared
gate shim (test-only)". Applied exactly as described — the six cases pass and every
assertion is unchanged. The full gate then went **GREEN at `0024a3a0`**.

**Verdict:** ACCEPT

---

## D5 — BLOCKING: `--review` diff-coverage wants a test for the six page flips

**What.** The plain gate is GREEN at `0024a3a0`. The REVIEW gate
(`scripts/verify-gate.sh --review`, the one step 7 requires) adds a
`diff-coverage` row and it is the single FAIL:

```
diff-coverage: 18/24 added instrumented lines covered (75.0%, min 80%)
Uncovered:
  src/app/admin/businesses/[id]/page.tsx: uncovered added lines 38
  src/app/admin/businesses/page.tsx:      uncovered added lines 22
  src/app/admin/costs/page.tsx:           uncovered added lines 24
  src/app/admin/jobs/page.tsx:            uncovered added lines 17
  src/app/admin/notifications/page.tsx:   uncovered added lines 17
  src/app/admin/overview/page.tsx:        uncovered added lines 16
```

Every uncovered line is one page's `await requireAdminPage(sql, { …, aal2: true })`.
No admin server page has an executing test in this repo — the three suites that
touch these files (`page-source`, `page-chrome`, `console-admin-palette`)
`readFileSync` them, which produces no line coverage — so the P2 flip is currently
proven by `ci:admin-aal2`'s SOURCE parse and by e2e, and by nothing that runs.

**Why this is a stop.** Closing it means one new test file, and the edit-surface
guard refused it:

```
BLOCKED: 'src/app/admin/__tests__/page-aal2-parity.test.tsx' is outside the intake
contract's allowed_edit_surface. … amend .feature/intake.json WITH user sign-off
```

That is surface amendment **#3**. The step-2 clause "≤2 files inside a tree the
surface already covers" arguably reaches it — six `src/app/admin/**` files are in
the surface — but the guard is the authority and it demands sign-off, so the runner
does not self-authorize.

**No zero-amendment path exists.** The six lines are in production pages that can
only be covered from a test file, and no test file in the surface can host them.
Padding the ratio with other covered lines, or raising `DIFF_COVERAGE_MIN`, would
be gaming the row rather than answering it.

**The fix, if approved — one new file, written and staged, ~170 lines.** It lives at
`/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/7e12995b-1d55-47e7-8d91-3b08229a9528/scratchpad/page-aal2-parity.test.tsx`
and is a straight copy into `src/app/admin/__tests__/page-aal2-parity.test.tsx`. It
calls each of the six page functions with `requireAdminPage`, `sql` and every
service mocked, and asserts three things a source parse cannot:
the exact options object each page passes (`{ from, aal2: true }` — `from` matters,
it is the `?from=` redirect target), that the gate is awaited BEFORE any data read
(these pages query `sql` directly, so a read that starts first is an un-stepped-up
read), and that a refused step-up stops the page instead of rendering. It is
strictly complementary to `ci:admin-aal2`'s static P2 check, not a duplicate of it.

**Verdict:** _pending owner decision_

---

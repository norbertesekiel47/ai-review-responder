# Spec & correctness review — `fix/portal-audit-pr1-correctness`

_Reviewer: spec-correctness agent · 2026-08-15 · read-only_
_Diff under review: `git diff $(git merge-base HEAD main)..HEAD -- src/` (17 files, docs ignored)_

## Verdict

**PASS.** Every `user_visible_behavior` item is implemented, all ten
`tests_to_add` titles exist and are non-vacuous, every `non_goal` is respected,
and no invariant is broken. Two low-severity findings, both about *records* of
the change rather than the change itself.

---

## Findings (≥80% confidence)

| Severity | file:line | Finding |
|---|---|---|
| Low | `src/lib/config/server.ts:224` | The config schema's own comment still documents the divergence this PR closed — "`TELEGRAM_BOT_USERNAME`: admin `?? 'RepWorthBot'`, dashboard `?.trim() \|\| 'RepWorthBot'`". Spec §3.2 names this exact line as where the two guards sit "side by side without reconciling them"; the code was reconciled, the comment was not. |
| Low | `src/app/api/admin/channels/telegram/__tests__/start.test.ts:164-172` | `edge_cases[0]` names three inputs — unset, `''`, `'   '` — and only `''`/`'   '` are exercised. The mirrored owner suite has an explicit unset case (`src/app/api/dashboard/channels/telegram/__tests__/start.test.ts:117`); the admin mirror does not. Unset is correct by inspection (`undefined?.trim()` → `undefined` → fallback) but is neither exercised nor unreachable. |

Neither finding is a functional defect. Nothing at Medium or above was found.

Note on finding 1: `src/lib/config/server.ts` is **outside**
`allowed_edit_surface`, so fixing it in this PR needs a surface amendment. PR 2
(§4.4 — "makes it unspellable twice") rewrites this area anyway; deferring is
defensible, but the stale comment should not survive PR 2 either.

---

## 1. Contract fidelity (`.feature/intake.json`, field by field)

### `goal`
All four named defects are closed:

| Goal clause | Evidence |
|---|---|
| Owner sign-out dead end | `src/components/dashboard/shell/Sidebar.tsx:88` — `router.push('/login')`. `/login` = `src/app/(public)/login/page.tsx`, always-on (not gated by `SELF_SERVE_SIGNUP_ENABLED`), renders `AuthIslandClient initialMode="login"` with no `allowedRoles={['admin']}`. |
| Telegram blank-username divergence | `src/app/api/admin/channels/telegram/start/route.ts:24` now byte-identical to the owner route (`src/app/api/dashboard/channels/telegram/start/route.ts:73`). |
| Two self-contradicting DB fan-outs | `src/app/admin/businesses/[id]/page.tsx:31-32` (two awaits); `src/app/(authenticated)/settings/competitors/page.tsx:25-28` → `loadRivalPickerViews`. |
| Duplicated threshold labels | `src/lib/auto-approval/types.ts:15-23` is the single owner; both UIs call it. |

### `user_visible_behavior`
1. **Owner lands on `/login`** — implemented and test-pinned. ✓
2. **Admin Telegram deep link works when the var is blank/whitespace** — implemented; two tests fail under the old `??`. ✓
3. **No other observable behaviour changes** — verified:
   - Label strings are byte-identical to both prior spellings. `od -c` on the pre-change owner `THRESHOLD_OPTIONS`, the pre-change admin `thresholdLabel`, and the new `AUTO_APPROVAL_THRESHOLD_LABELS` all agree on `Off` / `5★ only` / `4–5★` (en dash U+2013, U+2605 star). The unmodified `AutoApprovalClient.test.tsx:120` still asserts `['Off', '5★ only', '4–5★']` and passes.
   - `loadRivalPickerViews` preserves array order (`for…of` push), so `CompetitorsClient`'s `views`↔`locations` index pairing is unchanged.
   - The admin page's `notFound()` gate is unchanged and still runs after both reads, so the 404 path behaves as before.

### `non_goals` — all respected
- `src/lib/auth/require-owner-access.ts` and `src/app/(authenticated)/layout.tsx` are **not in the diff**. `git log main..HEAD --name-only` confirms. Their `/admin/login` targets and `require-owner-access.test.ts:137,145` are untouched.
- The two `Record<AutoApprovalReadinessBlockReason, string>` maps are **not merged**: `BLOCK_REASON_COPY` (`AutoApprovalClient.tsx:37`) and `BLOCK_REASON_LABELS` (`AutoApprovalDiagnosticsPanel.tsx:11`) both survive with their own copy.
- The three §3.6 fixed-width fan-outs are **comment-only** changes — `git diff` shows no code line altered in `api/account/settings/route.ts`, `api/locations/add/route.ts`, `dashboard/add-location/page.tsx`.
- No channel-route unification, no Overview/Businesses reshape.
- No new env var, flag, or dependency (`package.json` not in the diff; `ci:static-policy` passes, so no new `NEXT_PUBLIC_*`).

### `allowed_edit_surface` — no drift
All 17 changed `src/**` paths fall inside a declared entry. No file outside the
surface was touched, and nothing is present in the diff that the contract does
not name.

---

## 2. `tests_to_add` — all ten exist, none vacuous

| Title | Location | Non-vacuity evidence |
|---|---|---|
| pushes /login after a successful sign out | `Sidebar.test.tsx:50` | asserts `push` called with `/login` **and** `not.toHaveBeenCalledWith('/admin/login')` |
| does not navigate when sign out fails | `Sidebar.test.tsx:61` | asserts the `Sign out failed` node renders (`Sidebar.tsx:151`) **and** `push` never called |
| does not navigate when sign out throws | `Sidebar.test.tsx:72` | same, via `mockRejectedValue` |
| falls back to RepWorthBot when …blank | `start.test.ts:164` | see below |
| falls back to RepWorthBot when …whitespace only | `start.test.ts:169` | see below |
| loads each location rival view sequentially | `named-rival.test.ts:289` | see below |
| issues no rival-view queries when …no active locations | `named-rival.test.ts:307` | `expect(sql).not.toHaveBeenCalled()` — cannot pass vacuously |
| keeps the admin business detail page free of Promise.all fan-out | `page-source.test.ts:20` | see below |
| keeps the competitors settings page free of Promise.all fan-out | `page-source.test.ts:15` | see below |
| maps every auto-approval threshold to its label | `threshold-labels.test.ts:8` | `toEqual({4,5})` is an exact-key check; adding a third union member forces both a TS error on the `Record` and a test failure |

All six touched test files pass: `6 files / 33 tests`. Wider related run:
`29 passed | 3 skipped (32 files)`, `298 passed | 25 skipped`.

### The Telegram tests are non-vacuous
They would pass regardless of `??` vs `||` only if the config layer collapsed
`''` to `undefined`. It does not: `TELEGRAM_BOT_USERNAME: rawOpt`
(`src/lib/config/server.ts:230`), and `rawOpt = rawOptionalVar`
(`server.ts:28`), which preserves `''`/`'   '` byte-for-byte. Under `??`, `''`
would yield `https://t.me/?start=…` and both new tests would fail their
`/^https:\/\/t\.me\/RepWorthBot\?start=/` assertion.

The helper's env seam is sound: `beforeEach` deletes `TELEGRAM_BOT_USERNAME`
then calls `resetServerConfigForTests()`, and `startWithBotUsername` sets the
value and resets again before `POST`, so the memo re-parses per test and there
is no cross-test bleed.

### The sequential-loading test genuinely detects fan-out
The spy reports in-flight status from inside `then`, not at call time, which is
the correct window for postgres.js's lazy thenables (`primaryTrackedKeywordSql`
builds a nested `Query` that is never awaited and therefore never counts).

I re-ran the spy's semantics against a 3-query-chain model in isolation:

```
sequential  maxInFlight = 1   (3 views)
Promise.all maxInFlight = 3   (3 views)
```

So `expect(maxInFlight).toBe(1)` fails on a `.map()` + `Promise.all`
implementation, and also fails if no query ran at all (it would be `0`). The
assertion is real in both directions.

### The `stripComments` regex cannot produce a realistic false PASS
This was the flagged highest-value attack surface. I ran the exact helper
against the two real page files plus a mutation that reintroduces the fan-out:

```
admin page   baseline contains Promise.all after strip: false
admin page   mutation (Promise.all reintroduced) survives strip: true   → DETECTED
competitors  baseline contains Promise.all after strip: false
competitors  mutation (Promise.all reintroduced) survives strip: true   → DETECTED
```

Adversarial line shapes:

| Input | Result |
|---|---|
| `await Promise.all([a, b]);` | DETECTED |
| `await Promise.all([a, b]); // fan out` | DETECTED |
| `const u = 'https://x'; await Promise.all([a, b]);` | DETECTED (the `[^:]` guard does its job) |
| `/* await Promise.all([a,b]); */` | stripped — **correct**, a commented-out call is not a fan-out |
| `const u = '//x'; await Promise.all([a, b]);` | MISSED |
| `const a = '/*'; await Promise.all([x]); const b = '*/';` | MISSED |
| `<img src="//cdn/x" /> ; await Promise.all([a]);` | MISSED |

Every miss requires a string literal containing `//` or `/*` **on the same
line** as a reintroduced `Promise.all`, in a 55-line and 45-line page that
contains no such literal today. The regex is sound enough for its job; I would
not stake a finding on the residual gap.

The admin test additionally asserts `expect(source).toContain('SEQUENTIAL')`
against the **raw** source, so the explanatory comment is required, not
forbidden — D4's fix is strictly stronger than the plan's original assertion.

---

## 3. `edge_cases`

| Edge case | Status |
|---|---|
| `TELEGRAM_BOT_USERNAME` unset | **not exercised** (finding 2). Correct by inspection. |
| …empty string | exercised — `start.test.ts:164` |
| …whitespace-only | exercised — `start.test.ts:169` |
| `signOut()` returns an error → no navigation | exercised — `Sidebar.test.tsx:61` |
| `signOut()` throws → no navigation | exercised — `Sidebar.test.tsx:72` |
| Zero active locations → no per-location queries | exercised — `named-rival.test.ts:307`; `loadRivalPickerViews` with `[]` never enters the loop and returns `[]` |
| Many locations → sequential, never N-wide | exercised — `named-rival.test.ts:289`, verified above |
| Every `AutoApprovalThreshold` maps to a label; `null` → `Off` | exercised — `threshold-labels.test.ts:8`, plus TS exhaustiveness on `Record<AutoApprovalThreshold, string>` |

---

## 4. Invariants

| Invariant | Verdict | Evidence |
|---|---|---|
| **#1** — no runtime `openai`/`@anthropic-ai/sdk`/`bullmq`/`postgres` under `src/app/**`, `src/components/**` | HOLDS | `pnpm lint` clean (the boundary rule is ESLint-enforced). `src/lib/auto-approval/types.ts` — the new import into a `'use client'` panel — imports only `zod`. |
| **#13** — no `NEXT_PUBLIC_*` companion | HOLDS | `pnpm ci:static-policy` → passed (1137 files). No new env var in the diff. |
| **#15** — `named-rival.ts` / `types.ts` never import `@/lib/db/server` | HOLDS | `rg 'lib/db/server'` on both files → none. `loadRivalPickerViews(db: Sql, …)` takes the client explicitly. `pnpm ci:db-imports` → "passed (strict)". |
| **#773** — ≤1 query in flight per request chain on the two pages | HOLDS | `admin/businesses/[id]/page.tsx`: `requireAdminPage` → `getBusinessDetail` → `getBusinessChannelEnrollments`, three sequential awaits. `settings/competitors/page.tsx`: `requireOwnerAccess` → `getLocationsForAccount` → `loadRivalPickerViews`, and the loader is a `for…of` with the await inside. |
| Sign-out error branch sets state, does not navigate | HOLDS | `Sidebar.tsx:76-79` (error return) and `:90-93` (catch) both `setSignOutError(true)` + `setSigningOut(false)` and return without `router.push`. |

`pnpm typecheck` and `pnpm lint` are both clean.

---

## 5. Blast radius

The one genuine edge — `AutoApprovalDiagnosticsPanel.tsx` →
`BusinessDetailClient.tsx` — is safe: the panel's exported props are unchanged
(the edit is entirely internal to the module: one deleted local function, one
added import, three call-site renames). No other file references
`thresholdLabel`.

The `AutoApprovalDiagnostics` type chain (`business-detail-types.ts:182-199`)
already declares `threshold: AutoApprovalThreshold | null` on both
`override` and `effective`, so the narrowed parameter type of the shared helper
is a type-level no-op — confirmed by a clean `tsc --noEmit`.

`loadRivalPickerView` retains a real external caller
(`src/app/api/settings/competitors/route.ts:43`) plus the integration suite, so
extracting the plural form did not orphan an export.

The rest of `blast-radius.md` is path-text noise, as the brief predicted.

---

## 6. Deviations cross-check

All five triaged ACCEPTs are consistent with the tree:

- **D1** — labels live in `types.ts`, no `labels.ts` created. Confirmed.
- **D2** — `loadRivalPickerViews` extracted into `named-rival.ts`, mirroring `loadLocationsSettingsView`. Confirmed; it is what makes the sequencing unit-testable.
- **D3** — the `?id?` intake spelling is runtime-only; the tracked intake keeps `[id]`. The three `[id]` files are in the diff, so the unblock worked.
- **D4** — both page-source tests strip comments; the admin one now *requires* the `SEQUENTIAL` comment. Verified empirically above.
- **D5** — line-count reclassification; no code impact.

---

## Appendix — observations below the confidence bar (NOT findings)

These are recorded for the author's judgement only. None is something I would
stake 80% on as a defect.

1. **Neither page-source test catches a fan-out spelled without the literal
   `Promise.all`** — e.g. hoisting both promises then awaiting them, or
   `Promise.allSettled`. The test titles scope themselves to "Promise.all
   fan-out", so they do not overclaim; and the competitors path has a real
   behavioural test behind it. Widening to `/Promise\.(all|allSettled|race)/`
   or a two-promise-hoist check would be cheap if the author wants it.

2. **`expect(code).toContain('getBusinessDetail')` /
   `toContain('getBusinessChannelEnrollments')`** (`page-source.test.ts:24-25`)
   are satisfied by the import statements alone, so they cannot detect a deleted
   call. They are supporting assertions, not the test's claim.

3. **The removed `` `${threshold}–5★` `` fallback is dead code, not a
   regression.** Migration `074_trust_dial_veto_window.sql:64-69` backfills
   `< 4` to `4` and installs `CHECK (auto_approve_min_star IS NULL OR
   auto_approve_min_star BETWEEN 4 AND 5)`, so an out-of-domain value cannot
   exist in the DB. Had one existed, the new helper would return `undefined`
   (blank cell) where the old one rendered `3–5★` — worth knowing if that CHECK
   is ever widened, since `AutoApprovalPolicyRow.auto_approve_min_star`
   (`business-detail/queries.ts:67`) *asserts* the narrow type on an
   unvalidated read rather than parsing it.

4. **Spec §3.5 said both block-reason maps would each gain a comment; only the
   admin one did.** The plan (Task 6 Step 2) explicitly overrides this — "Leave
   `BLOCK_REASON_COPY` untouched" — and the rationale is recorded in the
   `types.ts` docstring, so the fact is captured once. Not raised as a finding
   because the proximate contract directs it.

5. **`AutoApprovalDiagnosticsPanel.tsx:3-4` adds a second import line from
   `@/lib/auto-approval/types`** rather than merging into the existing
   `import type` line as the plan's Step 3 described. Cosmetic;
   `no-duplicate-imports` is not enforced and lint is clean.

6. **`admin/businesses/[id]/page.tsx` could move `if (!detail) notFound()`
   above the channel read** to save one query on the 404 path. Not a
   regression — the pre-change `Promise.all` also issued it — and moving it
   would be scope beyond the contract.

# Security-Audit Remediation — Phase 1 Design (Mechanical Hardening)

**Date:** 2026-06-15
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md`
**Status:** Design approved; ready for implementation plan.

## 1. Context

The 2026-06-15 whitehat refresh found **0 Critical/High** in current `main` and
**26 open defense-in-depth findings** (12 Medium, 12 Low, 2 Info), F-1 through
F-26. The user opted to remediate **everything source-fixable** (all 26; the
external/cloud items in audit §5 — RLS per-policy, Vercel/Railway/Upstash
config, DNS/email auth, Stripe console — are out of scope, not source-fixable).

Because 26 findings are far too large for one implementation, the work is
decomposed (Approach A — group by concern + risk, sequenced low-risk-first)
into ~7 themed, independently-shippable PRs. **This spec covers Phase 1 only.**
Later phases get their own spec → plan → implementation cycle.

### Decomposition roadmap (recorded decision)

| Phase | Theme | Findings | Lane |
|---|---|---|---|
| **1 (this spec)** | Mechanical hardening (no/low behavior change) | F-2, F-3, F-6, F-22, F-24, F-25, F-26 | preview |
| 2 | DB + boot invariant backstops | F-4 (migration), F-13, F-16, F-17 | staging |
| 3 | Admin step-up (AAL2) consistency | F-1 | preview |
| 4 | Observability redaction | F-7, F-8 | staging (worker) |
| 5 | LLM input hygiene | F-9, F-10 | staging (worker) |
| 6 | Webhook/ingress hardening | F-14, F-15, F-21 | staging (worker) |
| 7 | HTTP security headers | F-12, F-23, then F-11 (CSP nonce — own rollout) | preview |
| — | Info / belt-and-suspenders | F-5, F-18, F-19, F-20 (fold into nearest phase) | mixed |

Flagged for later phases (not Phase 1): **F-11** (CSP nonce migration) is the
only high-risk item and gets its own spec + staging soak. **F-23** (HSTS
`preload` list submission) is effectively irreversible and needs explicit
sign-off before submission.

## 2. Phase 1 scope

Seven findings. All preview-lane (no migration, no worker, no billing). One PR.

| # | Sev | Finding | File |
|---|---|---|---|
| F-2 | Low | Voice route regresses the safe dynamic-column pattern (`sql.unsafe`) | `src/app/api/settings/voice/route.ts` |
| F-3 | Low | Build-time transitive esbuild CVE (resolves to 0.28.0; CVE is <0.28.1) | `package.json` |
| F-6 | Info | Settings `businesses` UPDATE lacks redundant `account_id` scope | `src/app/api/settings/route.ts` |
| F-22 | Low | `.gitignore` `.env*.local` misses `.env.production/.staging` | `.gitignore` |
| F-24 | Low | `/api/approve/[token]/edit` uses manual validation, not Zod | `src/app/api/approve/[token]/edit/route.ts` |
| F-25 | Low | `PlaceAutocomplete` clears via `innerHTML = ''` | `src/components/places/PlaceAutocomplete.tsx` |
| F-26 | Low | Proxy path matching not case-normalized | `src/proxy.ts`, `src/lib/shared/protected-routes.ts` |

## 3. Per-finding design

### F-2 — Voice route: remove `sql.unsafe`, use the dynamic-column helper
**Current (`voice/route.ts:165-182`):** hand-builds `SET col = $n, …` by
string-interpolating column names into `query`, then runs
`sql.unsafe(query, values)`. Not exploitable today (Zod `.object()` strips
unknown keys → `field` is always one of 4 literals), but it reintroduces the
latent pattern (audit R4 M-3).

**Fix:** map validated fields to columns and use the Postgres.js
dynamic-column helper, mirroring `runScopedUpdate` in the sibling settings
route. No string interpolation; Postgres.js parameterizes identifiers + values.

```ts
const updates: Record<string, string | string[] | null> = {};
for (const field of fields) {
  updates[VOICE_FIELD_TO_COLUMN[field]] =
    (voiceFields[field] ?? null) as string | string[] | null;
}

const result = await sql`
  UPDATE businesses
  SET ${sql(updates)}, updated_at = NOW()
  WHERE id = ${locationId}::uuid
    AND account_id = ${user.accountId}::uuid
    AND archived_at IS NULL
`;
```

Delete the now-dead `setClauses` / `values` / `query` / `sql.unsafe` block.
Account-scoping and the 404-on-zero-count behavior are preserved.

**Regression test (new):** assert `VOICE_FIELD_TO_COLUMN` keys are a subset of
the `VoiceConfigSchema` keys (minus `locationId`), and that a PUT writes only
the mapped columns and stays account-scoped. This is the durable guard against
the pattern recurring (repworth rule: test tenant-scoped queries).

### F-3 — Pin esbuild ≥ 0.28.1 via pnpm override
**Current:** `package.json` has no `pnpm.overrides`; esbuild resolves to
`0.28.0` transitively (`@sentry/nextjs → @sentry/webpack-plugin → webpack →
terser-webpack-plugin → esbuild`). `GHSA-gv7w-rqvm-qjhr` affects `<0.28.1`.

**Fix:** add to `package.json`:
```json
"pnpm": {
  "overrides": {
    "esbuild": ">=0.28.1"
  }
}
```
Then `pnpm install` (re-locks `pnpm-lock.yaml`). Build-time only (not in the
Vercel-function runtime bundle).

**Verify:** `pnpm audit --prod` reports **0 high**; `pnpm build` still succeeds
(confirms the Sentry/webpack/terser chain tolerates the bump).

### F-6 — Settings `businesses` UPDATE: add redundant `account_id` scope
**Current (`settings/route.ts:76-81`):** `runScopedUpdate` filters
`WHERE id = ${idValue}` only. Safe today (`locationId` is server-derived in
`getCurrentUser`, not attacker-controlled), but defense-in-depth is cheap and
matches the voice route's scoping.

**Fix:** add an optional `accountScope?: string` to `runScopedUpdate`; when
present, append `AND account_id = ${accountScope}`. Pass `accountScope:
accountId` on the **businesses** call only — the `accounts` call's `idValue`
*is* the account PK, so it's already account-scoped and has no `account_id`
column.

No behavior change for legitimate requests (the businesses row already belongs
to the account).

**Implementation note (corrected at plan time):** branch the *whole* statement
on `accountScope` rather than splicing a conditional `tx`…`` fragment into the
`WHERE` clause. A nested tagged template is a second query call, which both
complicates the real query and breaks the settings test's call-counting/mock
dispatch. See the plan's Task 5 for the exact two-branch form.

### F-22 — Broaden `.gitignore` env coverage
**Current (line 32):** `.env*.local`. **Verified tracked env files:** only
`.env.example`. On disk: `.env.example` (tracked), `.env.local`,
`.env.staging.local` (ignored).

**Fix:** replace `.env*.local` with:
```
.env*
!.env.example
```
New protection: `.env.production`, `.env.staging` (no `.local` suffix). Already-
tracked `.env.example` stays tracked (gitignore does not untrack); `.env.local`
/ `.env.staging.local` remain ignored.

### F-24 — Approve-edit route: adopt Zod
**Current (`approve/[token]/edit/route.ts:28-51`):** manual `prepare` — parse
JSON, type-check `editedText`, length-check, `sanitizePublicResponseText`,
empty-check. Correct but ad-hoc (audit R4 L-2; stylistic).

**Fix:** replace with a Zod schema mirroring the dashboard edit route's
`.transform`-based pattern (baseline §2 confirms it uses `zod .transform`):
```ts
const EditSchema = z.object({
  editedText: z
    .string()
    .max(MAX_EDIT_LENGTH)
    .transform(sanitizePublicResponseText)
    .refine((s) => s.length > 0, { message: 'editedText is required' }),
});
```
**Preserve the existing 400 response shape and messages** ("Invalid request
body" for non-JSON, "editedText is required", the `MAX_EDIT_LENGTH` message) so
the approve-page client contract is unchanged. Existing route tests must stay
green.

### F-25 — PlaceAutocomplete: `replaceChildren()`
**Current (`PlaceAutocomplete.tsx:124`):** `containerRef.current.innerHTML =
''`. Safe (empty-string assign), but `replaceChildren()` is the idiomatic,
parser-free clear (audit R4 L-4; stylistic).

**Fix:** `containerRef.current.replaceChildren();`

### F-26 — Proxy case-normalization (one authoritative normalizer)
**Current:** `normalizePath` (`protected-routes.ts:26-41`) strips trailing
slashes but **not** case. `proxy.ts` mixes two styles — the `isProtected*`
helpers go through `normalizePath`, but the per-section branches use the **raw**
`pathname` (`pathname.startsWith('/admin')` at lines 114, 133; exact `=== `
checks). Near-zero impact today (App Router routes are case-sensitive, so
`/ADMIN/x` 404s with no protected content served), but it is a latent
inconsistency: lowercasing in only one place would flag `/ADMIN/x` as protected
in the gate yet match no branch → silent pass-through.

**Fix (consistent, single owner):**
1. `protected-routes.ts`: add `.toLowerCase()` to `normalizePath` and **export**
   it. Now every `isProtected*` decision is case-insensitive.
2. `proxy.ts`: compute `const routePath = normalizePath(pathname)` once
   (after extracting `pathname`) and use `routePath` for **all** gate/branch
   decisions (`isProtectedRoute`, the admin page/API branches, mixed-role,
   owner API, owner pages, `/mfa`, onboarding). Keep the **raw** `pathname` only
   for the downstream `REQUEST_PATHNAME_HEADER` and the redirect `next=`/`from=`
   params (preserve original casing for post-login navigation).

**Test (new):** unit-assert `isProtectedRoute('/ADMIN/secret')` and
`isProtectedOwnerApiRoute('/API/Dashboard')` are `true`, and that the
`/admin/login` exemption still holds for `/ADMIN/LOGIN`. (This is the one
Phase-1 item with an intended — tiny — behavior change.)

## 4. Verification plan

Run before claiming done (repworth "Always do"):
- `pnpm lint && pnpm typecheck && pnpm test`
- `pnpm ci:tenant-scope && pnpm ci:rls-audit` (F-2 and F-6 touch DB writes)
- `pnpm audit --prod` → **0 high**, and `pnpm build` succeeds (F-3)
- New tests pass: voice route map-sync/scoping (F-2), proxy case-insensitivity
  (F-26); existing approve-edit tests stay green (F-24)

## 5. Lane & rollout

All seven changes are **preview-lane safe** — no migration, no worker, no
billing, no webhook. Single PR to `main` via the normal 4-check CI gate. No
staging soak required. Each fix is independently revertable within the PR.

## 6. Out of scope (this phase)

F-1, F-4, F-5, F-7–F-21, F-23 — addressed in Phases 2–7 (see §1 roadmap), each
with its own spec. Nothing in Phase 1 blocks or depends on them.

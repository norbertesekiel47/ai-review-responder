# Security and Dependency Hardening Design

Date: 2026-05-21
Status: Approved design with review revisions

## Summary

This spec defines five hardening areas delivered as six reviewable PRs for the highest priority findings from the recent code scan:

1. Remove `sales_partner` as an accepted runtime role.
2. Enforce same-origin checks on cookie-authenticated mutation routes.
3. Harden owner-edited/public response text sanitization.
4. Add production mock-mode and Stripe startup safety checks.
5. Align runtime metadata.
6. Upgrade vulnerable dependencies.

The work should stay behavior-preserving for supported roles (`owner`, `admin`) and should avoid broad schema cleanup, route rewrites, or feature changes.

## Goals

- Reduce authorization risk before adding new product features.
- Make cookie-authenticated mutation routes consistently reject cross-origin requests.
- Ensure owner-edited text cannot persist dangerous invisible/control content.
- Prevent production from booting with external API mocks enabled.
- Fail fast when Stripe worker/runtime env configuration is incomplete.
- Resolve known dependency audit findings in a separate, reviewable PR.

## Non-Goals

- Remove the `sales_partner` value from the database schema or historical data.
- Redesign the full role/permission model.
- Rework OAuth/Zernio modularity beyond security-adjacent changes.
- Convert all route handlers to a new framework or wrapper style.
- Guarantee `pnpm audit --audit-level low` is permanently clean for future advisories.

## Assumptions

- Product scope is now `owner` and `admin` only.
- Existing `sales_partner` accounts should fail closed unless manually migrated.
- Same-origin checks apply to browser/session-cookie mutations, not third-party webhooks.
- Public token approval flows may be opened from email or SMS and must be reviewed case-by-case.
- Mock external APIs remain useful in local/test/staging, but never in production.
- Runtime metadata can land separately from dependency upgrades.
- Dependency upgrades may require `pnpm-lock.yaml` changes and broader regression testing.

## PR 1: Remove `sales_partner` Access

### Scope

- Remove `sales_partner` from middleware admin-page access checks.
- Remove `sales_partner` from admin login allowed-role lists and role redirects.
- Replace API calls like `requireRole(req, 'admin', 'sales_partner')` with admin-only authorization.
- Update tests, comments, and docs that describe `sales_partner` as admin-equivalent.
- Remove `sales_partner` from worker/background notification recipient queries where those recipients are treated as staff operators.

### Out of Scope

- Database enum migrations.
- Backfilling users.
- New scoped partner permissions.

### Required Behavior

- `admin` can still access admin routes and pages.
- `owner` can still access business dashboard/self-service routes.
- `sales_partner` cannot access admin pages, admin APIs, owner APIs, or privileged worker-recipient paths.
- Password login for a historical `sales_partner` user must sign the user out and show an unsupported-role message rather than redirecting to any app page.
- OAuth callback for a historical `sales_partner` user must sign the user out and redirect to `/admin/login?error=unsupported_role` for admin flows, or `/login?error=unsupported_role` for owner flows.
- Middleware must not route `sales_partner` users to an empty owner dashboard or to `/admin/overview`; protected admin pages redirect to `/admin/login?from=...`, protected owner pages redirect to `/login?from=...`, and protected APIs return 403.
- Existing `sales_partner` rows are unsupported legacy data until they are migrated or removed in a later schema/data cleanup.

### Validation

- Update existing auth/middleware/API tests.
- Add at least one negative test proving `sales_partner` is rejected from an admin route or middleware path.
- Add login/callback coverage proving `sales_partner` is signed out or rejected rather than redirected to admin.
- Run relevant auth/admin tests, `pnpm typecheck`, and `pnpm build`.

### Tracked Follow-Up

After runtime access removal is stable, create a separate schema/data cleanup task:

- Migrate any intended staff users from `sales_partner` to `admin`.
- Backfill or delete remaining historical `sales_partner` rows.
- Remove `sales_partner` from the database enum or role constraints if the migration is safe.
- Remove stale references from docs and seed data that intentionally preserve historical role values.

This follow-up is intentionally not part of PR 1 because irreversible role migrations should not be bundled with code-path authorization removal.

## PR 2: Same-Origin Enforcement

### Scope

- Apply the existing `assertSameOrigin` / `withSameOrigin()` helpers to cookie-authenticated non-GET routes.
- Confirm the helper behavior before edits: missing `Origin` and mismatched `Origin` must return 403 for protected mutations.
- Prioritize owner/admin mutation routes:
  - settings updates
  - review approve/edit routes
  - billing mutations
  - admin mutation routes
  - channel start/disable/cancel/delete/confirm routes
  - dashboard owner channel mutations
- Keep the implementation local and minimal: route wrappers or existing inline helper style, whichever matches each route family.
- Consider `Sec-Fetch-Site` as defense-in-depth: when present with `cross-site`, reject the mutation. `Origin` remains the authoritative check because some clients omit fetch metadata headers.

### Exclusions

- Third-party webhooks, which should rely on provider signature verification.
- Pure GET routes.
- Public token routes unless they also rely on authenticated session cookies or have an explicit same-origin requirement.

### Required Behavior

- Same-origin browser requests continue to work.
- Missing or mismatched `Origin` returns 403 for protected mutation routes.
- Webhooks and public-token flows are not broken by browser-origin assumptions.

### Validation

- Add representative tests for accepted same-origin, missing origin, and mismatched origin.
- Prefer route-family coverage over duplicated tests for every single route.
- Run relevant API route tests, `pnpm typecheck`, and `pnpm build`.

## PR 3: Public Response Text Sanitization

### Scope

- Add a named sanitizer for owner-edited/public response text, separate from the existing LLM prompt sanitizer unless their contracts are intentionally merged.
- Apply it before persisting edited approval responses.
- Treat stored sanitized text as canonical for publishing.
- Keep normal customer-facing prose intact.

### Sanitizer Contract

The sanitizer should:

- Strip null bytes.
- Strip ASCII control characters and C1 controls.
- Strip common invisible or directional control characters such as zero-width marks and bidi override/isolate characters.
- Normalize spaces and tabs within each line.
- Preserve paragraph breaks.
- Collapse excessive blank lines to at most two consecutive newline characters.
- Trim leading and trailing whitespace.
- Preserve normal punctuation, accents, emoji, and user-visible language content.

### Required Behavior

- Edited responses are stored in sanitized form.
- Empty-after-sanitization content is rejected.
- Publish paths must not silently transform approved text into materially different text. If a publish-boundary safety pass remains, it must use the same idempotent sanitizer as write-time storage.
- Legacy approved rows that predate this sanitizer should be handled by explicit cleanup/read-repair or reapproval, not by a publish-time rewrite that changes what the owner approved.
- Existing approval and publish flows keep their current success/failure semantics.

### Validation

- Unit-test the sanitizer with null bytes, control chars, zero-width chars, bidi controls, excess whitespace, normal punctuation, accents, and emoji.
- Test token/session approval edit paths persist sanitized text.
- Run approval/publish-related tests, `pnpm typecheck`, and `pnpm build`.

## PR 4: Worker Startup and Env Safety

### Scope

- Add one central production guard:
  - production must not boot with `MOCK_EXTERNAL_APIS=true`.
- Call the guard early from worker startup before accepting work or webhooks.
- Add Stripe startup assertions for worker-required env vars:
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - required base price IDs
  - required overage price IDs
- Preserve lazy Stripe client construction so imports and tests do not crash.

### Required Behavior

- Local/test/staging can still use `MOCK_EXTERNAL_APIS=true`.
- Production fails fast with a clear error if `MOCK_EXTERNAL_APIS=true`.
- Worker startup fails fast when enabled Stripe paths are missing required Stripe env vars.
- Existing individual mock bypasses can remain simple because production is guarded centrally.

### Validation

- Unit-test production mock-mode hard fail.
- Unit-test non-production mock mode remains allowed.
- Unit-test missing Stripe env variables produce clear startup errors.
- Run worker config, webhook, and billing tests plus `pnpm typecheck`.

## PR 5a: Runtime Metadata

### Scope

- Add top-level package runtime metadata:
  - `engines.node` matching `.nvmrc`
  - `packageManager` matching the project pnpm version
- Keep this PR isolated from security behavior changes.

### Required Behavior

- No dependency upgrades.
- No lockfile churn unless the package manager requires metadata normalization.
- Local installs and CI should agree on the intended Node and pnpm versions.

### Validation

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`

## PR 5b: Dependency Supply Chain

### Scope

- Upgrade vulnerable dependencies reported by `pnpm audit --audit-level low`.
- Keep this PR isolated from security behavior changes and runtime metadata.

### Current Targets

- `next` and `eslint-config-next`
- `fastify`
- transitive `glob`, `fast-uri`, `ws`, and related tooling paths
- any Sentry or build-tool updates needed to resolve transitive advisories

### Required Behavior

- No intentional feature behavior changes.
- Framework migration fallout is fixed inside this PR only.
- Lockfile changes are expected.

### Validation

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm audit --audit-level low`
- Manual smoke test login, admin, dashboard, billing, and relevant OAuth/channel flows if the Next upgrade is substantial.

## Rollout Order

1. Remove `sales_partner` access.
2. Add same-origin enforcement.
3. Add public response text sanitization.
4. Add worker startup and Stripe env safety.
5. Align runtime metadata.
6. Upgrade dependencies.

This order lands authorization and request-boundary fixes first, keeps operational hardening separate, and leaves dependency/framework churn for last.

## Risks and Mitigations

- Removing `sales_partner` may lock out historical users. Mitigation: fail closed intentionally and migrate any intended staff users to `admin`.
- Same-origin enforcement can break legitimate non-browser clients. Mitigation: apply only to cookie-authenticated mutation routes and exclude webhooks/public token flows.
- Sanitization can alter user-visible prose. Mitigation: preserve visible Unicode content and test normal punctuation, accents, and emoji.
- Production mock guard may fail an environment that currently depends on mock mode. Mitigation: this is desired for production; staging/local remain available.
- Runtime metadata is low risk but should not be blocked by framework upgrades. Mitigation: land metadata as PR 5a.
- Dependency upgrades can introduce framework regressions. Mitigation: isolate in PR 5b with full validation and manual smoke testing.

## Completion Criteria

The sequence is complete when all six PRs are merged, supported role behavior is unchanged for `owner` and `admin`, `sales_partner` is no longer an accepted authorization role, same-origin checks cover session-cookie mutations, public response text is sanitized before persistence and published without non-idempotent rewrite, production mock mode fails fast, Stripe env checks run at startup, runtime metadata matches the project runtime, and dependency audit findings are addressed or explicitly documented with an accepted exception.

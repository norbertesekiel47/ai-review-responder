# CSP Rollout Plan

Status: report-only first; enforcement is not a Wave 1 launch requirement.
Owner: founder/operator
Last updated: 2026-05-25

## Current State

`next.config.mjs` still emits a static CSP with `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. That is intentional for Wave 1 so launch hardening does not break current pages or third-party-injected styles while legal/security artifacts are being completed.

## Rollout

1. Add a report-only CSP endpoint and route CSP violation reports to Sentry with raw URLs and tokens scrubbed.
2. Move CSP generation from static `headers()` to Next.js middleware so each request can receive a nonce.
3. Remove `script-src 'unsafe-inline'` first and verify signup, approval, dashboard, legal, and onboarding flows in report-only mode.
4. Audit inline styles and component-library injections before attempting to remove `style-src 'unsafe-inline'`.
5. Enforce only after seven days with no launch-blocking violations in report-only telemetry.

## Regression Checks

- `pnpm build`
- Approval token page smoke test
- Owner dashboard smoke test
- Legal pages render under `/legal/*`
- ZAP passive scan against production or preview URL

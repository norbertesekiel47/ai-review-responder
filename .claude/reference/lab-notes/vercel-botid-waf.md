# Lab notes — Vercel BotID / WAF

## Summary

- **Vercel BotID / WAF** — client/server `checkLevel` must match or it fail-blocks legit traffic (single source of truth); only protect a route that has an in-app token-bearing caller (dead/external callers get 403'd, invisible to preview/mocked tests); Deep Analysis is billed → gate it behind auth, not just the forgeable same-origin header; WAF custom rules have no committable config (the runbook is source of truth); the staging custom env is preview-TYPE so a production-only WAF condition excludes it; `all_except_custom_domains` SSO protection still intercepts the staging custom env's custom domain (`staging.repworth.net` → vercel.com/sso-api) — smoke curls need the Protection Bypass for Automation header, prod custom domains are exempt (2026-08-26)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-04.md § "Vercel serverless can't reach local Docker Redis"
- history/2026-06.md § "Vercel staging is behind Deployment Protection (SSO) — automation/CDP browsers can't log in"
- history/2026-06.md § "2026-06-09 — Vercel BotID + WAF (Slice 2 rate-limit hardening, PR #257)"
- history/2026-08-08.md § "[2026-08-08] #679 — staging sits behind Vercel team-SSO *and* app auth, so any smoke that must cross a Next.js route has no headless path"
- history/2026-08-21-to-31.md § "[2026-08-26] Staging smoke curls bounced to vercel.com/sso-api despite `all_except_custom_domains` → the staging custom env's custom domain is still intercepted by Deployment Protection → Protection Bypass for Automation"
- history/2026-08-21-to-31.md § "[2026-08-31] An Infisical Secret Sync silently downgrades Vercel `Secret` variables to `Config`"

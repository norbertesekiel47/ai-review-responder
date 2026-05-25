# Spec 09 — Security & Compliance

> **Goal:** Third-party pentest before $50k MRR, OWASP top 10 in CI, secrets rotation policy, envelope-encrypted OAuth refresh tokens, SOC 2 controls running silently before audit, GDPR/CCPA self-serve, WAF + rate limits, security.txt + disclosure policy.
>
> **✅ Wave 1 SHIPPED (2026-05-25, PR #85):** `security.txt` + `/security` page (no overclaiming), vendor-risk + access registers, secrets-rotation runbooks, a CSP report-only/nonce rollout plan, and the **PHI scanner** (`src/lib/security/phi-scanner.ts`) blocking likely-PHI review text before persistence on every Zernio ingest path. **Deferred:** third-party pentest, OWASP/ZAP + Trivy as hard CI gates (need a stable staging target / image), envelope-encrypted OAuth tokens, SOC 2 audit, and removing CSP `'unsafe-inline'` (after a report-only soak).

---

## 1. Why this matters

Security maturity is binary in B2B procurement — checked or rejected. Build the controls now (cheap), get the audit later (expensive). The architecture already has strong invariants (token hashing, scoped auth); this spec turns those invariants into provable controls.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Approval tokens: SHA-256 hash only, looked up in `approval_links` (`src/app/api/approve/[token]/route.ts`, rate-limited 10/60s) — verified.
- Sentry scrubber in `src/lib/shared/sentry-scrub.ts` (redacts key/secret/token/password/authorization) — verified.
- RLS in place (migrations 035, 040, 041); head 042.
- **CSRF already enforced** via `assertSameOrigin`/`withSameOrigin` (`src/lib/shared/csrf.ts`, `src/lib/auth/route-helpers.ts`) across 40+ routes — verified.
- **Security headers already configured** in `next.config.mjs`: HSTS (`max-age=63072000; includeSubDomains`), `X-Content-Type-Options`, `X-Frame-Options: DENY`, production CSP. ⚠️ CSP still allows `'unsafe-inline'` for script/style — remaining work is nonce-based hardening, not "add headers."
- **Rate limiting is Redis-Lua** (`src/lib/shared/rate-limit.ts`), not `@upstash/ratelimit` — reuse it (consistent with [Spec 04](./04-auth-identity.md)).
- ⚠️ **OAuth-token reality (corrects the spec):** `google_connections` (migration 001) **already has `access_token_encrypted` + `refresh_token_encrypted`** with a DEK/KEK envelope design — but the table is **empty** because direct GBP API is a future (Phase 5) state. Today GBP access is **Zernio-mediated**; RepWorth stores **no Google refresh tokens**, only a server-side `ZERNIO_API_KEY` env var. So "OAuth tokens stored without envelope encryption" is **false**.
- No `/security.txt` or `/security` page; no pentest; no SOC 2 controls runbook.
- `docs/legal/repworth-privacy-policy.md` + `repworth-terms-of-service.md` exist (+ public `/privacy`, `/terms` pages). No `/legal/sub-processors` or `/legal/dpa`.
- ✅ **Base CI now exists:** the first secret-free GitHub Actions gate runs `lint`, `typecheck`, `test`, and `build`. Security-specific gates remain pending: ZAP, Trivy, Snyk, and Dependabot still need dedicated follow-up workflows/config ([Spec 24](./24-devops-deployment.md)).

## 3. Target state

### Pentest cadence
- Before $50k MRR: $5–15k pentest with **Cure53 / Latacora / Doyensec**.
- Then annually + after major architecture changes (e.g., new auth flow, new external integration).
- Cheap continuous checks until then:
  - **OWASP ZAP** in CI (baseline scan against staging).
  - **Snyk** for SCA + container scan.
  - **Socket.dev** for supply-chain attack detection.

### Secrets management
- **Single source: Vercel + Railway + Supabase env stores.** Never in code, never in `.env` checked in.
- Use **Doppler** or **Infisical** when secret count > 30 (centralize, audit).
- **Rotation cadence**:
  - Stripe webhook secret: every 6 months.
  - Supabase service key: annually.
  - OAuth refresh tokens (per-customer): automatic via Zernio / Google rotation.
  - API keys (RepWorth API): quarterly.
- Calendar reminders + `docs/runbooks/secrets-rotation-{stripe,supabase,api}.md`.

### Encryption at rest
- Approval tokens: SHA-256 hash only (already enforced).
- **OAuth refresh tokens: envelope-encrypted with KMS.** Either AWS KMS / GCP KMS or **Supabase Vault** (preferred — already in stack). Encrypt at write, decrypt only at use, never log plaintext.
- PII (names, emails): Supabase default encryption at rest. Column-level encryption only if a SSN-equivalent is ever stored (RepWorth shouldn't — keep it that way).
- Backups: encrypted at rest (Supabase default + B2/R2 server-side encryption).

### Compliance
- **GDPR / CCPA / LGPD / PIPEDA**: all satisfied by the same self-serve export + delete flows ([Spec 03](./03-multitenancy-isolation.md)).
- **DPA**: standard GDPR Art. 28 template downloadable from `/legal/dpa`, e-signable via DocuSign or HelloSign.
- **Sub-processor list**: public at `/legal/sub-processors`. Notify customers 30 days before adding a new sub-processor.
- **CCPA "Do Not Sell My Info"**: footer link required even though RepWorth doesn't sell.
- **HIPAA**: not BAA-covered. Add hard ban + scanner that flags reviews with potential PHI patterns; refuse onboarding to dentists/medspas unless they confirm in writing GBP reviews don't contain PHI.

### SOC 2
- **Start controls now.** Drata or Vanta at $50k MRR (~$7–15k/year).
- Controls running silently from day 1:
  - Access review cadence: quarterly review of who has access to Stripe, Supabase, Vercel, Railway.
  - Change management: PR review required, no direct pushes to `main`.
  - Vendor risk: maintain `docs/security/vendor-risk-register.md`.
  - Onboarding/offboarding checklist: `docs/security/access-checklist.md`.
- Type I in 3 months from kickoff, Type II in 9–12 more.

### Vulnerability disclosure
- `/security.txt` at well-known URL.
- `/security` page with policy: scope, safe harbor, contact (`security@repworth.net`), bounty.
- Bounty: start with hall-of-fame + swag; paid bounty at $100k MRR.

### Dependency scanning
- **Dependabot** on auto-merge for patch + minor security updates.
- **Snyk** for SCA.
- **Socket.dev** for supply-chain.
- Manual review for major version bumps.

### Container scanning
- **Trivy** in CI on Dockerfile + Railway image.
- Fail build on CRITICAL CVEs.
- Re-scan weekly even with no code change.

### Web app firewall
- **Vercel WAF** built-in (Pro plan).
- Block: SQL injection patterns, XSS patterns, known-bad IPs, geo-block tier-2 abuse origins (e.g., countries with no expected customers).
- Cloudflare in front if Vercel WAF too limited.

### Rate limiting
- **Upstash Ratelimit** (already in stack).
- Per IP + per `account_id`. Different limits per endpoint:
  - Auth: 5/min per IP.
  - API: 100/min per `account_id`.
  - Webhook: no limit but signature-verified.

### Headers
- **CSP:** strict, no `unsafe-inline`, no `unsafe-eval`. Use nonces.
- **HSTS:** `max-age=63072000; includeSubDomains; preload`. Submit to hstspreload.org.
- **Cookies:** `Secure; HttpOnly; SameSite=Lax`.
- **CSRF:** double-submit-cookie pattern on every state-changing form (Next.js + Supabase Auth already provides; verify).
- Target [securityheaders.com](https://securityheaders.com) score: **A+**.

### Security awareness
- Quarterly review of access logs (Supabase, Stripe, Vercel) for anomalies.
- Annual security training for any contractor / hire.

## 4. Implementation tasks

1. Add `/security.txt` (`public/.well-known/security.txt`) per [securitytxt.org](https://securitytxt.org) format.
2. Build `/security` page summarizing posture (cross-link to `/trust` from Spec 29).
3. Extend the existing secret-free GitHub Actions base CI with OWASP ZAP baseline scan (`.github/workflows/security-scan.yml`) and the required staging target/secrets ([Spec 24](./24-devops-deployment.md)).
4. Wire Trivy container scan once a `Dockerfile` exists (there is none today; the worker runs via `tsx`). Until containerized, scan dependencies instead.
5. Add `.github/dependabot.yml` + Snyk; configure auto-merge for patch/minor. (Requires CI.)
6. **OAuth envelope encryption already exists** in schema (`google_connections.{access,refresh}_token_encrypted`, DEK/KEK). ⚠️ **No migration 045 needed.** Real work: (a) secure + rotate `ZERNIO_API_KEY` (the live secret) per the rotation cadence; (b) when GBP Phase 5 populates `google_connections`, verify the encrypt/decrypt round-trip before going live. Document key rotation in `docs/runbooks/oauth-key-rotation.md`.
7. Add PHI-pattern scanner to review-ingest path (`worker/jobs/zernio/*`). Block ingest + alert on positive match.
8. Add `/legal/sub-processors` and `/legal/dpa` pages.
9. Add CCPA "Do Not Sell My Info" footer link.
10. Write `docs/security/vendor-risk-register.md` and `docs/security/access-checklist.md`.
11. Calendar reminders + runbooks for each secret rotation.
12. CSP hardening: headers already exist in `next.config.mjs` (HSTS/X-CTO/X-Frame/CSP). Remaining: remove `'unsafe-inline'`, adopt nonces. Run report-only for 2 weeks (track violations in Sentry) before enforcing. Verify securityheaders.com A+.
13. Rate limiting is the existing Redis-Lua `src/lib/shared/rate-limit.ts` (not Upstash) — extend per-endpoint limits there per [Spec 04](./04-auth-identity.md); do not add `@upstash/ratelimit`.
14. Schedule first pentest engagement with Cure53 / Latacora before $50k MRR milestone.

## 5. Acceptance criteria

- [ ] securityheaders.com scan returns A+.
- [ ] `/security.txt` and `/security` live.
- [ ] `ZERNIO_API_KEY` rotation logged; when `google_connections` is populated (Phase 5), a raw DB row shows opaque ciphertext (envelope columns already exist).
- [ ] Base GitHub Actions CI exists; Trivy (once a Dockerfile exists) + ZAP run on every PR; build fails on CRITICAL.
- [ ] Dependabot configured (`.github/dependabot.yml`); first 10 PR auto-merges visible in history.
- [ ] `/legal/sub-processors` and `/legal/dpa` live, lawyered, downloadable.
- [ ] PHI scanner test: synthetic review with "MRN 12345" pattern triggers block + alert.
- [ ] Vendor risk register exists with every sub-processor scored.
- [ ] Secret rotation log shows ≥ 1 rotation per cadence.

## 6. Metrics

| Metric | Target |
|---|---|
| securityheaders.com score | A+ |
| CRITICAL CVE TTR | < 7 days |
| Dependabot lag | < 7 days from upstream release |
| Sub-processor change notification lead | ≥ 30 days |
| Time from breach detection → customer notification | < 72 hours (GDPR Art. 33) |

## 7. Risks & mitigations

- **Risk:** Pentest finds critical issues that block customer trust. **Mitigation:** that's the point — fix and re-test. Better to find pre-revenue than post-breach.
- **Risk:** Envelope encryption migration corrupts OAuth tokens. **Mitigation:** dual-write path during migration window; verify decrypt round-trip per token before deleting plaintext.
- **Risk:** Strict CSP breaks the marketing site. **Mitigation:** report-only mode for 2 weeks before enforcing; track violations in Sentry.
- **Risk:** SOC 2 controls feel performative. **Mitigation:** they're substance: access review, change management, vendor risk — each prevents real classes of incident.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (RLS, tenant isolation tests)
- [Spec 04 — Auth & Identity](./04-auth-identity.md) (MFA, rate limits, session management)
- [Spec 17 — Legal & Compliance Docs](./17-legal-compliance-docs.md) (lawyered ToS/PP, DPA)
- [Spec 28 — Customer Comms & Brand](./28-customer-comms-brand.md) (breach notification)
- [Spec 29 — RepWorth Gaps](./29-repworth-specific-gaps.md) (`/trust` page)
- Code anchors: `src/lib/shared/{sentry-scrub,csrf,rate-limit}.ts`, `src/lib/auth/route-helpers.ts`, `next.config.mjs` (headers), `google_connections` (migration 001, encrypted token columns), `src/app/api/approve/[token]/route.ts`, `docs/legal/*`

## 9. Implementation in the current repo

- **More is already done than the spec assumed:** CSRF (`withSameOrigin`), security headers, the Sentry scrubber, SHA-256 approval tokens, and the *encrypted* `google_connections` columns all exist. The real gaps are CI-gated scanning, `/security.txt` + `/security`, the legal pages, the PHI scanner, and SOC 2 process.
- **OAuth encryption is not net-new schema work.** The DEK/KEK columns exist and sit unused; the live secret to protect today is `ZERNIO_API_KEY` (env var, server-side). Fold its rotation into the secrets-rotation runbooks.
- **Security scanning is a specialized follow-up on [Spec 24](./24-devops-deployment.md).** The base GitHub Actions gate exists, but ZAP/Trivy/Dependabot/Snyk still need dedicated workflows/config; Trivy additionally needs a `Dockerfile` (worker currently runs via `tsx`).
- **CSP** is in `next.config.mjs` already — harden in place (nonces, drop `'unsafe-inline'`), don't rewrite from scratch.
- **PHI scanner** belongs on the Zernio ingest path (`worker/ingress/zernio/*`, `worker/jobs/zernio/*`) — block + alert on positive match before persistence.

---
_Verified 2026-05-23 against migration head 042. Corrected the OAuth-token claim (encrypted columns already exist, table empty, Zernio-mediated), the "no headers/CSRF" implication (both exist), and the Upstash-vs-Redis-Lua rate-limit reality; flagged security scanning as a pending specialized follow-up beyond the secret-free base CI._

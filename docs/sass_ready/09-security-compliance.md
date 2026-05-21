# Spec 09 — Security & Compliance

> **Goal:** Third-party pentest before $50k MRR, OWASP top 10 in CI, secrets rotation policy, envelope-encrypted OAuth refresh tokens, SOC 2 controls running silently before audit, GDPR/CCPA self-serve, WAF + rate limits, security.txt + disclosure policy.

---

## 1. Why this matters

Security maturity is binary in B2B procurement — checked or rejected. Build the controls now (cheap), get the audit later (expensive). The architecture already has strong invariants (token hashing, scoped auth); this spec turns those invariants into provable controls.

## 2. Current state (RepWorth)

- Approval tokens: only SHA-256 hashes stored (architecture invariant, enforced via `approval_links`).
- Sentry scrubber delegated (PR #26) — PII sanitization in error reports.
- RLS in place (migrations 035, 040, 041).
- No `/security.txt` or `/security` page.
- No pentest performed.
- OAuth refresh tokens stored without envelope encryption (per Supabase defaults).
- No SOC 2 controls runbook.
- `docs/Legal/repworth-privacy-policy.md` + `repworth-terms-of-service.md` exist as drafts.

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
- `/security` page with policy: scope, safe harbor, contact (`security@repworth.com`), bounty.
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
3. Wire OWASP ZAP baseline scan in CI (`.github/workflows/security-scan.yml`).
4. Wire Trivy container scan (`.github/workflows/container-scan.yml`).
5. Enable Dependabot + Snyk; configure auto-merge for patch/minor.
6. Implement envelope encryption for OAuth refresh tokens. Add migration **045** creating `oauth_credentials_encrypted` columns. Backfill in batch. Document KMS key rotation in `docs/runbooks/oauth-key-rotation.md`.
7. Add PHI-pattern scanner to review-ingest path (`worker/jobs/zernio/*`). Block ingest + alert on positive match.
8. Add `/legal/sub-processors` and `/legal/dpa` pages.
9. Add CCPA "Do Not Sell My Info" footer link.
10. Write `docs/security/vendor-risk-register.md` and `docs/security/access-checklist.md`.
11. Calendar reminders + runbooks for each secret rotation.
12. CSP audit: tighten `next.config.js` headers; remove inline scripts; use nonces. Verify securityheaders.com score A+.
13. Add Upstash Ratelimit middleware (already half-built — finish per [Spec 04](./04-auth-identity.md)).
14. Schedule first pentest engagement with Cure53 / Latacora before $50k MRR milestone.

## 5. Acceptance criteria

- [ ] securityheaders.com scan returns A+.
- [ ] `/security.txt` and `/security` live.
- [ ] OAuth refresh tokens encrypted at rest (verified by reading raw DB row — should be opaque ciphertext).
- [ ] Trivy + ZAP run on every PR; build fails on CRITICAL.
- [ ] Dependabot configured; first 10 PR auto-merges visible in history.
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
- Code anchors: `worker/sentry.ts` (scrubber), `supabase/migrations/035-041_rls*.sql`, `src/middleware.ts`, `docs/Legal/*`

# Spec 23 — Testing & QA

> **Goal:** Critical-path coverage on auth/billing/ingestion/approval/publishing, real-service integration tests for billing, post-deploy smoke checks, visual regression on key pages, manual load tests, light chaos in staging.

---

## 1. Why this matters

Coverage % is the wrong metric. **Critical-path coverage** is the right one — if auth, billing, ingestion, approval, and publishing don't break, RepWorth doesn't have customer-impacting bugs.

## 2. Current state (RepWorth)

- Vitest unit + integration (`pnpm test`).
- Playwright E2E (`pnpm test:e2e`) — gracefully skips without `TEST_DATABASE_POOL_URL`.
- `MOCK_EXTERNAL_APIS=true` for local dev (CLAUDE.md).
- Solid runbook coverage; smoke-test checklist exists.
- No documented merge-gate criteria.
- No visual regression tests.
- No load test in CI (correct — should be manual).

## 3. Target state

### Coverage gates (merge-blocking)
| Gate | Tool |
|---|---|
| Unit + integration pass | Vitest |
| Type-check clean | tsc |
| Lint clean | ESLint |
| Code review approved | GitHub |
| Critical-path E2E pass | Playwright (when DB-pool URL provided in CI) |
| Tenant-isolation test pass | Vitest ([Spec 03](./03-multitenancy-isolation.md)) |
| Accessibility regression check | axe + Pa11y ([Spec 19](./19-accessibility.md)) |
| OpenAPI spec drift = 0 | zod-to-openapi check |
| LLM eval pass (weekly) | LLM eval runner ([Spec 22](./22-ai-llm-ops.md)) |
| Container scan: no CRITICAL | Trivy ([Spec 09](./09-security-compliance.md)) |

**Do NOT gate on coverage %.**

### Critical-path coverage requirement
| Module | Required integration tests |
|---|---|
| Auth (signup, login, MFA, magic link, OTP) | ≥ 8 |
| Billing (subscribe, upgrade, downgrade, past_due, reconcile) | ≥ 10 |
| Review ingestion (Zernio webhook → DB) | ≥ 5 |
| Response generation + approval | ≥ 6 |
| Publishing to GBP | ≥ 4 |
| Outbox pattern (transactional dispatch) | ≥ 3 |
| Multi-location + per-location billing | ≥ 5 |
| Tenant isolation | ≥ 50 (covers all read/list/update/delete ops) |

Target: 70%+ line coverage on critical modules; UI can be lower.

### Integration test infrastructure
- **Real services for integration tests:**
  - **Stripe test mode** (no mock).
  - **Real Supabase test project** (separate from prod and staging).
  - **Upstash dev** Redis instance.
- **Mocked for unit tests:** External HTTP (OpenAI, Twilio, Resend, Zernio webhooks).
- **Skip E2E gracefully** if `TEST_DATABASE_POOL_URL` not set (existing pattern — preserve).

### Synthetic post-deploy smoke
- GitHub Action triggered after Vercel + Railway deploy.
- Hits: login → dashboard load → create-test-response-on-dummy-account → publish (test mode).
- Alert if smoke fails.
- Runs against a **dedicated test-account** with `is_synthetic=true` flag.

### Visual regression
- **Chromatic** or **Percy** on critical pages:
  - Dashboard home
  - Review detail
  - Approval modal
  - Settings (billing, team, brand voice)
  - Pricing page
- Approve diffs as part of PR review.
- Optional for solo founder; high-value once designer joins.

### Load tests (manual, quarterly)
- Stored in `tests/load/*.js` (k6 or Artillery).
- Run quarterly + after architecture changes.
- Document results: `docs/runbooks/load-test-YYYY-MM.md`.
- See [Spec 12](./12-performance-scalability.md).

### Chaos engineering (lightweight)
- **Quarterly chaos exercise in staging:**
  - Kill the worker mid-job; verify retry + idempotency.
  - Drop the DB connection; verify reconnect.
  - Inject latency on OpenAI calls; verify fallback to Anthropic.
- Document: `docs/runbooks/chaos-drill-YYYY-QN.md`.
- Full chaos engineering (Gremlin, Chaos Mesh) overkill at this stage.

### Test data management
- **Faker / Mock Service Worker** for stable synthetic data.
- Snapshot fixtures: `tests/fixtures/*.json`. Version-controlled.
- Database fixtures: transactional rollback per test (Vitest beforeEach/afterEach).

### Flakiness budget
- Flaky tests ≤ 1% of CI runs.
- Re-run logic: max 1 retry; if still red, fail the build.
- Flaky test is a P2 bug — assigned and fixed within 7 days.

### Mutation testing (year 2)
- **Stryker** on critical modules: tells you if your tests actually catch mutations.
- Not necessary at MVP; high signal once test suite is large.

## 4. Implementation tasks

1. Set merge-gate rules in GitHub branch protection.
2. Author critical-path tests for each module per §3 requirements. Many already exist — audit and fill gaps.
3. Wire post-deploy smoke check as `.github/workflows/post-deploy-smoke.yml`.
4. Subscribe Chromatic or Percy. Set up visual regression on 5 critical pages.
5. Set up dedicated Supabase test project + Upstash dev for CI integration.
6. Mark Vitest test config to require `TEST_DATABASE_POOL_URL` for integration; skip with clear message if absent (preserve existing pattern).
7. Add quarterly chaos drill calendar entries.
8. Author `tests/integration/tenant-isolation.spec.ts` (also [Spec 03](./03-multitenancy-isolation.md)).
9. Add OpenAPI drift check in CI (compare generated spec to committed).
10. Author flakiness tracker `docs/qa/flakiness-tracker.md`. Weekly review.
11. Document test data convention in `docs/qa/test-data.md`.

## 5. Acceptance criteria

- [ ] Branch protection enforces gates listed in §3.
- [ ] Every critical module hits its minimum test count.
- [ ] Post-deploy smoke runs on every prod deploy; alerts on failure.
- [ ] Visual regression baseline established on 5 critical pages.
- [ ] Quarterly chaos drill calendar entry exists; first drill completed.
- [ ] Flakiness budget ≤ 1% sustained for 4 weeks.
- [ ] Tenant-isolation test gates merges.

## 6. Metrics

| Metric | Target |
|---|---|
| CI run time | < 10 min total |
| Flakiness rate | ≤ 1% |
| Post-deploy smoke pass rate | 100% (failures investigated + fixed) |
| Visual regression review SLA | ≤ 24h |
| Coverage on critical modules | ≥ 70% |

## 7. Risks & mitigations

- **Risk:** Real-service integration tests cost / pollute test environments. **Mitigation:** dedicated test Stripe + Supabase projects; transactional rollback; teardown after each test class.
- **Risk:** Visual regression generates noisy diffs blocking PRs. **Mitigation:** approve baseline carefully; ignore micro-rendering diffs.
- **Risk:** Chaos drill breaks staging during real work. **Mitigation:** schedule + announce; have rollback ready.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (tenant-isolation test)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (container scan, OWASP ZAP)
- [Spec 12 — Performance](./12-performance-scalability.md) (load test cadence)
- [Spec 19 — Accessibility](./19-accessibility.md) (axe + Pa11y in CI)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (eval set in CI)
- [Spec 24 — DevOps & Deployment](./24-devops-deployment.md) (CI workflow specifics)
- Code anchors: `pnpm test`, `pnpm test:e2e`, `MOCK_EXTERNAL_APIS=true`

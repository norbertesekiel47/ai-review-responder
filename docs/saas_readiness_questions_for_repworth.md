# SaaS Readiness Questions for RepWorth — with Best Answers

Organized by pillar. Each section has the core question, the follow-ups that surface gaps, and a prescriptive **"best answer"** representing what mature SaaS playbooks recommend. RepWorth-specific context (Google reviews / SMB / Next.js + Railway + Supabase) is folded in where it changes the answer.

Conventions:
- **A:** = best answer / recommended target state
- **RepWorth today:** = what the repo currently shows (when knowable from code/docs)
- **Gap → action:** = the smallest concrete step to close the gap

---

## 1. Product–Market Fit & Positioning

- **Who is the ideal customer profile (ICP)? Solo barbershops vs. 5-location dental groups vs. franchise multi-unit operators — each implies a different pricing model, support load, and feature roadmap.**
  - **A:** Pick **one** sharp ICP for the first 12 months and ignore the others. For RepWorth the sweet spot is **multi-location service SMBs with 2–25 locations and a non-technical owner-operator or marketing manager** (dental groups, medspas, auto-service chains, salon groups, fitness studios). Single-location is high-churn and price-sensitive; 50+ locations expects enterprise procurement you can't yet support. Codify the ICP as a one-pager with: vertical list, employee count, location count, current tooling, decision-maker title, top 3 pains.
  - **Gap → action:** Write `docs/icp.md` and pin it. Every roadmap argument should pass the "does this serve the ICP?" test.

- **What is the one core job-to-be-done you charge for?**
  - **A:** "**Never miss a review and never publish a bad response.**" That's the JTBD: vigilance + safety. "AI review responder" is a feature; "protect your reputation while you sleep" is the job. Landing page H1, pricing page value prop, and onboarding success message should all repeat the same JTBD verbatim.

- **What's the wedge that prevents Birdeye, Podium, NiceJob, and GoSite from undercutting you?**
  - **A:** Three defensible wedges, in priority order: (1) **Approval-first architecture** — every response requires explicit owner sign-off, with cryptographic audit trail. Competitors auto-post and own the liability. (2) **Multi-location-native** at SMB prices — incumbents charge enterprise rates for multi-location. (3) **Best-in-class brand voice tuning** per location. Put each wedge on the comparison page with proof.

- **Have you talked to 25+ paying SMBs in the last 90 days? What did they list as the top 3 reasons they'd cancel?**
  - **A:** Target: **5 customer conversations per week**, every week, forever. Use Steve Portigal/Rob Fitzpatrick style interviews — past behavior, not future intent. Track answers in a structured CRM field ("Top cancellation risk"). The top 3 cancellation reasons should drive next quarter's roadmap directly; if they don't, you're building for yourself.

- **What's the activation event that correlates with 90-day retention?**
  - **A:** Hypothesis to validate: **"First approved + published response within 7 days of signup."** That single event proves: GBP connected, review ingested, AI generated, owner approved, response published. Instrument it as `activation_completed` in PostHog. Once you have 50+ activated accounts, run a retention curve split by activated-yes/no. Re-derive activation if the lift is < 2x.

- **What % of your trials convert to paid? What's the 30/60/90-day logo retention?**
  - **A:** Healthy SMB SaaS benchmarks: **15–25% trial→paid, 90%+ monthly logo retention, 70%+ at 12 months**. Anything below 10% trial conversion means the activation flow is broken; anything below 85% monthly retention means PMF isn't there yet.
  - **Gap → action:** Wire trial-start, trial-end, paid-conversion, churn events to a single source-of-truth (PostHog or ProfitWell) and build a 4-metric dashboard.

- **Do you have a public changelog and roadmap, or is the roadmap private?**
  - **A:** Public changelog (Headway, Canny, or just `/changelog` markdown), private internal roadmap, **public "what we're working on next" with 3 buckets: shipping, exploring, considering**. Don't commit to dates. Customers tolerate uncertainty; they hate silence.

---

## 2. Pricing & Packaging

- **Is pricing per-location, per-review-volume, per-seat, or flat?**
  - **A:** For multi-location SMBs the value metric customers *feel* is **per-location** (it scales with their business and is predictable). Stack a soft cap on review volume (e.g., 200/location/month) with overage pricing or a forced tier upgrade. Per-seat is wrong here — owners want unlimited team members to view; charge for locations, not chairs.

- **Are tiers gated by features or limits?**
  - **A:** **Both, in the right places.** Limits gate at low end (1 location, 100 reviews/month). Features gate at high end (multi-location dashboard, API access, custom brand voice training, SSO, audit log export). Three tiers max: **Starter / Growth / Scale**. Don't build a fourth tier until the third sells out.

- **Is there a free tier, free trial, or money-back guarantee — and which one is the conversion engine?**
  - **A:** **14-day free trial, no credit card required, with a 30-day money-back guarantee on the first paid month.** SMBs in this category convert better on no-CC trials than freemium (which attracts tire-kickers). The money-back guarantee is a closer for owners on the fence.

- **How do you handle overages on review volume? Hard cap, soft cap with notification, or burst-with-billing?**
  - **A:** **Soft cap with 80% / 100% / 120% notifications, then auto-upgrade prompt at 120% with a 7-day grace period before forced upgrade or feature downgrade.** Never silently block — that triggers cancellation. Show the meter in-product.

- **Are annual plans discounted (typically 15–20%)? What's annual vs. monthly mix?**
  - **A:** Offer **2 months free on annual (~17% discount)**. Target 30–40% of revenue on annual within 12 months — that's the cash-flow oxygen for a bootstrapped SaaS.

- **Is there a usage-based component or pure subscription?**
  - **A:** **Hybrid: subscription per location + overage on reviews-processed.** Pure subscription leaves money on the table from heavy users; pure usage scares SMBs who hate variable bills. Cap variability with a "max bill this month" guarantee.

- **How do you handle proration on upgrades, downgrades, mid-cycle location adds, and tier changes?**
  - **A:** Stripe's default proration on `subscription.update` for upgrades; **downgrades schedule for the next period boundary** (no refund surprise). Add-locations prorates immediately. Document in `docs/billing/proration.md` and link from the customer billing portal FAQ.
  - **RepWorth today:** Stripe-first tier-change pattern is hardened (per recent fixes); base-item fallback was removed; reconciliation contract documented in code comment.
  - **Gap → action:** Surface the documented contract in a customer-facing help article.

- **Are coupon codes, referral discounts, and partner/agency pricing supported?**
  - **A:** Yes — Stripe Coupons + Promotion Codes, gated by feature flag. Build the referral program in v2 (in-product share link → 20% off both sides for 3 months). Agency pricing is a manual deal-desk path until you have 10+ agency customers, then build a partner portal.

- **Is there enterprise/custom pricing with a "Contact Sales" path?**
  - **A:** Yes — a "Contact Sales" tier on the pricing page that links to a Calendly with a 3-field qualifier (locations, vertical, current tool). Required even if you don't want enterprise yet — it signals upmarket capability to investors and PE-backed multi-unit prospects.

---

## 3. Multi-tenancy & Data Isolation

- **Is every query scoped by `account_id` (and `business_id`) at the ORM/repository layer, or only at the route handler? Where's the test that proves you can't accidentally read another tenant's data?**
  - **A:** Scope at the **repository layer**, not the route. Every repository function takes `accountId` as a required first argument and the query builder injects it. Add a "tenant isolation" integration test that creates two accounts, performs every list/read/update operation as account A, and asserts zero rows of account B leak through. Run on every PR.
  - **RepWorth today:** Architecture invariants document the `account_id` / `business_id` scoping rule but the cross-tenant negative test is not visibly enforced.
  - **Gap → action:** Add `tests/integration/tenant-isolation.spec.ts` that's brutal and gates merges.

- **Row Level Security in Supabase — enabled on every table or just some?**
  - **A:** **RLS on every tenant-scoped table**, even when the route handler also enforces — defense in depth. Service-key code paths bypass RLS (which is correct) but anon/authenticated paths must rely on it. Audit with `SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r'` and fail CI if any tenant-scoped table has RLS off.

- **What happens when a customer requests data export?**
  - **A:** **Self-serve in Settings → Privacy → Export My Data**, generates a signed S3/Supabase-Storage URL valid for 7 days, contains JSON + CSV for reviews, responses, audit log, billing history. SLA: < 24h. Anything that requires you to run a script is a GDPR / CCPA liability.

- **What happens on account deletion?**
  - **A:** **Soft delete with 30-day undo, then hard delete with cryptographic erasure of customer-specific keys**. Anonymize aggregate analytics rows (preserve counts, drop PII). Document retention in the privacy policy. The 30-day window is the support-recovery sweet spot.

- **Are there any shared resources (Redis cache keys, BullMQ queue names, file storage paths) that could leak across tenants if a key collision occurred?**
  - **A:** **Every cache key and storage path prefixed with `account_id`**. BullMQ job IDs include `account_id_business_id_uuid`. Storage buckets either tenant-scoped or path-prefixed with RLS-equivalent. Add a lint rule that flags any new cache key without an account_id prefix.

- **If you ran one query across the production DB and dumped one customer's data into another's view by mistake, how would you detect it?**
  - **A:** You wouldn't with normal monitoring — this is why **tenant isolation must be tested, not observed.** Layer 1: automated cross-tenant integration test on every PR. Layer 2: synthetic check in prod that creates a probe-account every hour, queries it, asserts the probe-account ID matches. Layer 3: an alert that fires if any user session returns rows where `row.account_id != session.account_id`.

---

## 4. Authentication, Authorization & Identity

- **What auth methods are supported?**
  - **A:** Day 1: **Email/password + Google SSO + Magic Link**. Day 90: add Microsoft SSO (dentists and clinics often use 365). Day 365: Passkeys. Skip Apple SSO unless mobile native.

- **Is MFA available? Mandatory for owners? For enterprise tiers?**
  - **A:** **TOTP MFA available for all, mandatory for the billing owner role, mandatory for everyone on Scale tier.** Don't gate MFA behind paid plans — that's a customer-trust foot-gun. Recovery codes generated at enrollment, downloadable once.

- **Is SSO (SAML, OIDC) on the roadmap for enterprise?**
  - **A:** Yes — **SAML 2.0 via WorkOS or Stytch B2B** when first enterprise prospect asks. Don't roll your own. SCIM provisioning follows. Expect this to gate any deal over $1k/mo MRR within 18 months.

- **Role model: today there's "owner" — are there manager/editor/viewer/billing-only roles?**
  - **A:** Minimum viable role set: **Owner (everything), Admin (everything except billing/delete-account), Editor (approve + edit responses), Viewer (read-only), Billing (billing only)**. Per-location role assignment on Scale tier. Build the table now even if the UI only exposes Owner + Editor — the migration cost later is high.

- **How are invitations, accept flows, deactivations, and re-activations handled?**
  - **A:** Email invite with 7-day signed token → accept page sets password / SSO → role assigned per invite. Deactivation revokes sessions immediately, retains history. Re-activation is one-click for the owner. Audit log every invite/accept/deactivate.

- **Is there an audit log of who did what?**
  - **A:** **Append-only `audit_events` table** with `account_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `metadata` JSONB, `created_at`. Surface in-app for Scale tier. Retain 13 months minimum. This is also your "we have evidence" defense in a billing or approval dispute.
  - **RepWorth today:** Audit log is written before billing enqueue (per recent CSV import fix) — the pattern exists. Generalize it.

- **Session management: idle timeout, device list, revoke session, "sign out everywhere"?**
  - **A:** 30-day rolling session, 12-hour idle timeout for sensitive routes (billing, audit log export), device list in Settings → Security, "sign out everywhere" button. Supabase handles most of this — surface it in UI.

- **Password reset rate-limiting, signup throttling, brute-force protection on login?**
  - **A:** **5 reset requests / email / hour, 10 signups / IP / hour, exponential backoff after 5 failed logins**. Cloudflare or Vercel WAF at the edge for IP-level limits. Log all auth failures with IP + UA for anomaly detection.

---

## 5. Billing & Subscription Lifecycle

- **Stripe is the source of truth — is your reconciliation loop running on a schedule, and how soon does it catch drift?**
  - **A:** **Hourly reconciliation worker** that walks Stripe subscriptions → DB and DB → Stripe, flags drift to Sentry, auto-heals safe categories (status mismatch), pages on unsafe (price drift, quantity drift). Max drift detection lag: 1 hour.
  - **RepWorth today:** Tier-change pattern is Stripe-first with documented reconciliation contract; the reconciliation worker itself should run on cadence.

- **Does the customer billing portal handle [...all the things]?**
  - **A:** **Use Stripe Customer Portal for card/invoices/receipts/billing email/tax ID** (don't rebuild — Stripe maintains it). Build native UI for plan/location changes that need your business logic. Link to portal from Settings → Billing.

- **Dunning: how many retry attempts before suspension?**
  - **A:** Stripe Smart Retries (3 attempts over 21 days) + your own 7-day grace post-final-failure = 28 days from first failure to suspension. Branded dunning emails at days 1, 3, 7, 14, 21. Final email warns of suspension with a one-click recover link.

- **Failed payment handling: 7-day grace, then what?**
  - **A:** Day 1–7: full access + banner. Day 8–14: **read-only mode** (can view dashboard, can't approve/publish responses — protects the customer). Day 15+: full lockout, data retained 90 days. Never delete data on payment failure.
  - **RepWorth today:** 7-day past_due grace is implemented; checkout is blocked for past_due (recent fix).
  - **Gap → action:** Add the banner + countdown UI, plus the read-only-mode transition at day 8.

- **Tax handling: Stripe Tax enabled?**
  - **A:** **Yes — turn on Stripe Tax day 1.** Manual sales-tax compliance across 50 US states is a part-time job you can't afford. Enable for US + EU + UK + AU + CA. Re-evaluate nexus quarterly (TaxJar or Anrok if Stripe Tax limits hit).

- **Refund policy, chargeback workflow, dispute response process?**
  - **A:** Published 30-day money-back guarantee on first paid month. Pro-rated refunds at discretion thereafter. Chargeback response template lives in `docs/runbooks/chargebacks.md` with Stripe evidence checklist. Respond to every chargeback within 48h (default loss otherwise).

- **Are there any race conditions left between Stripe webhook ordering and your DB state?**
  - **A:** Webhooks are not ordered — handle every webhook as **idempotent + commutative** (each event computes the desired state from Stripe API, doesn't increment from current DB state). Use Stripe's `event.id` as idempotency key in an `processed_stripe_events` table.

- **Invoicing for enterprise/annual: NET-30, PO numbers, custom invoice line items?**
  - **A:** Stripe Invoicing supports all of this. Build a manual deal-desk flow for the first 5 enterprise deals before automating.

- **Cancellation flow: self-serve, with retention prompts and exit survey?**
  - **A:** **Self-serve in Settings → Billing → Cancel.** Retention prompts: pause for 60 days, downgrade to lower tier, talk to founder (Calendly link). Required 4-question exit survey (reason / what would have changed your mind / NPS / can we contact you in 6 months). Target save-rate: 20–30%.

---

## 6. Onboarding & Activation

- **Time-to-first-value: from signup → first auto-drafted response on a real review — how many minutes?**
  - **A:** Goal: **< 10 minutes from email confirmation to first AI-drafted response visible**. Measure as `time_to_first_draft` event. Anything > 30 minutes correlates with churn.

- **Is the Google Business Profile connection flow idiot-proof? What % of new signups drop at OAuth?**
  - **A:** Target **OAuth drop-off < 15%**. Measure with funnel analytics. The two killers are: (1) owners who don't know they're not the GBP admin, and (2) browser-extension/popup-blocker issues. Mitigations: pre-OAuth screen that asks "Are you the verified manager of your Google Business Profile?" with a help link, and a fallback flow with screenshots for users who hit a blocker.

- **Do you have an in-app checklist or product tour?**
  - **A:** **Hand-rolled checklist component** with 5 items: connect GBP → set brand voice → review first AI draft → approve first response → invite a teammate. Show in dashboard until complete. Don't pay for Appcues at this stage — the checklist is part of your product, not a third-party overlay.

- **For SMB owners who aren't technical, is there a "we'll do it for you" white-glove onboarding option at higher tiers?**
  - **A:** Yes — **30-min onboarding call included on Growth, dedicated CSM included on Scale**. The call is also customer research goldmine. Calendly + Zoom + a checklist; no fancy tooling needed until you have 50+ calls/month.

- **Multi-location onboarding: can a regional manager bulk-add 50 locations via CSV/API?**
  - **A:** **CSV import + bulk OAuth (one consent for all locations in the manager's GBP account)**. Show row-by-row validation errors. Cap CSV at 500 rows per import. API option follows in v2.
  - **RepWorth today:** CSV import exists; recent fixes hardened error handling and audit logging.
  - **Gap → action:** Publish the CSV template publicly with field docs.

- **Sample data / demo mode for prospects who want to evaluate before connecting their real GBP?**
  - **A:** **Yes — "Try with sample data" button on signup** that loads a pre-built demo business with 20 reviews across the star spectrum. Lets prospects feel the product without committing to OAuth. Convert rate from sample-data users is typically 2x higher than blank-state.

- **What's the empty-state experience when a customer has no reviews yet?**
  - **A:** Not "no reviews yet" — **"You're ahead of the curve. Here's what to do while you wait for your next review:"** with 3 actions: train brand voice with past responses, invite teammates, set notification preferences. Empty states are activation moments.

---

## 7. Observability, Logging & Monitoring

- **Sentry is wired up — what's the alert SLO?**
  - **A:** **P0 issues (auth/billing/data loss) page within 5 min, P1 (worker errors, ingestion failures) Slack within 15 min, P2 (UI errors) digest daily.** Tune to < 5 false alerts per week or you'll start ignoring them. Suppress noisy known-issues with Sentry inbound filters.

- **Do you have structured logging with `account_id` and `business_id` on every log line?**
  - **A:** Yes — use a logger middleware that injects `account_id`, `business_id`, `request_id`, `user_id` into every log via AsyncLocalStorage. Centralize in Better Stack, Axiom, or Datadog Logs. JSON format, never console.log strings.

- **Metrics: do you track funnel events?**
  - **A:** **PostHog is the right choice** at this stage (free up to 1M events/mo, product analytics + session replay + flags + experiments in one). Standard events: `signup_started`, `email_verified`, `gbp_connected`, `first_review_ingested`, `first_response_drafted`, `first_response_approved`, `first_response_published`, `trial_ended`, `subscription_started`, `subscription_canceled`. Document the taxonomy in `docs/analytics/events.md`.

- **Is there a real-time ops dashboard?**
  - **A:** **One dashboard, three panels: queue depth (BullMQ), worker lag (job age p95), error rate (Sentry).** Plus a Stripe webhook lag panel. Better Stack or Grafana Cloud. Bookmark it.

- **BullMQ: is there a Bull Board?**
  - **A:** **Yes — Bull Board behind admin auth at `/admin/queues`.** Read-only by default, retry/remove gated by a separate admin flag. Saves hours of "is this job stuck?" debugging.

- **Synthetic monitoring on critical paths?**
  - **A:** Better Stack or Checkly hits: `/api/health`, `/login`, `/signup`, and a synthetic webhook-ingestion path every 5 minutes. Page on 3 consecutive failures.

- **On-call rotation and paging — even as a solo founder, what wakes you up at 3am vs. waits until morning?**
  - **A:** **3am: auth down, Stripe webhook signature invalid (security), data integrity alert, any P0.** Morning: queue lag, model fallback rate spike, dunning email failures. Use BetterStack / Pagerduty / opsgenie. Document the trigger conditions so future-you doesn't second-guess at 3am.

---

## 8. Reliability, SRE & Incident Response

- **What's the published uptime SLO? Is there a status page?**
  - **A:** **99.9% monthly uptime** (≈ 43 min/mo downtime allowed) on customer-facing surfaces. **99.5% on background processing** (worker can lag without "downtime"). Status page on **Instatus** or **BetterStack** — auto-fed by synthetic checks. Public.

- **Define an incident: P0/P1/P2/P3 with response-time commitments.**
  - **A:** P0 = customer-impacting outage / data loss / security breach → acknowledge < 15 min, communicate < 30 min, target resolution < 4 hr. P1 = degraded service for many → ack < 1 hr, resolve < 24 hr. P2 = limited impact → next business day. P3 = cosmetic → backlog. Public-facing comms on P0/P1.

- **Runbook coverage: for each top-10 alert, is there a documented runbook?**
  - **A:** Yes, in `docs/runbooks/`. Each runbook: trigger, first 5 commands to run, escalation path, rollback steps.
  - **RepWorth today:** Strong runbook coverage exists (`operational-runbook.md`, multi-location, zernio, email deliverability, etc.). Continue the pattern as new alerts appear.

- **Disaster recovery RPO/RTO targets. Tested?**
  - **A:** **RPO ≤ 1 hour (Supabase PITR), RTO ≤ 4 hours** (full restore + DNS + worker boot). Run a **quarterly DR drill** that restores prod backups to a staging project and runs a smoke test. Document the runbook.

- **Database backups: Supabase PITR is on, but have you restored from it end-to-end at least once?**
  - **A:** **Restore it now, before you need to.** First-time restore reveals every config assumption your code makes about DB state. Schedule a quarterly drill on the calendar.

- **Multi-region failover plan, or accept Vercel/Railway/Supabase region as single point of failure?**
  - **A:** **Accept single-region for the first 12 months.** Multi-region adds complexity that costs more than it saves at < $100k MRR. Plan: document the dependency, communicate honestly on the status page, revisit at $500k ARR or first enterprise deal that demands it.

- **Postmortem template and culture?**
  - **A:** **Blameless postmortem in `docs/postmortems/YYYY-MM-DD-incident.md` for every P0 and select P1s.** Template: timeline, impact, root cause, what went well, what didn't, action items with owners and dates. Share publicly on the blog for transparency wins.

---

## 9. Security & Compliance

- **Have you done a third-party penetration test? OWASP Top 10 sweep?**
  - **A:** Before $50k MRR: **Cure53, Latacora, or Doyensec for a $5–15k pentest**. Run [OWASP ZAP](https://www.zaproxy.org/) and [Snyk](https://snyk.io/) in CI before then. Repeat pentest annually or after major architecture changes.

- **Secrets management: are all secrets in Vercel/Railway env vars with rotation policy?**
  - **A:** **All secrets in Vercel/Railway/Supabase env stores, never in code or `.env` checked in.** Rotation: Stripe webhook secret every 6 months, Supabase service key annually, OAuth refresh tokens per-customer (automatic), API keys quarterly. Use **Doppler** or **Infisical** if you have > 30 secrets to centralize.

- **Are approval tokens, OAuth refresh tokens, and any PII encrypted at rest beyond Supabase defaults?**
  - **A:** Approval tokens: **only SHA-256 hashes stored** (per architecture invariant — already enforced). OAuth refresh tokens: **envelope-encrypted** with a KMS key (AWS KMS, GCP KMS, or Supabase Vault). PII (customer names, emails) relies on Supabase encryption at rest + column-level encryption for SSN-equivalent (you don't store any — keep it that way).

- **SOC 2 Type I/II — when is this on the roadmap?**
  - **A:** **Drata or Vanta starting at $50k MRR** ($7–15k/year), Type I in 3 months, Type II in 9–12 more. Required for any enterprise deal. Start the controls *now* (access review cadence, change management, vendor risk) so the audit is paperwork, not panic.

- **GDPR: right to access, right to deletion, data processing agreement, sub-processor list?**
  - **A:** Self-serve export + delete (see §3), DPA template ready to sign (Stripe, Resend, Supabase all have one — chain them through), sub-processor list public at `/legal/sub-processors`. Appoint a DPO if you have > 250 EU users (you can be your own DPO at first).

- **CCPA equivalent for California customers?**
  - **A:** Same self-serve flows satisfy CCPA + EU GDPR + Brazil LGPD + Canada PIPEDA. Add a "Do Not Sell My Info" link in the footer (even though you don't sell — required disclosure in CA).

- **HIPAA — not applicable, but verify you're not collecting PHI inadvertently.**
  - **A:** **You're not BAA-covered**, so reviews must never contain PHI. Add a hard ban + scanner that flags reviews with potential PHI patterns (medical record numbers, specific diagnoses). Refuse to onboard dentists/medspas unless they confirm GBP reviews don't contain PHI (they don't, by GBP policy, but get it in writing).

- **Vulnerability disclosure / responsible disclosure policy and security.txt?**
  - **A:** Yes — `/security.txt` at well-known URL, public policy page at `/security`. Use [security.txt generator](https://securitytxt.org/). Define scope, safe harbor, contact (security@), bounty (start with hall-of-fame + swag, paid bounty at $100k MRR).

- **Dependency scanning?**
  - **A:** **Dependabot or Renovate on auto-merge for patch + minor security updates.** Snyk or Socket.dev for SCA + supply-chain attack detection. Manual review for major version bumps.

- **Container/runtime scanning for the Railway worker?**
  - **A:** **Trivy in CI** on the Dockerfile + Railway image. Fail build on CRITICAL CVEs. Re-scan weekly even with no code change (CVE database updates).

- **Web application firewall in front of Vercel?**
  - **A:** **Vercel WAF** (built in) or **Cloudflare** if you need more control. Block: SQL injection patterns, XSS patterns, known-bad IPs, geo-block tier-2 abuse origins if you have no customers there.

- **Rate limiting on every public endpoint?**
  - **A:** Yes — **Upstash Ratelimit** (you already have Upstash) per IP and per `account_id`. Different limits per endpoint type: auth (5/min), API (100/min), webhook (no limit but signature-verified).

- **CSP headers, HSTS, secure cookies, CSRF protection — audited recently?**
  - **A:** Run [securityheaders.com](https://securityheaders.com/) scan, aim for A+. CSP must be strict (no `unsafe-inline`, no `unsafe-eval`). HSTS with `preload` + submitted to [hstspreload.org](https://hstspreload.org/). Cookies: `Secure; HttpOnly; SameSite=Lax`. CSRF tokens on every state-changing form.

---

## 10. Trust & Safety

- **Content moderation: what if a customer instructs the AI to write defamatory or discriminatory responses?**
  - **A:** **Three-layer defense.** (1) Prompt-level: system prompt forbids defamation, discrimination, false promises (refunds, discounts), legal admissions. (2) Output-level: classifier (OpenAI Moderation API or in-house) scans every draft, blocks high-confidence violations. (3) Policy-level: ToS forbids misuse, repeat violators warned then suspended. The owner-approval requirement is your final firewall.

- **Abuse detection: signup spam, prompt injection, brand-impersonation?**
  - **A:** Signup spam: email validation (no disposable domains), IP reputation, CAPTCHA on suspicious patterns. Prompt injection in review text: sanitize review content as data, never as instructions; use structured prompts that quote review text in delimited blocks. Brand-impersonation: forbid in ToS, monitor for "respond as Wendy's" style prompts.

- **Fair-use limits on AI generation per plan?**
  - **A:** **Yes — soft cap aligned with review-volume limit per plan.** Heavy-usage customers will exist; price them into a higher tier rather than throttling.

- **Terms of Service violation enforcement workflow?**
  - **A:** Founder decides for first 12 months. Process: complaint received → 7-day investigation → warning email with cure period → suspension if uncured → permanent ban for severe (CSAM, fraud, defamation campaign). Document every enforcement in `docs/trust-safety/cases/`.

- **Customer-reported abuse path?**
  - **A:** `report@repworth.com` mailbox + in-app "Report abuse" form on every review/response. SLA: ack < 24h, resolve < 7 days. Track in the same case log.

---

## 11. Data, Analytics & BI

- **Customer-facing analytics: response rate, sentiment trend, review volume, star-rating trend, time-to-respond?**
  - **A:** **Five KPIs on the dashboard home:** response rate (%), avg star rating, review volume MoM, avg time-to-respond, sentiment trend. Per-location toggle on Growth+, roll-up on Scale. Export to CSV/PDF for marketing managers who report up.

- **Per-location vs. roll-up reporting for multi-location customers?**
  - **A:** **Both, always.** Roll-up by default, per-location filter one click away. Multi-location customers buy on this — don't underweight the polish.

- **Internal BI: cohort retention, churn drivers, feature adoption?**
  - **A:** **PostHog covers 80% of needs** (cohorts, retention, funnels, dashboards) at this stage. Upgrade to **Metabase on a Supabase read-replica** when you need custom SQL. Skip Hex/Mode until $1M ARR.

- **Is there a data warehouse?**
  - **A:** **Not yet.** Supabase + PostHog covers BI through $500k ARR. When you outgrow it, **BigQuery + dbt + Fivetran** is the standard SMB-SaaS stack.

- **Event tracking taxonomy documented?**
  - **A:** **Yes — `docs/analytics/events.md` is the single source of truth.** Naming: `noun_verb_past_tense` (`response_published`, not `publishResponse`). Properties typed and documented. Adding an event = PR with doc update. Use [Avo](https://www.avo.app/) or [Iteratively](https://iterative.ly/) if you have > 50 events.

---

## 12. Performance & Scalability

- **Load test: at what concurrent webhook ingestion rate does the worker fall over?**
  - **A:** Know the number. **Run k6 or Artillery against staging**, ramp from 1 → 1000 webhook/sec, find the breakpoint. Document in `docs/runbooks/load-test-2026-XX.md`. Repeat after every architecture change.

- **DB connection pool sizing on Supabase + PgBouncer — headroom verified?**
  - **A:** Supabase Pro is **15 direct + 200 transaction-pooled** by default. Worker should use transaction-pooled mode (port 6543). Monitor `pg_stat_activity` count vs. ceiling. Alert at 80% utilization.

- **BullMQ queue throughput ceiling per worker — is autoscaling configured on Railway?**
  - **A:** **Yes — Railway autoscaling on CPU/memory + horizontal worker replicas.** BullMQ scales horizontally cleanly (it's Redis-backed). Set min 1, max 5 replicas for first year. Job concurrency per worker = CPU cores × 2 for I/O-bound.

- **Largest single account scenario: a chain with 500 locations and 10K reviews/month — does the UI still load, can the worker keep up?**
  - **A:** **Test it explicitly.** Seed a test account at 500 locations / 10k reviews and walk every UI page. Look for N+1 queries, unbounded lists, missing pagination. The 10k/month review volume is trivial for the worker; 500-location dashboard load is the real risk.

- **Critical path API p50/p95/p99 latency budgets defined and tracked?**
  - **A:** Login p95 < 500ms, dashboard load p95 < 1.5s, response generation p95 < 8s, webhook ingestion p95 < 200ms. Track in PostHog or Vercel Analytics. Alert on 2x budget for 5 min.

- **Frontend Lighthouse scores — Core Web Vitals on LCP/INP/CLS?**
  - **A:** **Target Performance ≥ 90, Accessibility ≥ 95, Best Practices = 100, SEO ≥ 90** on the marketing site and dashboard home. LCP < 2.5s, INP < 200ms, CLS < 0.1. Track with Vercel Speed Insights or [web.dev/measure](https://web.dev/measure/).

---

## 13. Customer Support

- **Support channels: in-app chat, email, knowledge base, community forum?**
  - **A:** **Day 1: email (Help Scout) + in-app chat (Plain or Crisp) + docs site (Mintlify or Docusaurus).** Skip community forum until you have 500+ customers asking the same questions.

- **Response SLA by tier?**
  - **A:** Starter: 24 business hours. Growth: 8 business hours. Scale: 2 business hours + dedicated CSM. Publish on the support page. Auto-responder confirms receipt with ticket ID.

- **Tooling: help desk?**
  - **A:** **Help Scout** for email + shared inbox + knowledge base (one tool, $25–50/agent/mo). Plain if you want a more modern feel and Slack-style threads. Avoid Zendesk until > 5 agents.

- **Internal admin tool to impersonate a customer?**
  - **A:** **Yes, behind feature flag + 2FA + audit log of every impersonation.** "Login as customer X for support ticket Y, reason Z" — every action logged with `actor_user_id` (admin) + `impersonated_user_id`. Time-boxed sessions (1 hour).

- **Macros / canned responses for the top 20 questions?**
  - **A:** Yes — built into Help Scout. Track the top 20 questions monthly; if a question is in the top 5 for 2 months, write a knowledge-base article and update the macro to link it.

- **Self-serve knowledge base?**
  - **A:** **Mintlify** or **Docusaurus** at `docs.repworth.com`, indexed by Google, fully searchable. Top 5 articles drive ~60% of self-serve resolutions: how to connect GBP, why is my response pending, how to set brand voice, pricing/billing FAQ, multi-location setup.

---

## 14. Customer Success & Retention

- **Health scoring: how do you know which customers are at risk of churning before they cancel?**
  - **A:** **Composite health score** = login frequency (last 14d) + responses approved (last 30d) + review volume trend + NPS + support ticket sentiment. Score 0–100. Anything < 40 is flagged for intervention. Even a manual spreadsheet of "who hasn't logged in in 14 days" beats nothing.

- **NPS / CSAT survey cadence and target scores?**
  - **A:** **NPS quarterly via Delighted or in-product modal, target ≥ 40 (good for SMB SaaS).** CSAT after every support interaction, target ≥ 90%. Follow up on every detractor personally for first 12 months.

- **Lifecycle email automation: welcome series, milestone celebrations, re-engagement, win-back?**
  - **A:** **Customer.io or Loops** for lifecycle. Five sequences: welcome (5 emails over 14 days), activated (3 emails over 30 days), at-risk (3 emails to inactive users), win-back (30/60/90 day post-churn), milestone (100th response, 1-year anniversary, etc.).

- **Quarterly business reviews for top accounts?**
  - **A:** **For accounts > $500/mo MRR, yes — quarterly 30-min call.** Template: review value delivered (responses published, time saved, $ value), roadmap preview, listen for expansion or risk signals. Founder-led until you hire a CSM.

- **Voice-of-customer program?**
  - **A:** **Canny.io for public feature requests** (or a board built in-house). Roadmap derived from Canny votes + interview themes + strategic bets. Close the loop publicly when shipping ("This was suggested by @customer in March — here it is").

---

## 15. Sales & Go-to-Market Operations

- **Is it pure PLG, sales-assisted, or sales-led?**
  - **A:** **PLG primary, sales-assisted for multi-location (3+ locations) and enterprise.** Self-serve signup → trial → paid for solo and small ops. Demo + onboarding call for multi-location. Custom-deal for 25+ locations. Match motion to ACV: < $100/mo PLG, $100–500 sales-assisted, $500+ sales-led.

- **CRM integrated with billing data?**
  - **A:** **HubSpot Starter ($20/mo)** or **Attio** for first 100 customers, integrate Stripe via Zapier or native. Lifecycle stage synced from Stripe (trial → paid → churned). Don't over-build the CRM stack early.

- **Lead scoring, MQL → SQL handoff?**
  - **A:** Skip lead scoring until > 100 inbound leads/mo. Until then: every demo request is hand-qualified, every trial is monitored. When you scale: simple rules-based scoring (locations > 5 = SQL, on Scale page > 60s = MQL).

- **Demo environment that resets cleanly between prospects?**
  - **A:** **Yes — `demo.repworth.com` with a nightly reset Cron**, pre-seeded with 3 example businesses + 50 reviews + sample responses. Tag every demo session with the prospect's email for follow-up.

- **Sales collateral?**
  - **A:** One-pager (PDF), demo deck (10 slides max), ROI calculator (Google Sheet or in-product), 3 case studies (even if anonymous early), feature-comparison vs. Birdeye/Podium/NiceJob. Stored in Notion or a sales-enablement folder.

- **Partner / agency / reseller program?**
  - **A:** **Not until 10 inbound partner asks.** Then: 20% recurring commission for first 12 months, partner portal with reporting, co-branded landing pages. Likely your fastest growth lever once PMF is proven — agencies serve dozens of SMBs.

---

## 16. Marketing & Growth

- **SEO foundation: programmatic landing pages?**
  - **A:** **Yes — programmatic SEO is gold for SMB SaaS.** Templates: `/respond-to-google-reviews-for-[vertical]`, `/[city]-reputation-management`, `/alternatives-to-[competitor]`. Generate 200–500 pages with real, unique content (not spun). Aim for one organic signup/month per page within 12 months.

- **Content marketing: blog publishing cadence?**
  - **A:** **1 long-form (1500+ words) SEO-targeted post per week.** Topics: "how to respond to a 1-star review (template)", "what AI can and can't do for review management", vertical playbooks. Distribute on LinkedIn (the SMB-owner channel that converts), Twitter/X, owner-focused communities.

- **Referral program?**
  - **A:** **Yes by month 6.** Mechanic: give one month, get one month. In-product share link in every dashboard. Attribution via signed referral tokens. Target 15–20% of new MRR from referrals within 12 months — the gold-standard SMB SaaS lever.

- **Affiliate program separate from referral?**
  - **A:** **Add at month 9 if growth justifies.** Tools: Rewardful or PartnerStack. 20% recurring, 12-month attribution window. Recruit from SMB-marketing newsletters and YouTubers.

- **Paid acquisition channels and CAC by channel?**
  - **A:** Track CAC by channel from day 1 (UTMs + PostHog). Likely winners for RepWorth: Google Ads on "respond to google reviews" intent keywords, Meta retargeting from blog visitors, vertical-specific newsletter sponsorships. Target CAC < 4 months of payback.

- **Attribution: which tool ties first-touch through to revenue?**
  - **A:** **PostHog** handles end-to-end attribution if you instrument signup with UTMs. Upgrade to **Dreamdata** or **HockeyStack** when paid spend > $10k/mo.

- **Email marketing platform?**
  - **A:** **Loops or Customer.io for lifecycle + product emails**, separate from Resend transactional. Marketing list lives there. Segment by lifecycle stage, vertical, tier.

---

## 17. Legal & Compliance Docs

- **Terms of Service, Privacy Policy, Acceptable Use Policy, DPA, Cookie Policy — current, lawyered, and versioned?**
  - **A:** Drafts ready, **lawyered before charging the first customer**. Use **Termly** or **iubenda** for first-pass draft, then $500–1500 for a SaaS-specialist lawyer (Cooley GO templates, ClerkyHQ, or a recommended local). Version-control in repo, link from footer, prompt for re-accept on material changes.
  - **RepWorth today:** `docs/Legal/repworth-privacy-policy.md` and `repworth-terms-of-service.md` exist as drafts.
  - **Gap → action:** Get them lawyered. Add AUP + DPA + Cookie Policy.

- **AI usage disclosure: do you disclose that responses are AI-generated where required by law?**
  - **A:** **Yes — explicit disclosure in ToS, privacy policy, and at point-of-approval in product.** EU AI Act (effective Aug 2026) requires disclosure for AI-generated content interacting with consumers. California SB 942 (Jan 2026) requires similar. The owner-approved-and-posted response need not be marked AI-generated to the reviewer (it's owner-edited speech), but the *generation* must be disclosed to the customer.

- **Google Business Profile API Terms of Service — are you compliant?**
  - **A:** **Yes, audit annually.** Critical clauses: no auto-posting without owner consent (you're compliant), respect rate limits, no caching beyond TTL, attribution where required, no scraping. Document compliance in `docs/legal/gbp-compliance.md`.

- **Data Processing Addendum ready for B2B customers?**
  - **A:** **Yes — standard DPA based on GDPR Art. 28**, downloadable from `/legal/dpa`, e-signable via DocuSign or HelloSign. Required for any EU/UK customer and any large US customer.

- **Sub-processor list public and maintained?**
  - **A:** **Yes at `/legal/sub-processors`.** Current list: Stripe (payments), Supabase (DB+auth), Vercel (hosting), Railway (worker hosting), Upstash (Redis), Resend (email), Twilio (SMS), OpenAI (AI), Anthropic (AI fallback), Zernio (review ingestion), PostHog (analytics), Sentry (errors). Notify customers 30 days before adding new.

- **Insurance: E&O, cyber liability, general liability?**
  - **A:** **By first paid customer: $1M E&O + $1M Cyber.** Vouch, Embroker, or Coalition are SaaS-friendly insurers. General liability follows when you have an office. Required by most enterprise contracts.

---

## 18. Internationalization & Localization

- **Is the product i18n-ready?**
  - **A:** **Architect for i18n now (string extraction via `next-intl` or `i18next`), but ship English-only for 12 months.** Don't pay for translation until you have 50+ non-English-speaking customers asking. AI response generation in their native language is the bigger lever than UI translation.

- **Currency: USD only, or multi-currency billing?**
  - **A:** **USD only for the first 12 months** — Stripe will present in customer's local currency at checkout. Multi-currency billing (charging in EUR/GBP) follows when EU revenue > 20%.

- **Tax handling per jurisdiction?**
  - **A:** Stripe Tax handles 50+ jurisdictions automatically. Confirm nexus quarterly. See §5.

- **AI response generation in non-English languages?**
  - **A:** **GPT-4o-mini and Claude Haiku both handle Spanish, French, German, Italian, Portuguese, Japanese natively.** Quality-test by language with a 20-review eval set per language. Brand voice tuning must be language-aware (don't apply English brand voice to Spanish responses).

- **Customer support hours and languages?**
  - **A:** **English-only, US business hours (9–6 ET), 24h SLA for non-urgent.** Add Spanish at 100 Hispanic-market customers. Avoid 24/7 support commitments until you have 10+ agents.

---

## 19. Accessibility

- **WCAG 2.1 AA conformance audited?**
  - **A:** **Annual audit by an accessibility specialist** ($2–5k) once you have customers. Use **axe DevTools** + **Pa11y in CI** for ongoing checks. Block PRs that introduce new violations.

- **Keyboard navigation, screen reader testing, color contrast?**
  - **A:** Test every release with keyboard-only navigation and screen reader (NVDA or VoiceOver). Tab order, visible focus states, ARIA labels on icon buttons, color contrast ≥ 4.5:1. Build a checklist into your design system.

- **Public VPAT for enterprise procurement?**
  - **A:** **Required for enterprise.** Generate via [accessibility.works](https://accessibility.works/) or your auditor at first enterprise ask. Publish at `/legal/vpat`.

- **This matters now that you're targeting SMBs — but doubly so if you ever sell to government or education.**
  - **A:** **Section 508 compliance is gov/edu table stakes.** Don't pursue gov/edu until WCAG 2.1 AA is locked.

---

## 20. API, Integrations & Extensibility

- **Public REST or GraphQL API for customers to integrate?**
  - **A:** **REST API on Scale tier**, OpenAPI 3.1 spec auto-generated from route handlers. Versioned at `/api/v1/`. Sunset policy: 12 months notice for breaking changes. GraphQL adds complexity that SMB customers don't ask for — skip it.

- **Webhooks customers can subscribe to?**
  - **A:** **Yes — `review.received`, `response.drafted`, `response.approved`, `response.published`, `response.flagged`, `subscription.changed`.** Use a managed webhook platform like **Svix** to handle retries, signing, deliverability. Don't roll your own — webhook reliability is a tar pit.

- **Zapier app — official, certified?**
  - **A:** **Yes, by month 9.** SMBs live in Zapier. Common Zaps: review.received → Slack, response.flagged → Email, subscription.changed → CRM. Build it, get certified, list publicly. Free distribution channel.

- **Make/n8n integrations?**
  - **A:** **Make.com integration after Zapier**, n8n via webhook (no native module needed early). 80% of SMB Make/Zapier users overlap with Zapier.

- **Native integrations on the roadmap?**
  - **A:** Priority order: **Slack (notifications) → Microsoft Teams → HubSpot CRM → Google Sheets (export) → Square / Toast / Mindbody (vertical POS)**. Each integration unlocks a vertical. Don't build until 5+ customers ask for the same one.

- **API rate limiting, API key management, scoped API tokens?**
  - **A:** **100 req/min default, scoped tokens (read-only vs. read-write vs. admin), rotatable in Settings → API.** Audit log every API token use. Public API quotas published.

- **OpenAPI/Swagger docs auto-generated and current?**
  - **A:** **Yes — auto-generated from route handler types** (zod-to-openapi if you're using Zod, or `tsoa`). Hosted at `docs.repworth.com/api`. Live "try it" via Mintlify or Swagger UI.

---

## 21. Mobile

- **Is the web app responsive enough that a salon owner can approve a response from their phone in 5 seconds?**
  - **A:** **Yes — mobile-first responsive design, approve in 2 taps from notification.** Test on real iPhone SE and a low-end Android weekly. PWA install prompt for owners who use it daily.

- **Native iOS/Android apps — on the roadmap or out of scope?**
  - **A:** **PWA covers 80% of value. Native is on the 18-month roadmap, not the 12-month.** Native unlocks push notifications and offline drafting; both real but not launch-blocking. Build native when daily active users exceed weekly active users (signal that mobile is the primary surface).

- **Push notifications for "new low-rating review needs approval"?**
  - **A:** **Web push from PWA + email + optional SMS** day 1. Native push follows native apps.

- **SMS approval flow (you have Twilio) — is the UX tested with non-technical users?**
  - **A:** **Test with 5 actual SMB owners, not your friends.** SMS approval is killer feature for owners who don't open email. Reply YES/EDIT/REJECT, with signed token-per-review. Test confusion points: ambiguous YES interpretation, multi-review batching, opt-out flow.

---

## 22. AI/LLM Operations

- **Model versioning: when GPT-4o-mini changes behavior, how do you detect regression on response quality?**
  - **A:** **50-review eval set checked into repo**, run on every model bump and weekly in CI. Score with a rubric (tone, accuracy, length, brand voice match) — either human-graded weekly or LLM-as-judge with spot-check. Block model upgrade if any score drops > 5%. Pin model version explicitly (`gpt-4o-mini-2024-07-18`, not `gpt-4o-mini`).

- **Prompt versioning, A/B testing, and rollback?**
  - **A:** **Prompts in version-controlled files**, `prompt_version` recorded with every generation. Feature-flag-gated A/B tests via PostHog or GrowthBook. Rollback = revert prompt file, redeploy.

- **Cost per response tracked per customer for unit economics?**
  - **A:** **Yes — log token counts + model + cost per generation, aggregate per customer in BI.** Target: < $0.05/response on GPT-4o-mini. Customers exceeding $5/mo in LLM costs flagged for tier upsell or rate limiting.

- **Hallucination guardrails: never invent facts about the business, never promise refunds/discounts?**
  - **A:** **System prompt explicitly forbids inventing details, promising compensation, admitting fault legally, or referencing competitors.** Output classifier scans for forbidden patterns (price quotes, refund offers, medical/legal advice). Block + flag for human review.

- **Brand voice tuning per customer — fine-tuned, RAG, or prompt-engineered?**
  - **A:** **Prompt-engineered with example-shot from customer's past responses** (5–10 owner-written responses as in-context examples). Cheaper than fine-tuning, faster to iterate, owner can adjust by editing examples. Add RAG over the customer's website/menu/services for accuracy.

- **Output safety: profanity filter, defamation filter, no PII leakage?**
  - **A:** Profanity filter (regex + classifier), defamation filter (no naming competitors negatively), PII leakage prevented by **strict tenant scoping of context fed to the prompt** (architecture invariant — already enforced). Add a paranoid test: feed a prompt with cross-tenant data, assert generation fails.

- **Fallback model behavior tested (you have Claude Haiku as fallback)?**
  - **A:** **Yes — eval set runs on both models, side-by-side comparison weekly.** If Claude Haiku quality drops > 10% below GPT-4o-mini, escalate to Sonnet for fallback instead. Track fallback rate — > 5% means OpenAI reliability issue worth alerting on.

- **Audit log of every LLM call?**
  - **A:** **Yes — `llm_calls` table with `account_id`, `business_id`, `prompt_version`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `latency_ms`, `flagged`, `created_at`.** Retain 90 days for debugging, longer if you can afford it. Critical for cost analysis + quality regression hunts.

---

## 23. Testing & QA

- **Unit, integration, and E2E coverage — what's the gate to merge?**
  - **A:** **CI passes (unit + integration), TypeScript clean, no new lint errors, code review approved.** Don't gate on coverage % — gate on critical-path coverage (auth, billing, ingestion, approval, publishing must each have integration tests). Aim for 70%+ on critical modules, accept lower on UI.

- **Test against a real Stripe sandbox, real Supabase test project, real Redis — or all mocked?**
  - **A:** **Mock external services in unit tests. Use Stripe test mode + a real Supabase test project + Upstash dev for integration tests.** Skip E2E if `TEST_DATABASE_POOL_URL` not set (graceful — you already do this for Playwright). Integration tests > mocks for billing — too easy to mock away the bug.

- **Synthetic checks against production after every deploy?**
  - **A:** **Yes — post-deploy smoke test** runs against prod via GitHub Actions: login, dashboard load, create-and-publish-test-response (on a dummy test-account). Alert if smoke fails.

- **Visual regression tests for the UI?**
  - **A:** **Chromatic** or **Percy** on critical pages (dashboard home, review detail, approval modal, settings). Approve diffs as part of PR review. Optional for solo founder; high value once a designer joins.

- **Load tests in CI or only manual?**
  - **A:** **Manual quarterly + on architecture changes.** k6 or Artillery script in repo, runs against staging on demand. Full continuous load testing is overkill until you have a perf-sensitive customer.

- **Chaos engineering / fault injection on the worker?**
  - **A:** **Lightweight chaos: kill the worker mid-job once a quarter in staging**, verify retry + idempotency. Full chaos engineering (Gremlin, Chaos Mesh) is overkill until you have reliability customers.

---

## 24. DevOps & Deployment

- **Preview deployments per PR on Vercel — also for the Railway worker?**
  - **A:** **Yes — Vercel previews built-in, Railway PR environments via the GitHub integration.** Each PR gets a unique URL + a worker preview. Critical for code review (see the UI, not just the diff).

- **Database migrations: rollback strategy, zero-downtime patterns, dry-run on staging?**
  - **A:** **All migrations dry-run on staging first, reviewed for zero-downtime patterns (no column drops without app deploys, no NOT NULL adds without backfill).** Rollback strategy: down migrations for every up migration, tested on staging. Use Supabase migration tool.
  - **RepWorth today:** Migrations are owner-run via Supabase SQL editor; this matches the documented pattern but constrains automation.
  - **Gap → action:** Consider gradual move to CI-applied migrations on staging (still owner-run on prod) at first hire.

- **Feature flags (Statsig, LaunchDarkly, GrowthBook, PostHog) — used for gradual rollout?**
  - **A:** **PostHog feature flags** if you're using PostHog for analytics (one less tool). **GrowthBook** if you want open-source self-hosted. Roll every new feature behind a flag. Default-off, 10% → 50% → 100% over a week.

- **Blue/green or canary deploys on Railway?**
  - **A:** **Railway's rolling deploys are sufficient at this scale.** Canary deploys (10% traffic to new version) require infrastructure you don't need yet. Revisit at 100k DAU.

- **Rollback playbook — last-known-good version pinned and ready?**
  - **A:** **Yes — `docs/runbooks/rollback.md`** with: Vercel rollback command, Railway rollback command, migration reversal steps, who-to-tell-when. Practice quarterly.

- **CI build time and developer feedback loop — acceptable?**
  - **A:** Target **CI < 10 minutes total** (lint + typecheck + unit + integration in parallel). Anything over 15 min kills iteration speed.

- **Secrets rotation cadence and process?**
  - **A:** See §9 — Stripe webhook secret every 6mo, service keys annually, OAuth refresh tokens per-customer (automatic), API keys quarterly. Calendar reminders + runbook for each.

---

## 25. Documentation

- **Internal: architecture decision records, runbooks, on-call docs?**
  - **A:** **Yes — `docs/adr/NNNN-title.md` for every significant architecture decision.** Template: context, decision, consequences, alternatives considered. ADRs are immutable (deprecate via new ADR, don't edit old ones). Runbooks already strong — keep adding.
  - **RepWorth today:** Strong runbook coverage. No ADRs yet (`docs/adr/` doesn't exist). CONTEXT.md doesn't exist.
  - **Gap → action:** Bootstrap `docs/adr/` with ADRs for the load-bearing decisions: outbox pattern, approval token hashing, Stripe-first tier change, multi-location billing-vs-location split.

- **External: API docs, integration guides, video tutorials, knowledge base?**
  - **A:** **Mintlify site at `docs.repworth.com`** — combines API docs, guides, KB articles, video embeds. SEO-indexed. Update with every release.

- **Are docs versioned and tested in CI (no broken links, no stale code samples)?**
  - **A:** **Yes — lychee or markdown-link-check in CI**, snippet executor for code samples (so they break the build when out of date). Docs versioned per major API release.

---

## 26. Financial Operations

- **Are you tracking ARR, MRR, NRR, GRR, CAC, LTV, payback period, gross margin, burn multiple?**
  - **A:** **All of them, monthly.** Bare minimum: MRR, new MRR, expansion MRR, churned MRR, NRR, GRR, CAC, payback period (months), gross margin (revenue minus COGS = hosting + AI + Stripe fees + Supabase + Resend + Twilio). Target gross margin ≥ 75% — anything lower means AI/hosting is eating you.

- **Stripe data flowing into a finance tool?**
  - **A:** **ProfitWell (free, by Paddle) for SaaS metrics, Stripe Sigma for SQL queries, Chargebee/Maxio if you outgrow Stripe billing logic.** ProfitWell handles MRR, churn, expansion automatically.

- **Cohort analysis by acquisition channel?**
  - **A:** **Yes — UTM-tagged signups, cohort retention by channel in PostHog or ProfitWell.** Critical for deciding where to double down on marketing spend.

- **Revenue recognition (especially for annual plans) handled correctly?**
  - **A:** **Recognize ratably over the subscription period**, not at invoice date. Stripe handles deferred revenue accounting if you use Stripe Revenue Recognition. Otherwise, your accountant or QuickBooks does it.

- **Financial model with 18-month runway projection?**
  - **A:** **Yes — model with three scenarios (conservative, base, ambitious)**, updated monthly. Inputs: MRR growth rate, churn, gross margin, opex burn, runway months. Bootstrapped: target profitability before $0 runway. Use Causal, Finmark, or a clean spreadsheet.

---

## 27. Team & Knowledge Management

- **Solo today — what's the first hire when revenue justifies it?**
  - **A:** **First hire at $20–30k MRR: Customer Success / Support generalist** (also handles ops, light QA). Frees the founder to keep selling and building. Engineering #2 follows at $50k+ MRR, after CS is no longer drowning. Avoid hiring a "VP of X" early — generalists who own end-to-end.

- **Onboarding doc for the day someone else joins?**
  - **A:** **`docs/onboarding/new-hire.md`** — local dev setup, runbook tour, "ship your first PR by end of week 1" task, who-to-ask-about-what map, access checklist. Maintain it now even alone — it's also your personal "if I lose my laptop" recovery doc.

- **Bus-factor: if you're hit by a bus, can someone else get into Stripe, Supabase, Vercel, Railway, GitHub, the bank?**
  - **A:** **Sealed envelope with master password + recovery codes given to a trusted attorney or family member, plus 1Password / Bitwarden emergency access set up.** Document the "what to do if Norbert is unavailable" runbook. Not optional once you have paying customers depending on you.

---

## 28. Customer Communications & Brand

- **Transactional email deliverability (Resend) — DKIM/SPF/DMARC configured?**
  - **A:** **Yes — DKIM, SPF, DMARC all set to enforce, domain warmed up over 2 weeks.** Monitor reputation via Google Postmaster Tools + Microsoft SNDS. Bounce rate < 2%, spam complaint rate < 0.1%.
  - **RepWorth today:** `docs/runbooks/email-deliverability.md` exists — keep it current.

- **Branded customer-facing emails?**
  - **A:** Yes — every transactional email matches the product brand (logo, color, voice). Use **React Email** or **Maizzle** for templating. Test rendering in Gmail, Outlook, Apple Mail, mobile clients.

- **In-app announcements / changelog widget?**
  - **A:** **Headway, Canny Changelog, or hand-rolled `/changelog` page surfaced via a "What's new" bell icon.** Show the latest 5 updates. Drives feature adoption.

- **Maintenance window communication policy?**
  - **A:** **48-hour advance notice for planned maintenance, via in-product banner + email + status page.** Emergency maintenance: real-time status page update + email within 5 minutes. Practice the comms template before you need it.

- **Breach notification template ready before you ever need it?**
  - **A:** **Yes — `docs/runbooks/breach-notification.md`** with: assessment checklist, GDPR 72-hour timer, CCPA notice template, customer email template, regulator contact list. Hope you never need it; have it ready.

---

## 29. Specific to RepWorth (gaps I'd probe first)

- **The approval flow is architecturally locked — but what's the operational backup if a customer claims a response was published without their approval? Audit trail strong enough for a dispute?**
  - **A:** **Audit trail must capture: approval_token_hash, user_id, ip, user_agent, timestamp, request_id, response_text_at_time_of_approval (immutable snapshot).** Stored append-only, retained 13 months minimum. In a dispute: customer signs declaration, you produce the audit record. The architecture invariant (hashed tokens, no auto-post) is your defense; the audit log is your evidence. Verify the audit log covers the *content* approved, not just the *event* of approval.

- **Multi-location billing just shipped — what's your monitoring on aggregated invoice correctness across the first 10 multi-location customers in production?**
  - **A:** **Reconciliation worker runs hourly on multi-location accounts**, compares DB-expected invoice line items vs. Stripe upcoming invoice, alerts on any drift > $0.01. Tag the first 10 multi-location accounts with a `pilot=true` flag, manually inspect their first 3 invoices end-to-end before automating away.

- **Zernio is your only review ingestion source. What's the contingency if Zernio raises prices, changes terms, or goes down?**
  - **A:** **Build the abstraction layer for a second source now** (you already have `ReviewSource` contract per architecture invariant — preserve it). Spike on direct Google Business Profile API for a 30-day fallback POC. Negotiate Zernio contract with a 30-day price-change notice. Single-source-dependency is your top concentration risk; commercially treat it like an existential one.

- **LLM cost per response — is it stable or trending up? At what gross margin do you start losing money on heavy-usage customers?**
  - **A:** **Track LLM cost per response weekly, alert on > 20% drift.** Target $0.02–0.05/response on GPT-4o-mini. Compute per-customer monthly LLM cost; any customer where (LLM cost ÷ MRR contribution) > 25% is a margin problem — either rate-limit, upsell, or improve prompt efficiency. If gross margin per customer drops below 60%, raise prices or shrink the prompt.

- **The 7-day past_due grace: is it visible to the customer (banner, countdown), or silent until lockout?**
  - **A:** **Visible.** Day 1: dismissable banner ("Payment failed — update card"). Day 3: persistent banner with countdown. Day 5: full-screen modal on login. Day 7: read-only mode with clear recovery path. Silent past_due → cancellation by surprise → chargeback risk + customer-trust damage.
  - **Gap → action:** Verify the banner UI exists and shows the countdown.

- **You just blocked checkout for past-due accounts — what's the support macro for "I'm past due and can't pay because my card was canceled, help"?**
  - **A:** Macro: "Sorry to hear about the card issue. Update your payment method here: [Stripe Customer Portal link]. Once updated, your account auto-recovers and we'll retry the failed payment within 24 hours. If you need a 7-day extension while you wait for a new card, reply YES and I'll grant it."
  - **Gap → action:** Add the "grant extension" admin action with audit logging.

- **CSV import has been hardened — do you publish a CSV template, validate it client-side, and show row-by-row errors?**
  - **A:** **Yes to all three.** Template at `/help/csv-template.csv` with example rows. Client-side validation (Zod or similar) shows errors before upload. Server returns row-by-row error list with line numbers. The recent fix ensures audit logging persists even when downstream billing fails — confirm the UX surfaces partial-success clearly to the user.

- **Is there a public-facing "trust center" page that summarizes security posture, compliance, sub-processors, and uptime?**
  - **A:** **Yes — `/trust` or `/security`** with: SOC 2 status (in progress / certified), GDPR/CCPA links, sub-processor list, encryption-at-rest/transit summary, incident history (last 12 months), pentest cadence, vulnerability disclosure policy, security.txt link, contact (security@). Required for any prospect doing vendor security review. Build it before the first one asks.

---

## Prioritization framework

When you act on these, sequence by:

1. **Launch-blockers** (anything that risks data loss, billing errors, or legal exposure in the next 30 days): §3 tenant isolation tests, §5 reconciliation worker, §9 lawyered ToS/PP, §17 sub-processors page, §29 audit-log content snapshot.
2. **Activation-blockers** (anything that costs you a paying customer in the next 90 days): §6 < 10 min time-to-first-value, §6 sample data mode, §13 in-app chat + KB, §29 past_due banner + countdown.
3. **Growth-blockers** (anything that caps growth in the next 12 months): §16 SEO programmatic pages, §16 referral program, §20 Zapier app, §15 demo environment.
4. **Scale-blockers** (anything that breaks at 10x current load): §3 RLS audit, §12 load test, §22 LLM eval set in CI, §29 second review source.
5. **Maturity** (everything else): SOC 2, native mobile, multi-region, partner portal.

Cut the list ruthlessly. Most SaaS companies that fail do so because they tried to do all of this at once. Pick **3 items per quarter**, ship them well, repeat.

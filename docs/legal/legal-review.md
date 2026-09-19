# Legal review and lawyer handoff

Audit date: 2026-09-16
Status: revised repository drafts; pending counsel and company-fact review; not a compliance certification

The founder confirmed **REPWORTH, INC., a Delaware corporation** during this audit. The business mailing address and current sales/target markets were not supplied. No incorporation documents, vendor contracts, insurance policies, or live production settings were inspected. Code establishes supported processing paths, not which optional paths are currently enabled in production.

## Document inventory and publication

| Document | Location | Review status |
|---|---|---|
| Terms | `/legal/terms`; `repworth-terms-of-service.md` | Updated 2026-09-16; counsel pending |
| Privacy | `/legal/privacy`; `repworth-privacy-policy.md` | Updated 2026-09-16; company and provider confirmations pending |
| AUP | `/legal/aup`; `aup.md` | Updated 2026-09-16; solicitation and platform rules expanded |
| Cookies | `/legal/cookies`; `cookies.md` | Updated 2026-09-16; actual analytics cookie disclosed |
| Providers | `/legal/sub-processors`; `sub-processors.md` | Updated 2026-09-16; contractual roles/regions not verified |
| Security | `src/app/(public)/security/page.tsx` | Corrected publishing and PHI-screening claims |
| DPA | `dpa.md`, internal only | Expanded counsel working draft; incomplete schedules; not executed |
| Insurance | `insurance.md`, internal only | Coverage unverified; previous limits remain planning targets |
| Legacy routes | `/terms`, `/privacy` | Existing permanent redirects to canonical pages retained |

`src/lib/legal/content.ts` owns public legal copy. The five Markdown review copies reproduce it exactly; `src/lib/legal/__tests__/content.test.ts` checks parity. Counsel edits must be applied to both sources together. Historical plans/specs are not current legal policies and were not rewritten.

The proposed effective date is **16 September 2026**, the drafting date. Before publication, confirm the actual effective date, required advance notice and acceptance process, and archive the previous accepted terms. This change does not record customer assent, send notices, execute a DPA, purchase insurance, or deploy the pages. Do not treat a new date or continued website use as consent to new processing that requires affirmative permission.

## Corrections grounded in the repository

| Finding | Evidence | Draft change |
|---|---|---|
| Legal pages promised individual approval for every reply despite optional automatic approval | `.claude/CLAUDE.md` invariants 3 and 14; `src/lib/auto-approval/`; `worker/jobs/publisher/` | Distinguish Copilot from expressly enabled Autopilot; qualify availability; describe limits and residual AI risk |
| Newer review-request and assistant processing was absent | `src/lib/solicitation/contacts-csv-template.ts`; `src/lib/solicitation/contacts-repo.ts`; `src/lib/agents/operator/`; `docs/context/owner-operator.md` | Cover contacts, visit notes, consent/suppression, assistant conversations, proposals, and authorized actions only when used |
| Cookie policy incorrectly denied analytics cookies | `src/app/api/analytics/enqueue/route.ts` sets `rw_analytics_id`, max age 365 days, without an explicit consent check | Disclose analytics as a distinct purpose; do not label it necessary or invent a preference center |
| PostHog was excluded by both docs and a stale test | `src/lib/analytics/posthog.ts`; `src/lib/analytics/enqueue.ts` | List configured server-dispatched analytics and its identifiers/events; remove stale exclusion |
| Vendor inventory misdescribed queue hosting and understated hosting access | `.claude/CLAUDE.md` tech stack; `worker/queues.ts`; `src/instrumentation-client.ts` | Railway includes job queues/data processing; Upstash includes cache/controls; Sentry includes performance; distinguish optional messaging/platform providers |
| Deletion and billing copies had drifted | `src/lib/account-offboarding/confirm.ts`; `worker/jobs/account-offboarding/BillingScheduleWorker.ts`; `src/lib/account-offboarding/stripe-customer-redaction.ts` | Separate end-of-period cancellation from deletion, explain 30-day purge scheduling, provider delays, retained billing records, and no self-serve export |
| Terms implied a customer owned third-party reviews | Existing Terms IP clause | Preserve actual rights; limited service license; no invented ownership of reviewer content or guarantee of AI copyright |
| Security page implied PHI detection was complete | `src/lib/security/phi-scanner.ts`; `worker/jobs/zernio/zernio-ingest-shared.ts` | Explain screening limits and no HIPAA suitability/BAA assumption |
| Document versions and text diverged | Prior `docs/legal/*.md` versus typed content | Synchronized review copies and added a parity regression test |

Cookie inventory also checked against `src/lib/approval/cookies.ts` (48 hours), `src/lib/zernio/connect-session-cookie.ts` (15 minutes), `src/lib/account-offboarding/destructive-auth.ts` (10 minutes), `src/contexts/LocationContext.tsx` (one year), and the support-session cookie setter. Browser storage examples come from the auth handoff and `PastDueModal` components. Sentry replay is disabled in `src/instrumentation-client.ts`.

## Decisions and operational gaps to resolve

1. **Identity and territory.** Add a verified business mailing address for notices. Confirm headquarters, markets actively targeted, customer types, visitor locations, and any EU/UK representation needs. Delaware incorporation alone does not select governing law or remove obligations elsewhere. The existing California law/Los Angeles forum clause is retained for counsel to assess, not silently replaced with Delaware law.
2. **Analytics consent.** The first-party analytics endpoint sets an identifier without an explicit consent check. A revised cookie notice does not fix this. Determine applicable regional consent/exemption and objection rules, including current UK changes, then implement the required controls or disable the relevant optional collection where needed. Verify the actual callers, deployment behavior, consent evidence, and removal/withdrawal behavior. Do not assert blanket exemption because dispatch is server-side.
3. **Google content and authorization.** Obtain written advice from Zernio and counsel about the Google Business Profile policy on temporary content storage (including its 30-calendar-day provision), restrictions on aggregation, AI processing, and downstream access. The repo retains review history and derived insights; this audit did not establish a contractual exception or compliant lifecycle for every data class. Reconcile retention, public-source versus connected-source data, AI disclosures, any applicable Limited Use restrictions, human support access, and precise express-consent evidence for automated actions before claiming compliance. No unverified Limited Use certification was added.
4. **Vendor agreements and transfers.** Verify exact contracting entities, DPAs, subprocessors, regions, remote access, training/data-sharing settings, provider retention, and legal role for every used vendor. Meta/WhatsApp and Google can be connected platforms or downstream providers rather than direct RepWorth sub-processors. Do not imply they all act solely as processors. Confirm production PostHog configuration. The list intentionally labels optional processing; it is not a live production inventory.
5. **DPA execution and privacy operations.** Complete `dpa.md` schedules and any required transfer instruments. Verify request intake, identity/agent verification, statutory deadlines, appeal handling, export assistance, customer instructions, incident escalation, subprocessor-change notices, and audits. No signed DPA or reliable category-by-category retention schedule was found. A privacy email is not proof that those operations are staffed or tested.
6. **Subscription terms and assent.** Check checkout disclosures, clickwrap/version evidence, trial conversion, cancellation, renewal notices, price changes, tax/location charges, refunds, and required state-law exceptions. Counsel should assess applicability to these B2B subscriptions and customers; do not assume a notice buried in Terms cures checkout behavior. The existing three-month fee cap is retained with mandatory-law carveouts. Decide whether to revise it, add balanced indemnities, address prepaid refunds when RepWorth terminates without cause, and adopt any dispute procedure. No new arbitration/class waiver or broad customer indemnity was imposed.
7. **Review requests and messaging.** Confirm consent per recipient/channel and country, postal-address collection, opt-out handling, suppression durability, and email purpose classification. Reconcile selective-request safeguards with Google policy and actual eligibility logic. Do not treat owner notification enrollment as end-customer marketing consent. The old automatic HELP-reply promise was removed because the inspected classifier establishes STOP/START handling, not a HELP response.
8. **Claims and insurance.** Verify monitored support/security mailboxes, staffing commitments, insurance, incident response, backup lifetimes, and provider security controls. The security copy avoids certifying SOC 2, HIPAA, or perfect PHI filtering. Do not market healthcare suitability without a separate assessment and any required BAA.

## Research used

Reviewed 2026-09-16. Sources inform drafting and counsel questions; legal applicability depends on the facts above.

- [Google Business Profile API policies](https://developers.google.com/my-business/content/policies): prior authorization, express consent for automated actions, disconnection, content-storage restrictions, and independence from Google. The storage provision is a priority contractual review item, not a resolved conclusion about RepWorth's Zernio arrangement.
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy): accurate, timely disclosure of access/use/sharing and consent for changed uses; evaluate scope-specific Limited Use obligations.
- [Google Maps prohibited and restricted content](https://support.google.com/contributionpolicy/answer/7400114): review integrity, incentives, and selective positive-review solicitation.
- [FTC consumer reviews rule](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials): fabricated reviews, sentiment-conditioned incentives, and improper suppression. Google can prohibit practices more broadly than the FTC rule.
- [FTC CAN-SPAM business guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business): sender identity, postal address, unsubscribe handling, message-purpose distinctions, and continued sender responsibility when using a provider.
- [FTC ROSCA guidance](https://www.ftc.gov/business-guidance/blog/2018/07/time-rosca-recap-ftc-says-risk-free-trial-was-risky-not-free): clear recurring-payment terms, informed consent, and cancellation. This draft does not rely on the vacated 2024 federal click-to-cancel rule as current law.
- [California privacy agency FAQs](https://cppa.ca.gov/faq) and [adjusted thresholds](https://cppa.ca.gov/regulations/cpi_adjustment.html): determine CCPA coverage instead of declaring it universally applicable. The revenue threshold effective in 2025 is $26.625 million, not the older $25 million figure; other coverage tests also matter.
- [California privacy-notice guidance](https://oag.ca.gov/sites/all/files/agweb/pdfs/cybersecurity/making_your_privacy_practices_public.pdf): clear disclosure and tracking transparency; CalOPPA and CCPA are separate analyses.
- [ICO storage/access guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/): device storage rules also reach first-party technologies; evaluate current exceptions and consent requirements.
- [ICO processor-contract checklist](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance/contracts/): processing particulars, instructions, safeguards, providers, assistance, deletion/return, and audits inform the working DPA. Counsel must complete jurisdiction-specific terms and transfers.

## Cost-effective lawyer review options

Pricing checked 2026-09-16; confirm current state availability, scope, total charge, renewals, page limits, and whether written redlines are included before purchasing.

| Website | Observed price / model | Fit for this package |
|---|---|---|
| [LegalShield Small Business](https://www.legalshield.com/business) | Basic displayed at $59.95/month with document checks up to 25 pages each. The same site also exposes legacy Essentials pricing/limits; verify the plan offered in your state. | Low entry cost for initial business-law review. Ask whether SaaS/privacy expertise and revisions of all documents are covered. |
| [LegalZoom Business Attorney Plan](https://www.legalzoom.com/attorneys/) | Six-month plan displayed at $259 total ($43.17/month equivalent); 10 pages included per document. Longer review listed at $69 for 11–15 pages and $149 for 16–25 pages. | More predictable general review scope, but prepaid subscription and per-matter limits matter. Obtain specialist redline scope in writing. |
| [ContractsCounsel](https://www.contractscounsel.com/b/privacy-policy-cost) | Compare fixed-fee bids. Its September 11 data reports $710 average for reviewing one privacy policy; this is a marketplace benchmark, not a quote for the entire package. | Strongest fit for a scoped SaaS/privacy specialist engagement covering the gaps above. Request one bundled price. |
| [Rocket Lawyer](https://www.rocketlawyer.com/pricing) | Current table lists Standard $149/year, Plus $249/year, Pro $349/year; advice sessions listed separately at $149/30 minutes or $249/60 minutes. | Useful for lawyer access and initial triage. The advertised unlimited Contract Review is AI review; do not assume a lawyer redline is included. |

Recommended approach: obtain two or three bundled fixed-fee specialist bids through ContractsCounsel and compare them with a confirmed LegalShield business-plan scope. A low subscription price is useful only if it includes the requested human review. Do not pay for another policy generator to replace attorney review of these already-prepared drafts.

Suggested inquiry (not sent):

> REPWORTH, INC. is a Delaware C corporation providing AI-assisted Google review management for businesses, with manual approval and optional bounded automatic posting, plus enabled review-request and assistant features. We have drafted Terms, Privacy, AUP, Cookies, a provider inventory, Security disclosures, and an internal DPA. Please quote a fixed fee for an attorney review, written redlines, one revision round, and a short call. Please specifically assess automated-action consent, Google/Zernio storage and AI restrictions, analytics cookies, subscription/cancellation terms, review-request consent and suppression, liability/indemnities, and any state/international privacy or transfer obligations. We will supply our operating address, sales markets, and provider contracts. Please identify what is excluded and distinguish required product changes from wording changes.

## Verification record

These checks verify page rendering and repository consistency, not legal compliance or production vendor settings.

- Focused legal content, document parity, page rendering, typography, and metadata: **39 tests passed across 4 files**.
- `pnpm lint`: passed. `pnpm typecheck`: passed. `pnpm build`: passed (non-blocking Sentry sourcemap warning). `git diff --check`: passed.
- Full `pnpm test`: **15,797 passed, 7 failed, 431 skipped**; 1,135 test files passed, one failed, 54 skipped. All seven failures were in the untouched `scripts/ci/__tests__/red-team-mutation-runner.test.ts` process-supervision/admission suite. The environment also denied a read-only `ps` inspection, consistent with limitations affecting some process tests, but this audit did not establish the cause of every failure. The full suite is not green. DB-gated integrations reported `TEST_DATABASE_POOL_URL` unset and skipped; no database provisioning was performed for this copy change.
- Computer Use target: local production build at `http://localhost:3000`, confirmed by the 16 September date, corporate name, revised automation language, and new cookie inventory. No customer login or data was required.
- Desktop **1440 × 1000** and mobile **390 × 844**: opened `/legal/terms`, `/legal/privacy`, `/legal/aup`, `/legal/cookies`, `/legal/sub-processors`, and `/security`. Expected current text, complete heading anchors, and no document-width overflow; observed on all six pages at both widths.
- Clicked the Terms service anchor and Cookies analytics/storage anchors; headings landed below the navigation. Clicked the legal Privacy cross-link; arrived at the correct policy. Horizontally scrolled the mobile cookie table; observed purpose/lifetime columns and a nonzero table scroll position without widening the page.
- Opened `/privacy` and `/terms`; both navigated to canonical legal pages. Opened `/legal/dpa`; observed the expected Page not found screen, confirming the unfinished internal draft is not exposed.
- Sanitized screenshots captured in this task: desktop Terms service section; mobile analytics disclosure; mobile cookie inventory before and after sideways scrolling. They contain only public draft copy, with no customer information. Temporary viewport override was reset after testing.
- The temporary local server logged repeated `MaxListenersExceededWarning` messages during navigation, without an observed page failure. This runtime warning was not diagnosed as part of the legal-copy change. The temporary server and browser tab were closed after verification.

The exercised journey was public policy reading/navigation. Authenticated approval, billing, provider cleanup, cookie-consent enforcement, and legal-rights request handling were not changed or certified by these checks; the operational gaps above remain open.

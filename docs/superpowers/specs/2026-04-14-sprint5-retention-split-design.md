# Sprint 5 Retention Split Design

Date: 2026-04-14
Status: Approved direction, pending final user review
Source plan: `docs/Final_Implementation_Plan.md`, Sprint 5

## Goal

Sprint 5 should reduce churn and make ROI obvious to business owners without destabilizing the current review approval, notification, payment, or worker systems. The current Sprint 5 plan has the right product goals, but it is too broad to ship as one low-risk sprint. It adds value emails, monthly reporting, satisfaction capture, SerpAPI ranking, owner dashboard actions, settings, engagement alerts, onboarding drips, and churn scoring at the same time.

The recommended design splits Sprint 5 into two delivery slices:

- Sprint 5A: customer-visible ROI and internal churn prevention with minimal new system risk.
- Sprint 5B: ranking automation, deeper dashboard actions, satisfaction pulse, and onboarding automation.

## Product Thesis

The strongest churn killer is not a feature owners have to remember to open. It is a recurring value signal delivered where they already live: email.

For the MVP, RepWorth should prove ROI with:

- Reviews handled.
- Estimated time saved using 7 minutes per handled review.
- Response-rate lift versus onboarding baseline when baseline data exists.
- Review themes and one useful business recommendation.
- Partner alerts when a customer stops engaging.

Google Maps ranking is useful, but it should not be the core ROI proof in this phase. It is noisy, slow to move, and costs SerpAPI credits. In Sprint 5A it should only appear when ranking data already exists. Automated ranking belongs in Sprint 5B behind cost controls.

## Sprint 5A Scope

### Weekly Value Report

Upgrade the current weekly summary email into the primary retention surface.

Content:

- AI Intelligence Brief from that week's reviews.
- Reviews handled and estimated minutes saved.
- Current response rate and baseline lift when the baseline exists.
- Review velocity text, such as current week versus 4-week average.
- Notable reviews using the existing weekly summary content.
- Dashboard link.
- Ranking only if ranking snapshot data already exists; the email must not trigger SerpAPI ranking calls.

Implementation constraints:

- Use existing weekly summary worker and email infrastructure where possible.
- Keep mock mode support for local tests.
- Use the existing cost guard for any new LLM summarization.
- Do not create stored computed metrics for approval rate, last approval date, or response time.

### Monthly Impact Email

Add a monthly owner email focused on business value.

Content:

- Monthly intelligence brief.
- Reviews handled and estimated hours saved.
- Response rate versus baseline when available.
- Best review of the month.
- Dashboard link.
- Ranking change only if ranking data already exists.

Implementation constraints:

- Use scheduler -> outbox -> worker flow.
- Only send to businesses with `subscription_status = 'active'`.
- Use a unique business/month idempotency record to prevent duplicate sends.
- Avoid near-duplicate day 30 onboarding content by deferring onboarding drips to Sprint 5B.
- Do not call SerpAPI from this email path.

### Read-Only Owner Dashboard

Ship a simple dashboard that reinforces the email value story but does not become a new approval workflow yet.

Content:

- Since-joining value summary.
- Last 8 weeks review velocity.
- Recent reviews and response status in read-only form.
- Latest weekly or monthly intelligence brief.
- Ranking chart only if ranking data already exists.

Implementation constraints:

- The dashboard API must scope data from the authenticated owner's business relationship and never trust a client-submitted business ID.
- Do not add inline approve, edit, or regenerate actions in Sprint 5A.
- Keep the existing token-based approval routes unchanged in Sprint 5A.

### Engagement Monitoring And Partner Alerts

Add internal and owner nudges that prevent silent churn.

Rules:

- No approval in 3+ days and pending reviews exist: owner nudge.
- No approval in 7+ days and pending reviews exist: partner engagement alert.
- No approval in 14+ days: partner escalation alert.
- 30-day approval rate below 50%: partner low-engagement alert.

Implementation constraints:

- Compute metrics at query time.
- Use outbox topics and existing notification delivery records for cooldown deduplication.
- Only run for active businesses.
- Owner nudge links should reuse existing valid approval links or generate fresh links through shared approval-link generation logic.

### Churn Risk Score In Admin

Add an internal health signal for the sales partner.

Scope:

- Pure `computeChurnRiskScore(metrics)` function with no database calls.
- Admin overview health badge and default sort by risk.
- Admin business detail risk breakdown.

Inputs:

- 30-day approval rate.
- Days since last approval.
- Last 4 satisfaction responses if they exist.
- Response time trend if available.
- Account age.

Implementation constraints:

- No stored churn score column.
- Export thresholds and weights as constants so the model is tunable.
- Treat missing satisfaction responses as a weak signal, not a hard churn signal.

## Sprint 5B Scope

Defer these items until Sprint 5A is stable:

- Automated SerpAPI ranking tracking.
- Manual ranking entry and tracked keyword management, unless ranking proof is explicitly needed for early customers.
- Satisfaction pulse links and confirmation flow.
- Day 1, day 7, and day 30 onboarding drip emails.
- Dashboard approve, edit, and regenerate actions.
- Owner settings page if it is not needed for immediate retention.

## SerpAPI Cost Controls For 5B

Automated ranking should not be enabled by default.

Controls:

- Feature flag: `RANKING_TRACKING_ENABLED=false` by default.
- Track at most 1 default keyword per business at first.
- Require an explicit keyword saved on the business or admin page before tracking.
- Do not auto-generate a keyword inside the worker on every run.
- Run biweekly, not weekly.
- Skip businesses without a verified place ID and usable location.
- Add a monthly ranking call cap before making SerpAPI requests.
- Dedupe pending and dispatched `track_ranking` outbox entries before creating new work.
- Log skipped businesses with a reason, but do not fail the entire batch.

The current Sprint 5 plan has a small inconsistency: the scheduler says it queries businesses with non-empty `tracked_keywords`, while the worker says it auto-generates a keyword if empty. The cost-effective version should pick one rule. Recommendation: require explicit saved keywords for automated tracking. Admin setup can suggest a default keyword, but the worker should not create new keywords at runtime.

## Breakage Safeguards

Before enabling new retention workers, resolve carryover reliability and security issues that affect the existing system:

- Notification retry idempotency around approval links.
- Guardrail retry behavior that could still send forbidden content.
- Cost-sensitive routes that fail open.
- Stripe webhook deduplication and subscription activation checks.
- Outbox enqueue and worker idempotency gaps.

New Sprint 5 work should follow these constraints:

- All asynchronous work uses the existing scheduler -> outbox -> worker pattern.
- All new workers support mock mode, subscription guards, typed payload parsing, outbox completion, and graceful shutdown.
- All owner-visible sends are idempotent by business and period or alert type.
- No new customer-visible workflow should bypass existing authorization rules.
- Dashboard actions that mutate approvals stay out of Sprint 5A.
- Database changes are additive and backward compatible.
- Ranking and external API calls are feature-flagged.

## ROI Measurement

Sprint 5A should report ROI in conservative terms:

- Time saved = handled reviews times 7 minutes.
- Response-rate lift = current response rate compared to onboarding baseline when available.
- Review velocity = current period versus recent average.
- Business insight = recurring review themes and one actionable recommendation.

Because SerpAPI mode may not reliably know historical owner reply counts, baseline language should be careful. If baseline data is incomplete, the UI should show current response rate without claiming an exact lift.

## Testing Requirements

Sprint 5A should include:

- Unit tests for churn score thresholds and edge cases.
- Unit tests for engagement rules and cooldown behavior.
- Worker tests proving monthly and weekly emails do not send for `pending_payment` businesses.
- Worker tests for idempotency on duplicate outbox attempts.
- API tests for dashboard business scoping.
- Email/template tests for value report content fallbacks when baseline, ranking, or monthly data is missing.
- Mock-mode tests for LLM intelligence brief generation.

Sprint 5B should add:

- SerpAPI ranking worker tests for budget cap, disabled flag, missing keyword, missing verified place ID, not-found ranking, and retryable API errors.
- Satisfaction pulse tests proving GET is read-only and POST is the only mutating action.
- Dashboard approval action tests proving session auth is scoped to the owner's business and the existing token approval flow remains unchanged.

## Delivery Recommendation

Implement Sprint 5A first in this order:

1. Preflight hardening of existing notification, cost guard, Stripe, and outbox issues.
2. Weekly Value Report.
3. Monthly Impact Email.
4. Read-only Owner Dashboard.
5. Engagement Monitoring and Partner Alerts.
6. Admin Churn Risk Score.

After Sprint 5A has passed tests and run without duplicate sends or approval-flow regressions, implement Sprint 5B starting with manual ranking support or automated ranking behind `RANKING_TRACKING_ENABLED`, depending on whether early customers need ranking proof.

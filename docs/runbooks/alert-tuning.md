# Alert Tuning

Keep alerts trustworthy: a noisy alert is a disabled alert.

## Target
- No more than ~5 false alerts per week.
- Every P0/P1 alert maps to a triage playbook in `observability.md`.

## Weekly false-alert review
1. List every alert that fired in the last 7 days.
2. Tag each: actionable / false / duplicate.
3. For each false alert: raise threshold, add a debounce window, or delete it.
4. For each missed real incident: add or tighten an alert.

## Candidate alerts (configure in Sentry / log vendor as external gates)
- Worker or web health failing (P0).
- Outbox `failed` rate / count threshold (P1).
- LLM fallback rate over a rolling window (P2 → P1 if sustained).
- Moderation flag rate spike (P2).
- Stripe webhook error rate (P1).

## Tuning principles
- Alert on symptoms users feel, not on every error line.
- Prefer rate/duration thresholds over single-event triggers.
- Each alert names its runbook section.

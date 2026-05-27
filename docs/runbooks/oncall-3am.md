# On-Call: The 3 A.M. Test

What is worth waking up for, and what waits until morning.

## Wake up (P0)
- Web or worker `/api/health` failing repeatedly.
- Stripe webhooks failing → billing state diverging.
- Any tenant-isolation / auth breach signal.
- Outbox `failed` climbing fast (durable work being lost).

## Wait until morning (P1/P2)
- A single queue lagging but draining.
- Elevated LLM fallback rate while responses still generate (fallback works).
- Moderation false-positive spike (drafts are held, not mis-sent — safe by design).
- Cosmetic Sentry noise.

## First five minutes
1. Both `/api/health` endpoints.
2. `/admin/jobs`: outbox `failed` + `pending`, per-queue depth.
3. Sentry: newest unresolved issue.
4. Pick one failing unit; filter logs by its `correlation_id`.
5. Decide severity using `observability.md`, then act or defer.

## Guardrails
- Never bypass the approval step to "unblock" posting.
- Never disable moderation to clear a flagged backlog.
- Prefer pausing a queue over deleting jobs.

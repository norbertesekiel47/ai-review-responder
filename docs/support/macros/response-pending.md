# Response Pending

## When to use

Use this when a customer reports that a review has been ingested but no draft response is available yet.

## Customer reply

Hi {{owner_name}},

I checked the review queue for {{business_name}}. Drafts normally appear within a few minutes after a review is received. If this one is still pending, we will check the generator job and make sure the draft is created or retried.

I will follow up once the review either has a draft or we have an exact reason it needs manual handling.

## Internal checks

- Confirm the review row exists and belongs to the account.
- Check the latest response row for the review.
- Check `job_outbox` and BullMQ status for `generate-response`.
- Confirm subscription status allows generator work.
- Check cost guard or LLM provider errors before retrying.

## Escalation

Escalate if generation repeatedly fails, if review ingestion created inconsistent rows, or if the issue affects multiple accounts.

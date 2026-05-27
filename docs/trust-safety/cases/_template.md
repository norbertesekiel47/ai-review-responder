# T&S Case — <SHORT_TITLE>

> Copy this file to `docs/trust-safety/cases/YYYY-MM-DD-<slug>.md`. Reference row
> ids, never raw response text, approval tokens, or secrets.

- **Case id:** <YYYY-MM-DD-slug>
- **Opened:** <ISO timestamp>
- **Opened by:** <admin>
- **Severity:** <S0 | S1 | S2>
- **Type:** <held_draft | account_abuse | customer_report>
- **Status:** <open | actioned | closed>

## Signal

- Source: <admin/flagged | abuse report | log alert | signup check>
- Account id: <uuid>
- Business id: <uuid, if location-scoped>
- Related row: <flagged_responses.id | responses.id | reviews.id>
- Reason / severity from system: <e.g. local_regex high — refund_discount>

## Assessment

<What was reviewed and the judgment. Was the flag correct?>

## Action taken

- Disposition / decision: <approved_for_owner_review | dismissed_false_positive | requires_regeneration | warn | suspend | terminate>
- Audit reference: <flagged_responses disposition row | account_audit_log entry>
- Owner communication: <none | message sent — summary>

## Follow-up

- Threshold/rule tuning needed? <yes/no — detail>
- Linked cases: <ids>
- Closed: <ISO timestamp>

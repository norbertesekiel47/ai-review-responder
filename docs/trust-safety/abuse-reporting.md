# Trust & Safety — Abuse Reporting

How a customer or third party reports an abusive account, an inappropriate
generated response, or misuse of RepWorth. Launch phase: intake is manual; the
in-product "report" API/UI is a deferred follow-up (see below).

## How to report (launch)

- **Email:** trust-safety@repworth.com (or the configured support inbox).
- **Include:** the business/account name or URL, what happened, and any
  screenshots or the review/response in question. Do not send passwords or
  payment details.

## Intake → triage → action

1. **Acknowledge** receipt.
2. **Triage** against the severity ladder in `enforcement-workflow.md`.
3. **Investigate** using admin tooling (`/admin/flagged`, account status,
   `account_audit_log`, analytics) — scoped reads only, never the service key at
   the edge.
4. **Action** per the enforcement workflow; open a case file (`cases/_template.md`)
   for anything S0/S1.
5. **Close the loop** with the reporter where appropriate, without disclosing
   another customer's private data.

## What we can act on today

- Unsafe generated responses (already gated by the held-draft moderation path).
- Spam / fraudulent signups.
- Terms-of-service violations.

## Deferred (external gates / later PRs)

- In-product **report-abuse API + UI** on review/response cards — deferred until a
  safe, tenant-scoped integration point is confirmed (it was explicitly out of
  scope for the launch slice).
- Disposable-email blocking and CAPTCHA on signup — revisit only if the real
  signup abuse rate makes them urgent.
- Public annual transparency report — scaffolding only for now.

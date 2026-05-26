# Past-Due Extension

## When to use

Use this when an owner is past due, has an open support or billing ticket, and needs a short grace extension while they update payment details. The maximum standard extension is 7 days.

## Customer reply

Hi {{owner_name}},

I extended your RepWorth past-due grace period through {{extension_date}} so you have time to update the payment method. During this window your account should remain writable, including review approval and Google Business Profile connection actions.

Please update the card or resolve the invoice before that date. If payment is still past due after the extension ends, the account will return to read-only mode until billing is current.

## Internal checks

- Confirm the account is currently `past_due`.
- Confirm the support ticket ID and customer request are attached to the account.
- Require an AAL2 admin session before granting the extension.
- Use the admin business detail action so `accounts.flags.past_due_extension` and `account_audit_log` are written in one transaction.
- Do not grant more than 7 days without escalation approval.

## Escalation

Escalate to the founder or billing owner when the customer requests more than 7 days, has repeated extensions in the last 30 days, disputes the charge, or reports a Stripe/payment-system issue that support cannot verify.

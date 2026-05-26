# Support Extension Runbook

## Purpose

Grant a short, audited past-due grace extension without bypassing subscription enforcement or leaving the worker guard on a different deadline than the UI.

## Preconditions

- The customer account is `past_due`.
- There is a support or billing ticket ID.
- The admin granting the extension has completed MFA and is at AAL2.
- The request fits the default maximum of 7 days.

## Procedure

1. Open the affected account from the admin business detail page.
2. Confirm the subscription status badge shows `past due`.
3. Use **Grant past-due extension**.
4. Enter the number of days, the ticket ID, and a concise reason.
5. Submit the form and confirm the success message.
6. Verify the account audit log includes `past_due_extension_granted`.
7. Reply with `docs/support/macros/past-due-extension.md`.

## Data Written

The admin action writes `accounts.flags.past_due_extension` with:

- `granted_at`
- `granted_by_user_id`
- `days`
- `reason`
- `ticket_id`
- `expires_at`

It also writes `account_audit_log` in the same database transaction.

## Rollback

There is no self-serve rollback action yet. To revoke an extension, open an engineering ticket to remove `accounts.flags.past_due_extension` for the account and add a manual account audit log note.

## Escalation

Escalate before granting more than 7 days, before granting a repeated extension, or when a billing incident appears to be caused by Stripe, plan configuration, or a RepWorth deployment.

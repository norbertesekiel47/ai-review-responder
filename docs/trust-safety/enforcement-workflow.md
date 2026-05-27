# Trust & Safety — Enforcement Workflow

How RepWorth handles unsafe generated responses, abusive accounts, and abuse
reports during the launch phase. Solo-founder process; keep it lightweight but
auditable.

## Scope

Covers three signal sources:

1. **Held drafts** — high-severity moderation flags surfaced at `/admin/flagged`
   (see the moderation invariant in `.claude/CLAUDE.md`).
2. **Account abuse** — signup abuse, spam, or terms violations.
3. **Customer abuse reports** — see `abuse-reporting.md`.

Out of scope for launch (tracked as external gates): public transparency reports,
automated disposable-email/CAPTCHA defenses, owner-facing appeal UI.

## Severity ladder

| Severity | Examples | Response time |
|---|---|---|
| **S0 — Block** | Unsafe draft about to reach an owner (refund/legal-fault/profanity/injection leak); credible legal/abuse threat. | Immediate — disposition before any owner notification. |
| **S1 — Urgent** | Repeated flags on one account; suspected fraudulent signup actively generating. | Same day. |
| **S2 — Routine** | Single medium-severity flag; one-off abuse report needing review. | Within 2 business days. |

## Held-draft disposition (S0)

A `high`-severity flag writes a `flagged_responses` row and **skips the owner
notification in the same transaction as response persistence** — the draft stays
`pending_approval`, never auto-posted. Admin acts at `/admin/flagged`:

1. **Review** the response excerpt, review metadata, business/account, reason,
   severity, model, and prompt version.
2. **Disposition** (one transaction, audited):
   - `approved_for_owner_review` — false positive on a safe draft; re-enqueues the
     owner notification via the transactional outbox.
   - `dismissed_false_positive` — terminal; the flag was wrong but the draft is
     not being released now.
   - `requires_regeneration` — terminal status; the draft is unsafe and should be
     regenerated (auto-regeneration is a deferred gate).
3. **Record a case file** for any S0/S1 using `cases/_template.md`.

Never edit the draft text to "fix" it from the flagged queue — disposition only.

## Account abuse (S1/S2)

1. Confirm the signal (logs, `account_audit_log`, analytics).
2. Decide: warn, suspend, or terminate. Suspension uses the account status path
   (`writeAccountAuditLog` in the same tx as the state change — never a raw audit
   insert).
3. File a case for suspension/termination.

## Audit trail

- State changes go through the audited paths (`flagged_responses` disposition;
  `writeAccountAuditLog`). Never hand-edit rows.
- Every S0/S1 gets a case file under `cases/` (copy `_template.md`).
- Never paste raw approval tokens, auth secrets, or full response text into a
  case file — reference the `flagged_responses` / `responses` row id instead.

## Escalation

Solo founder is the decision-maker. For credible legal threats or law-enforcement
requests, pause automated action, preserve records, and consult counsel before
responding.

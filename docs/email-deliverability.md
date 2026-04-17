# Email Deliverability Runbook

Operational guide for getting approval emails and owner reports into inboxes
(not spam) at RepWorth's scale (10-20 customers in first month).

## DNS Authentication

All three MUST be published before sending to real customers.

### SPF
Resend handles this automatically via their Amazon SES infrastructure.
Verify in Resend dashboard: **Domains → your-domain → SPF → green check**.

### DKIM
Resend provides 3 CNAME records during domain verification. Publish all 3.
Verify: `dig CNAME <key>._domainkey.your-domain.com` resolves.

### DMARC
Add a TXT record at `_dmarc.your-domain.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc@your-domain.com
```

- Start with `p=none` (monitor only) for 2 weeks.
- After aggregate reports show clean sends, tighten to `p=quarantine`.
- Move to `p=reject` after another 2-4 weeks of clean reports.

## Warmup Schedule

New sending domains need a ramp. Sending 100 emails from a cold domain on
day one is a reliable way to get the domain blacklisted.

| Week | Daily volume | Source |
|------|-------------|--------|
| 1 | 5-10 emails | Internal test accounts + demo businesses with your own email |
| 2 | 20-30 emails | First 2-3 real customers |
| 3+ | Organic | Natural volume from customer activity |

**Hard rule:** Stagger onboarding to 2-3 customers per week during the first month.
Do NOT onboard 10 customers in one day — the email burst will hurt reputation.

## Monitoring

### Daily (2 minutes)
- Admin overview → Email Health card
- Delivery rate >95%? No complaints this week? If both yes: green. Move on.

### Weekly (5 minutes)
- Resend dashboard → Domains → delivery rate, bounces, complaints
- Check admin overview for hard bounces. Each hard bounce should correspond
  to an `admin@...` alert email (see Hard Bounce section below).

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Email went to spam | Recipient's spam folder | Ask recipient to mark as "not spam". Verify SPF/DKIM/DMARC are all green. |
| Hard bounce | Recipient email is invalid | Business flagged automatically (`owner_email_bounced=true`). Verify address with owner. Update in admin. Clear flag. |
| Soft bounce | Mailbox full / temporarily unavailable | No action — notification failover poller retries. |
| Complaint | Recipient marked as spam | Check email content + frequency. Admin overview → Email Health card goes red. Consider manual reach-out. |

## Hard Bounce Flow

When Resend reports `email.bounced` with `bounce.type = permanent`:

1. Webhook handler (`worker/ingress/resend.ts`) sets `businesses.owner_email_bounced = true`.
2. Admin receives an internal email alert at `ADMIN_NOTIFICATION_EMAIL`.
3. Owner-directed workers skip this business:
   - Approval emails (`NotificationWorker`)
   - Weekly value reports (`WeeklySummaryWorker`)
   - Monthly impact reports (`MonthlyImpactWorker`)
   - Onboarding drips (`OnboardingDripWorker`)
   - Owner nudges (`EngagementAlertWorker`)
4. Partner/admin alerts still flow (manual-post instructions, exceptions, partner
   engagement alerts). Those go to the admin, not the owner.

### Clearing the Flag

Once the address is verified/updated:

1. Open `/admin/businesses/[id]`
2. Update the `ownerEmail` if needed.
3. Click "Clear bounce flag (after verifying address)" in the red warning banner.
4. Next owner-directed event (approval, weekly report, etc.) will send normally.

## Env Vars

| Var | Required? | Purpose |
|-----|-----------|---------|
| `RESEND_API_KEY` | Yes | Resend SDK auth |
| `RESEND_WEBHOOK_SECRET` | Yes in prod | Svix signature verification for delivery webhooks |
| `RESEND_FROM_EMAIL` | Yes | `RepWorth <notifications@your-domain.com>` — verified sender |
| `LIST_UNSUBSCRIBE_EMAIL` | No | Defaults to mailbox extracted from `RESEND_FROM_EMAIL` |
| `ADMIN_NOTIFICATION_EMAIL` | Yes | Admin recipient for hard bounce / exception / partner alerts |

## List-Unsubscribe Compliance

Gmail and Outlook (Feb 2024) require bulk senders to provide one-click
unsubscribe. Our implementation:

- Marketing emails (weekly/monthly/drip/nudge) include:
  - `List-Unsubscribe: <mailto:unsubscribe@...>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Transactional emails (approval) do NOT — these are necessary for service
  operation, not marketing. Bulk-sender rules don't apply.
- Internal emails (partner alerts, admin exceptions) do NOT — these go to
  the admin, not to customers.

# Channels Rollout — Telegram first, WhatsApp follows

External-ops runbook for turning the (already-built, flag-OFF) Telegram and
WhatsApp notification channels on in production, plus the auto-approved post FYI
(Workstream B). **Norbert owns** the steps that need Telegram/Meta/Twilio
dashboards + secrets; Claude owns the code, tests, ADR, template content, and
staging verification.

Source of truth for env behavior: `.claude/reference/env-vars.md`
(`CHANNELS_TELEGRAM_ENABLED`, `CHANNELS_WHATSAPP_ENABLED`). Template content:
`docs/runbooks/whatsapp-templates.md`. Deploy topology:
`docs/runbooks/deployment-guide.md`.

## 0. Gate — staging audit BEFORE any prod flag flip

Anything here touches the worker / a webhook / a migration, so it rides
**staging first**. Before flipping any prod flag, run the full pipeline on
staging with **both channels enrolled** and real test reviews:

- Webhook signature verification (Telegram secret token; Twilio signature).
- Click-to-chat enrollment → `verified`.
- Approve + Regenerate round-trips over each channel.
- Parallel-channel race (email + one mobile) → "already handled", no double-post.
- Mobile-channel exclusivity → 2nd mobile enroll returns 409.
- Enrollment status-flips (blocked → unsubscribed, chat-not-found/invalid →
  disabled); template-config / session-window errors do **NOT** flip enrollment.
- **Migration 067 applied to BOTH Supabase projects, staging first.**

## 1. Migration 067 (apply staging-first, both projects)

`supabase/migrations/067_auto_post_notice_outbox_and_claim.sql` — two
transactional partial-unique indexes (each predicate matches zero existing
rows). Apply in the Supabase SQL editor (single transaction is fine — no
CONCURRENTLY). Verify:

```sql
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('idx_jo_auto_post_notice_inflight',
                     'notification_deliveries_auto_post_notice_claim');
-- expect: both rows present
```

## 2. Telegram → prod first (no external approval gate)

1. Register the prod bot with **BotFather** (`@RepWorthBot`) → obtain the bot
   token.
2. Set the webhook (worker public URL + a 32+ byte shared secret):

   ```bash
   curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     --data-urlencode "url=${WORKER_PUBLIC_URL}/ingress/telegram" \
     --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
   # expect: {"ok":true,"result":true,"description":"Webhook was set"}
   ```

3. Set env on **both** Railway (worker) **and** Vercel (UI):
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`
   - optional `TELEGRAM_BOT_USERNAME` (default `RepWorthBot`)
4. After the staging audit passes, flip `CHANNELS_TELEGRAM_ENABLED=true` on
   Railway + Vercel; redeploy both. Telegram FYI works immediately (no template).

## 3. WhatsApp → prod after its Meta template clears (parallel work)

1. **During steps 0–2**, submit the FYI template `repworth_autopost_notice_v1`
   to Meta via the Twilio Content API (UTILITY category). Full submission JSON +
   variable map: `docs/runbooks/whatsapp-templates.md`. Meta review = 1–5
   business days; may be rejected/reclassified.
2. When approved, Twilio returns an `HX...` Content SID → set
   `WHATSAPP_AUTOPOST_TEMPLATE_SID` on **both** Vercel + Railway. The WhatsApp FYI
   activates with **no code change**. Until then it degrades gracefully (skips;
   email + Telegram FYIs still send).
3. Flip `CHANNELS_WHATSAPP_ENABLED=true` only after the eight-point ship gate in
   `whatsapp-templates.md` passes in a canary scope.

## 4. Env-var matrix

| Variable | Vercel | Railway | Required when on | Notes |
|---|---|---|---|---|
| `CHANNELS_TELEGRAM_ENABLED` | ✅ | ✅ | — | `true` to enable Telegram |
| `TELEGRAM_BOT_TOKEN` | ✅ | ✅ | Telegram | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | ✅ | Telegram | must match `setWebhook` secret |
| `TELEGRAM_BOT_USERNAME` | ✅ | ✅ | optional | deep-link rendering |
| `CHANNELS_WHATSAPP_ENABLED` | ✅ | ✅ | — | `true` to enable WhatsApp |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ✅ | ✅ | WhatsApp | |
| `TWILIO_WHATSAPP_NUMBER` | ✅ | ✅ | WhatsApp | `whatsapp:+<digits>` |
| `WHATSAPP_APPROVAL_TEMPLATE_SID` | ✅ | ✅ | WhatsApp | approval template `HX...` |
| `WHATSAPP_APPROVAL_URL_BASE` | ✅ | ✅ | WhatsApp | `= NEXT_PUBLIC_APP_URL + '/approve/'` |
| `WHATSAPP_AUTOPOST_TEMPLATE_SID` | ✅ | ✅ | **optional/degrading** | FYI template `HX...`; absence skips WhatsApp FYI, does NOT fail boot |
| `WORKER_PUBLIC_URL` | — | ✅ | always | Telegram setWebhook + Twilio signature |
| `AUTO_APPROVAL_ENABLED` | ✅ | ✅ | for the FYI to ever fire | the FYI only fires for an `auto_policy` post; off → no FYIs |

## 5. Notes

- The auto-post FYI is **runtime-inert** until an `auto_policy` response is
  posted (requires `AUTO_APPROVAL_ENABLED=true` + a configured policy). Flipping
  the channels on does not by itself produce any FYI.
- The conversational free-text seam (ADR 0003) is a **no-op** today — no reply,
  auth-gated — so enabling the channels does not create a bot surface.

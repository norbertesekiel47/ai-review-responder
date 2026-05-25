# Secrets Rotation: Email And Messaging

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- Resend API key
- Twilio auth token
- Telegram bot token

## Procedure

1. Create replacement provider secret in the relevant dashboard.
2. Add replacement value to Railway and Vercel environment stores for the channels that use it.
3. Deploy worker and app.
4. Verify approval email delivery, SMS opt-in/STOP handling, and Telegram delivery if enabled.
5. Remove or revoke old provider secret.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|

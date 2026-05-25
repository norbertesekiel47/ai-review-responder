# Secrets Rotation: Supabase

Owner: founder
Cadence: annually and immediately after suspected exposure

## Scope

- Supabase service role key
- Supabase anon key
- Database pool URL

## Procedure

1. Create replacement keys or database credentials in Supabase.
2. Add replacement values to Railway and Vercel environment stores.
3. Deploy worker and app.
4. Verify owner login, dashboard reads, webhook processing, and background workers.
5. Remove old keys or revoke old database credentials.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|

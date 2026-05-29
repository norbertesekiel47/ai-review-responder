# Secrets Rotation: API Keys

Owner: founder
Cadence: quarterly and immediately after suspected exposure

## Scope

- ENCRYPTION_KEY
- SESSION_COOKIE_SECRET
- CSRF_SECRET

## Procedure

1. Generate replacement key material with a cryptographically secure generator.
2. Add replacement values to Railway and Vercel environment stores.
3. Deploy worker and app.
4. Verify admin endpoints, encrypted channel data reads, owner sessions, and CSRF-protected writes.
5. Remove old key material from all environment stores.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|

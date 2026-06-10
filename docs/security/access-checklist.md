# Access Checklist

Owner: founder
Review cadence: before each launch, after team changes, and monthly

## Founder Launch Checklist

- [ ] Supabase: founder account has MFA enabled.
- [ ] Supabase: service role key is not present in browser-visible env vars.
- [ ] Supabase: production database access is limited to founder accounts and required service integrations.
- [ ] Vercel: project access is limited to founder accounts; preview/prod env vars are scoped correctly.
- [ ] Railway: project access is limited to founder accounts; worker env vars are present only in the production worker service.
- [ ] Stripe: live mode access is limited to founder accounts; webhook endpoint points at Railway ingress.
- [ ] Resend: domain sending access is limited to founder accounts; API key is production-only.
- [ ] Twilio: console access and auth token access are limited to founder accounts if WhatsApp is enabled.
- [ ] Zernio: API key access is limited to founder accounts; webhook signing secret is known only to runtime env stores.
- [ ] Google Cloud or Maps keys: browser key restrictions are enabled for public keys.
- [ ] GitHub: branch protections and required checks are enabled for production branches.
- [ ] Local machines: founder laptop has full-disk encryption and OS updates enabled.

## Offboarding Checklist

1. Remove the person from Vercel, Railway, Supabase, Stripe, Resend, Twilio, Zernio, GitHub, and Google Cloud.
2. Rotate any shared secrets the person could access.
3. Invalidate active dashboard sessions if credentials or devices may be compromised.
4. Review audit logs for access after the offboarding time.
5. Record date, actor, removed accounts, and rotated secrets below.

## Access Review Log

| Date | Actor | Systems reviewed | Changes made |
|---|---|---|---|

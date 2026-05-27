# Monthly Close Checklist

Run on the first business day for the prior month. Solo-founder discipline.

1. **Stripe revenue** — export the month's Stripe invoices/payments; record gross
   revenue and active subscriptions (MRR).
2. **API cost review** — open `/admin/costs` (last 30 days): record per-provider
   spend, fallback rate, avg cost per response, and any account over the 25% /
   40% cost-of-MRR thresholds. Investigate `action`-level accounts.
3. **Vendor COGS entry** — fill `cogs-template.md` from the month's invoices
   (Supabase, Railway, Vercel, Upstash, Sentry, PostHog, Help Scout, Twilio).
4. **Gross-margin calculation** —
   `gross_margin = (revenue − variable_cogs) / revenue`. Compare to the
   platform thresholds (warn < 70%, act < 60%). Note that `/admin/costs` shows
   the API-COGS-only margin; the true margin also subtracts variable vendor COGS.
5. **Cash balance & runway** — record bank + Stripe balance; compute runway
   (cash / monthly net burn).
6. **Action items** — list any margin/cost actions (e.g. tune fallback rate,
   revisit a high-cost account's plan, renegotiate a vendor).

Record the close in a dated file (e.g. `docs/finance/close-YYYY-MM.md`) — or
reuse `pilot-invoice-review-YYYY-MM.md` for the pilot period.

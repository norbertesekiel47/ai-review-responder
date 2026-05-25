# Vendor Risk Register

Owner: founder
Review cadence: monthly before launch, then quarterly

## Launch Checklist

| Vendor | Data touched | Primary risk | Current control | Launch decision | Next review |
|---|---|---|---|---|---|
| Supabase | Owner accounts, businesses, reviews, responses, approval link hashes | Service role key misuse or tenant isolation defect | Service role stays server-side, RLS inventory maintained, account and business scoping in app queries | Approved for launch after RLS smoke test | Monthly |
| Railway | Worker runtime, webhook ingress, queue consumers, environment variables | Worker secrets exposure or webhook downtime | Secrets in Railway env store, worker owns third-party ingress, logs scrubbed for tokens and review text | Approved for launch after staging smoke | Monthly |
| Vercel | Public app, owner dashboard, short OAuth callback routes | Public route regression or env leakage | UI-only invariant, no service role key in browser, build and route compile before release | Approved for launch after build | Monthly |
| Upstash Redis | BullMQ queue and cache metadata | Queue credential exposure or retry storms | Separate cache and queue Redis, outbox terminal handling for blocked PHI | Approved for launch after queue smoke | Monthly |
| Stripe | Customer, subscription, checkout, webhook events | Billing disruption or webhook signing secret exposure | Webhook terminates on worker, secret rotation runbook, no raw card storage | Approved for launch after webhook verification | Monthly |
| Zernio | Google review text, location IDs, external replies | Review text PHI, wrong-location ingest, API credential exposure | Location verification, PHI scanner gates, Zernio rotation runbook | Approved for launch after ingest smoke | Monthly |
| Resend | Owner email address, approval notification content | Email secret exposure or approval link leakage | Approval tokens hashed at rest, raw token only in sent email, Resend rotation runbook | Approved for launch after email smoke | Monthly |
| Twilio | Owner phone numbers, SMS notification metadata | Opt-in evidence gaps or token exposure | SMS opt-in tracked, no marketing sharing, token rotation runbook | Approved for launch if SMS enabled | Monthly |
| Telegram | Bot chat metadata if channel enabled | Bot token exposure or wrong recipient delivery | Channel-specific token, founder-owned smoke before enabling | Conditional, only after channel smoke | Monthly |
| OpenAI / Anthropic | Review text and business response prompts | Sensitive review text sent to LLM providers | Railway-only LLM calls, subscription guard, likely PHI blocked before generation | Approved for launch after PHI tests | Monthly |
| Sentry | Error traces, scrubbed request metadata, worker/app exceptions | Accidental secret, token, or review text capture | Sentry scrubber removes sensitive fields; review text logging is avoided on PHI paths | Approved for launch after scrubber smoke | Monthly |
| PostHog | Product analytics and onboarding events | Excessive customer metadata in analytics events | Event payloads must avoid raw review text, approval tokens, and secrets | Pending `POSTHOG_API_KEY` enablement and confirmed event flow to PostHog Cloud; approved for launch only after that and an analytics payload review | Monthly |
| SerpAPI | Google place/review lookup metadata where still used | Review/location data exposure through lookup calls | Server-side API key only; use is limited to lookup/retrieval paths | Approved for launch after key restriction review | Monthly |
| Google Maps Platform | Place autocomplete and public map/place metadata | Browser key abuse or collection of unnecessary place data | Public key restrictions; autocomplete requests use only required place fields | Approved for launch after key restriction review | Monthly |

## Review Procedure

1. Confirm each active vendor has a named purpose and no unused production credentials.
2. Verify production secrets exist only in Railway, Vercel, Supabase, Stripe, and provider dashboards as needed.
3. Run the smoke tests that exercise webhook ingress, approval flow, and owner dashboard access.
4. Review logs for accidental raw approval token, secret, or likely PHI exposure.
5. Record any vendor status change in this file before launch approval.

## Open Risk Log

| Date | Vendor | Risk | Owner | Mitigation | Status |
|---|---|---|---|---|---|

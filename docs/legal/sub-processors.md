# Sub-processors

Version: 2026-09-16
Effective date: 2026-09-16
Legal review status: pending lawyer review

Review copy of `src/lib/legal/content.ts`. Keep this file synchronized with the route-backed document; see `legal-review.md` for publication status and open questions.

## Current Data Path

This inventory covers providers and connected platforms used by implemented RepWorth features. Actual processing depends on enabled features and configuration. Listing a provider does not mean every customer's information is sent to it. Providers such as Google, Stripe, and messaging platforms may also process information independently under their own terms.

Purposes and data categories are listed below. For contractual sub-processor details, processing locations, or a data processing agreement, contact support@repworth.net. This inventory is not an executed DPA and does not promise a particular hosting region or transfer certification.

| Vendor | Purpose | Data classes |
| --- | --- | --- |
| OpenAI | AI replies, summaries, classification, safety checks, and enabled assistant features | Review and response text, relevant business context, and prompts or conversations for the feature used |
| Anthropic | AI processing, including fallback when configured | Review and response text, relevant business context, and prompts or conversations for the feature used |
| Stripe | Payments | Billing identifiers, name, email, address, subscription metadata |
| Supabase | Database, authentication, and storage | Account, business, review, response, contact, consent, and authentication data |
| Vercel | Web hosting and bot protection | Requests, IP/device metadata, and application data handled by the web service |
| Railway | Worker hosting and Redis job queues | Application data and job payloads needed for processing and delivery |
| Upstash | Redis cache, rate limits, and usage controls | Cache entries, identifiers, counters, and operational metadata |
| Resend | Email | Email addresses, message content, delivery metadata |
| Twilio | WhatsApp delivery when enabled | Phone numbers, message content, consent and delivery metadata |
| Meta / WhatsApp | WhatsApp messaging platform when enabled | Phone numbers, message content, and messaging metadata |
| Telegram | Bot delivery when enabled | Telegram identifiers, message content |
| Zernio | Google review ingestion and posting | GBP OAuth tokens, review data, posting metadata |
| Sentry | Error and performance monitoring | Scrubbed diagnostics, request and device metadata, and performance events |
| PostHog | Server-dispatched product analytics when configured | Pseudonymous visitor/account identifiers, usage events, timestamps, and filtered event properties |
| SerpAPI | Public business/review lookup, demos, and enabled ranking or competitor features | Business identifiers, search/location queries, and public business and review data |
| Google Maps Platform | Place autocomplete and map/place metadata | Place query metadata |
| Google Business Profile | Connected review source and destination for authorized replies | Connected-account permissions, location/review data, and published responses |

## Changes and Questions

We update this inventory when provider use changes. Any additional notice, authorization, or objection rights are governed by your applicable data processing agreement and law. Contact support@repworth.net with questions about a provider or the information it receives.

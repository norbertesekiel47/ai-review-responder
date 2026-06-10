# Sub-processors

Version: 2026-06-09
Effective date: 2026-06-09
Review status: founder verified; pending lawyer review for broader legal package

| Vendor | Purpose | Data classes |
|---|---|---|
| OpenAI | AI draft generation | Review text, business context, generated responses |
| Anthropic | AI draft fallback | Review text, business context, generated responses |
| Stripe | Payments | Billing identifiers, name, email, address, subscription metadata |
| Supabase | Database and auth | App data, auth metadata |
| Vercel | Web hosting | Request metadata |
| Railway | Worker hosting | Request metadata, job processing metadata |
| Upstash | Redis cache and queues | Cache keys, job payload metadata |
| Resend | Email | Email addresses, message content, delivery metadata |
| Twilio | WhatsApp | Phone numbers, message content, delivery metadata |
| Telegram | Bot delivery when enabled | Telegram identifiers, message content |
| Zernio | Google review ingestion and posting | GBP OAuth tokens, review data, posting metadata |
| Sentry | Error tracking | Scrubbed error metadata |
| SerpAPI | Demo, prefill, and fallback location data | Public business and review data |
| Google Maps Platform | Place autocomplete and map/place metadata | Place query metadata |

Vendors without a live product data path are not listed as current sub-processors.

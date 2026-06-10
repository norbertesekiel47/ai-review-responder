# COGS Template (monthly)

Variable cost of goods sold per month. Two sources: **code-computed** API/LLM
costs (from `api_costs`, visible in `/admin/costs`) and **vendor bills** entered
manually from invoices. Copy this table each month.

| Vendor | Category | Amount (USD) | Period | Source invoice / link | Variable COGS or fixed opex | Notes |
|---|---|---|---|---|---|---|
| OpenAI | LLM (code-computed) | | | /admin/costs (provider split) | variable | gpt-4o-mini generation |
| Anthropic | LLM (code-computed) | | | /admin/costs | variable | Haiku fallback — watch fallback rate |
| SerpAPI | Reviews API (code-computed) | | | /admin/costs | variable | |
| Resend | Email (code-computed) | | | /admin/costs | variable | |
| Twilio | WhatsApp (code-computed, when enabled) | | | provider dashboard | variable | |
| Supabase | DB/auth (vendor bill) | | | invoice | fixed opex | |
| Railway | Worker host (vendor bill) | | | invoice | fixed opex | |
| Vercel | Web host (vendor bill) | | | invoice | fixed opex | |
| Upstash | Redis (vendor bill) | | | invoice | fixed opex | |
| Sentry | Errors (vendor bill) | | | invoice | fixed opex | |
| PostHog | Analytics (vendor bill) | | | invoice | fixed opex | |
| Help Scout | Support (vendor bill) | | | invoice | fixed opex | |

**Variable COGS** = per-customer-usage costs (LLM, SerpAPI, Resend, Twilio).
Used in gross-margin math. **Fixed opex** = platform vendor bills that don't
scale per customer; tracked here but excluded from the per-account/platform
gross-margin signal in `/admin/costs` (which is code-computed API COGS only).

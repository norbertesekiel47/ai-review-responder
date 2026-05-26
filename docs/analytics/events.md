# Analytics Events

RepWorth does not use `posthog-js` and Next.js routes do not call PostHog directly. Client and Vercel-owned events are written to `analytics_events`; Railway dispatches them to PostHog.

| Event | Distinct ID | Event key | Durable owner |
|---|---|---|---|
| `signup_started` | anonymous ID | `signup_started:<anonymous_id>:<client_event_id>` | first-party enqueue route |
| `email_verified` | account ID | `email_verified:<user_id>` | verify OTP route |
| `sample_demo_started` | anonymous ID or account ID | `sample_demo_started:<id>:<client_event_id>` | first-party enqueue route |
| `sample_demo_to_signup` | anonymous ID or account ID | `sample_demo_to_signup:<id>:<client_event_id>` | first-party enqueue route |
| `gbp_connect_started` | account ID | `gbp_connect_started:<business_id>:<client_event_id>` | first-party enqueue route |
| `gbp_connect_failed` | account ID | `gbp_connect_failed:<business_id>:<stage>:<client_event_id>` | connect UI/API |
| `gbp_connected` | account ID | `gbp_connected:<business_id>` | Zernio finalize/select-location transaction |
| `first_review_ingested` | account ID | `first_review_ingested:<account_id>` | Zernio ingest worker |
| `first_response_drafted` | account ID | `first_response_drafted:<account_id>` | response generator worker |
| `activation_completed` | account ID | existing Step 1 key | publisher worker |

Never include review text, response text, raw approval tokens, Zernio tokens, MFA codes, provider secrets, or raw CSV content.

# Owner Lead Intake Design

## Context

RepWorth's public site currently invites interested business owners to "Book a demo." The landing page scrolls to a contact-style lead form, and `/book-a-demo` has a separate demo request form. Both existing API routes validate and rate-limit submissions, then log and send email notifications through Resend. They do not persist submissions in Supabase.

For the current launch phase, the public CTA should be "Join waitlist." The underlying data model should not be waitlist-specific, because the same capture flow should become demo-intake later without a table rename or data migration.

## Goals

- Replace public demo-booking language with waitlist language for the current launch phase.
- Capture high-intent owner leads with enough business context to prioritize follow-up.
- Persist submissions in Supabase under a reusable lead model.
- Preserve notification emails so new leads are visible immediately.
- Keep the existing `/book-a-demo` URL useful by repurposing it instead of removing it.
- Make the future switch from waitlist to demo-request mostly copy/config work.

## Non-Goals

- Do not create users, businesses, subscriptions, or onboarding records from this form.
- Do not generate prospect demos from submissions automatically.
- Do not build a full CRM or admin lead-management UI in this slice.
- Do not integrate double opt-in or email marketing automation yet.

## Data Model

Create a new Supabase table named `owner_leads`.

This table represents owner interest captured from public marketing pages. It is intentionally named for the domain object, not the temporary CTA.

Recommended columns:

```sql
CREATE TABLE owner_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  business_name TEXT NOT NULL,
  google_maps_url TEXT,
  intent TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_leads_intent_check
    CHECK (intent IN ('waitlist', 'demo')),
  CONSTRAINT owner_leads_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'archived'))
);
```

Add indexes:

```sql
CREATE UNIQUE INDEX owner_leads_email_intent_key
  ON owner_leads (email_normalized, intent);

CREATE INDEX owner_leads_status_created_idx
  ON owner_leads (status, created_at DESC);

CREATE INDEX owner_leads_source_created_idx
  ON owner_leads (source, created_at DESC);
```

The API must set `email_normalized` to `lower(trim(email))`. The unique email-and-intent index allows one waitlist lead and one later demo lead for the same owner. If the same owner submits the same intent again, the API should update the existing row with the latest name, business name, Google Maps URL, source, metadata, and `updated_at`.

The existing `prospect_demos` table should not be reused. It stores generated demo artifacts and sales-demo lifecycle state, which is distinct from raw inbound owner interest.

## API Design

Add a public route:

```txt
POST /api/lead-intake
```

Expected JSON body:

```json
{
  "name": "Avery Chen",
  "email": "avery@example.com",
  "businessName": "Avery's Bakery",
  "googleMapsUrl": "https://maps.google.com/...",
  "intent": "waitlist",
  "source": "landing"
}
```

Validation:

- `name` is required and capped at 200 characters.
- `email` is required, normalized to lowercase/trimmed, and must match the existing email format guard.
- `businessName` is required and capped at 300 characters.
- `googleMapsUrl` is optional, capped at 2048 characters, and must be a valid HTTPS URL when present.
- `intent` defaults to `waitlist` for the current UI and may be `demo` later.
- `source` must be a short known string such as `landing`, `book-a-demo`, `pricing`, or `unknown`.

Behavior:

- Apply IP-based rate limiting similar to the existing public form endpoints.
- Insert into `owner_leads`, or update the existing row for the same normalized email and intent.
- Send the existing Resend-style notification email after persistence succeeds.
- Return `{ "success": true }` on success without exposing whether the row was inserted or updated.
- Use the server-side Postgres client (`sql` from `src/lib/db/server.ts`) for the write. The browser should submit only to the Next.js route and must not insert directly into Supabase.

## UI Design

Create one shared form component for public owner lead capture named `LeadIntakeForm`.

Props:

- `intent`: currently `waitlist`, later can be `demo`.
- `source`: page-level source such as `landing` or `book-a-demo`.
- Optional copy overrides for button and success text if needed.

Current waitlist copy:

- Primary CTA: "Join waitlist"
- Landing section heading: "Join the early access waitlist."
- Supporting copy: "Tell us about your business and we'll reach out when early access opens for your area."
- Submit button: "Join waitlist"
- Success heading: "You're on the waitlist."
- Success body: "We'll reach out when early access opens for your area."

Repurpose `/book-a-demo` as a waitlist page for now:

- Keep the route available.
- Change page copy from booking a demo to joining early access.
- Use the shared lead-intake form with `source="book-a-demo"` and `intent="waitlist"`.

When RepWorth is ready to offer demos again, the public copy can switch to demo language and the same component can submit `intent="demo"` to the same endpoint and table.

## Error Handling

Client-side validation should catch missing required fields and malformed email before submit.

Server-side validation is authoritative and returns concise 400 errors for invalid JSON, invalid fields, or invalid URLs.

Rate-limit failures return 429 with a user-safe message.

Database or email-notification failures return 500. Persistence should happen before notification so a transient email failure does not silently lose the lead if the implementation later chooses to tolerate notification errors.

## Testing

Add focused API tests for `/api/lead-intake`:

- Rejects invalid JSON.
- Rejects missing name, email, and business name.
- Rejects invalid email.
- Rejects non-HTTPS Google Maps URL.
- Persists a valid waitlist lead with normalized email.
- Updates a duplicate normalized email plus intent instead of creating a second row.
- Preserves separate rows for the same email with different intents.
- Applies the existing public-form rate limit pattern.

Add lightweight UI coverage where practical:

- Landing form submits waitlist intent and `landing` source.
- `/book-a-demo` form submits waitlist intent and `book-a-demo` source.
- Success copy uses waitlist language and does not promise a demo time.

Run the targeted tests and a production build before calling implementation complete.

## Rollout

1. Add the `owner_leads` migration.
2. Add `/api/lead-intake`.
3. Replace landing and `/book-a-demo` forms with the shared lead-intake form.
4. Update public CTA and success copy from demo language to waitlist language.
5. Keep existing `/api/contact` and `/api/demo-request` untouched during the first pass unless removing their only callers is part of the same implementation plan.

This keeps the launch surface simple while creating a clean data foundation for the later demo-request phase.

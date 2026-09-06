## `src/app/`

### `api/` (continued)

_Continues from [`app-api-a.md`](app-api-a.md) (`_shared/channels/` … `dashboard/`)._

#### `settings/route.ts`

GET + POST owner settings (tone, products/services, avoid-facts).

#### `settings/postal-address/route.ts`

**(#656)** PUT: records the **Attested postal address** for the owner's cookie-resolved active location. Auth is `resolveOwnerScope` (NOT `requireSettingsOwner`, which resolves no location and deliberately skips the writable-subscription gate) plus `withSameOrigin()`, and an explicit `getOffboardingState`/`isOperationalUIBlocked` refusal placed **before the body parse** — the subscription gate does not imply it, since `delete_data`/`pending` is operationally blocked while the subscription is still `active`. `z.strictObject` is load-bearing: a body-supplied `businessId` or `userId` is a 400, never a silently ignored tenant-selection knob, and `attestationVersion` is pinned to the constant so a client can never assent to one text while the server records another. Delegates to `attestPostalAddress` and maps its four statuses to 200/400/403/404; the lint lives in the module, never here.

#### `onboarding/`

| Route | What it does |
|-------|--------------|
| `business/route.ts` | POST: persists step-by-step business profile data from the 3-step wizard (`/onboarding/business`). Validates step input via `shared/schemas.ts` and updates the existing `businesses` row created at signup. |
| `select-plan/route.ts` | POST: validates the owner's explicit Copilot/Autopilot selection, persists the complete tier/variant snapshot under billing serialization, and returns a Stripe Checkout Session URL. No tier default or Payment Link remains. |

#### `signup/place-prefill/route.ts`

GET: hits SerpAPI for a Place ID during the onboarding location step to prefill business name, address, and category. **(2026-08-14)** No longer gated by `SELF_SERVE_SIGNUP_ENABLED` — the flag now means only "strangers may mint accounts", and this endpoint is reached by admin-invited owners with the flag off. Because removing the gate from an otherwise-**unauthenticated**, SerpAPI-billed endpoint would have made it permanently public, it gained a real boundary in the same change: authenticated session + `role = 'owner'` + a pre-activation account state, plus a new per-auth-id 10/min strict limit alongside the existing strict per-IP one (75/day global unchanged).

#### `zernio/connect/`

Handles the Zernio OAuth connect flow for GBP auto-posting. All routes gated by `ZERNIO_PUBLISHING_ENABLED`.

| Route | What it does |
|-------|--------------|
| `start/route.ts` | Initiates the Zernio OAuth flow; creates a Zernio profile, sets a signed connect-session cookie, and redirects the owner to Zernio. |
| `callback/route.ts` | Receives the OAuth callback from Zernio: claims the single-use connect state (Redis GETDEL), calls `zernioClient.listLocations` (ADR 0001 sanctioned sync call), stashes the locations in Redis for 15 min, sets the signed connect-session cookie and 302s to `select-location`. Writes NO DB row — `zernio_connections` first exists inside `finalizeConnectionTx`. |
| `select-location/route.ts` | POST: finalises the connection — `zernioClient.selectLocation` → `accountId`, then `finalizeConnectionTx` (one `sql.begin`: `zernio_connections` upsert to `active`, `drain_pending_owner_connect` outbox row, `gbp_connected` analytics event, and — only on `import_decision='accepted'` — `enqueueInitialImport`). |
| `cancel/route.ts` | POST: cancels an in-progress OAuth flow; cleans up pending DB + Redis state. |

#### `zernio/disconnect/route.ts`

POST: disconnects an active Zernio connection; marks `zernio_connections` status `disconnected`.

#### `admin/`

| Route | What it does |
|-------|--------------|
| `overview/route.ts` | Admin overview stats; delegates to `getAdminOverview`. |
| `businesses/route.ts` | GET list (auth → parse/clamp `limit`/`offset` → `getBusinessSummaries` (**§5.2**, replacing the deleted `getAdminBusinessesList`) → JSON, echoing `limit`/`offset` on top of the service payload) + POST create (calls `AdminOnboardingService`). |
| `businesses/[id]/route.ts` | GET / PATCH / DELETE a business; delegates to `business-detail-service`. |
| `businesses/[id]/resend-invite/route.ts` | **(2026-08-14)** POST: re-sends the Supabase invite email for an admin-created owner who has never signed in. Admin + AAL2 + same-origin, mirroring the create route's guards; delegates to `src/lib/onboarding/resend-invite.ts`. Eligibility is asked of the **provider** (`auth.admin.getUserById` → `last_sign_in_at IS NULL`), never of the local `auth_id`, which is populated at creation time and so cannot distinguish "invited" from "accepted". Capped at **3 per hour per business** — the one admin action that puts mail into a third party's inbox on a button press, so an accidental click-loop can't burn sender reputation; auth runs before the limit so an unauthenticated call spends no budget. |
| `businesses/[id]/channels/route.ts` | GET (delegates to `getBusinessChannelEnrollments`) + POST channel enrollments. |
| `businesses/[id]/keywords/route.ts` | GET + POST ranking keywords. |
| `businesses/[id]/ranking/route.ts` | GET ranking snapshot. |
| `businesses/[id]/zernio-queue/route.ts` | Reconnect-queue admin actions (force drain / dismiss) for a location's `awaiting_owner_connect` responses. |
| `costs/route.ts` | GET cost summary; delegates to `getCostReport` + `getMarginReport`. |
| `demos/route.ts` | GET demo list (delegates to `getAdminDemos`) + POST demo request. |
| `demos/generate/route.ts` | POST: queues a demo generation job via outbox. |
| `flagged/route.ts` | GET the open flagged-response queue (delegates to `listOpenFlaggedResponses`) + POST the disposition transaction (which stays in the route). |
| `offboardings/route.ts` | GET the offboarding lifecycle list behind `requireAdminWithAal2`; delegates to `getAdminOffboardings`. Its page gate matches (`requireAdminPage(sql, {aal2: true})`). |
| `offboardings/[offboardingId]/route.ts` | POST a provider disposition against one offboarding. |
| `jobs/route.ts` | GET queue health; delegates to `getAdminJobsData` + `fetchQueueHealth`. |
| `nav-counts/route.ts` | Thin admin-gated GET for sidebar badge counts (flagged open, failed jobs); delegates to `getAdminNavCounts`. Polled every 60s by `AdminSidebar`. |
| `notifications/route.ts` | GET delivery logs. |
| `autonomy/suspensions/route.ts` | **(WS6)** Admin-only GET for the cross-account suspended-policy read model (current rates + five newest flag verdicts); delegates to `listSuspendedPolicies`. |
| `autonomy/unsuspend/route.ts` | **(WS6)** Admin-only POST that validates `{ accountId, note }`, takes the account-level autonomy lock inside one transaction, and maps already-manual state to 409. |
| `suppressions/lookup/route.ts` | **(#645)** AAL2-gated **POST** returning every Suppression ledger row for one **Normalized handle** plus its prior Correction path records (cross-tenant by design, allowlisted in `ci:tenant-scope`). A POST rather than a GET **because of spec §9.5**: a query string puts the raw recipient address into access logs, log drains and browser history, and every other path here keeps the handle out of logs. The service's result union is mapped to an explicit response body at the route boundary, so a future failure variant cannot silently become the wire contract. |
| `suppressions/route.ts` | **(#645)** AAL2-gated POST §7.3 admin manual entry (`global` / `admin_manual`, required note, `normalizeEmail` **rejects** rather than minting a wrong handle; a repeat entry is a no-op success against the partial unique index). Deliberately **not** flag-gated: a statutory 10-business-day obligation behind a feature flag is a violation waiting for a flag flip. |
| `suppressions/correct/route.ts` | **(#645)** AAL2-gated POST: the **Correction path** (§8.2) — error correction, NEVER re-subscribe. `z.strictObject({ suppressionId, reason })`, so a client-supplied actor field is a 400 rather than a silently ignored key; the actor id comes from the gate. Delegates to `correctSuppression` with no `sql.begin` (the service is one statement), and maps an already-gone row to 404 instead of writing an orphan record. A separate route from the entry surface so the two acts never share a handler, a schema, or a copy string. |
| `billing/grant-extension/route.ts` | **(Wave 2)** Admin + current-AAL2 action that grants a short past_due extension in `accounts.flags` and writes `account_audit_log`. |
| `impersonation/start/route.ts` | **(Wave 2)** Starts an audited one-hour admin impersonation session. Same-origin, admin, current AAL2, validates owner/account, sets a signed httpOnly cookie. |
| `impersonation/end/route.ts` | **(Wave 2)** Ends the current signed impersonation session and clears the cookie. |
| `locations/csv-import/route.ts` | Admin CSV bulk-location import. Returns partial-success row failures and writes aggregate audit + billing outbox. |
| `channels/telegram/start/route.ts` | POST: start Telegram enrollment (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancel pending enrollment. |
| `channels/telegram/disable/route.ts` | POST: disable active enrollment. |
| `channels/whatsapp/start/route.ts` | POST: start WhatsApp enrollment (sends click-to-chat link). |
| `channels/whatsapp/cancel/route.ts` | POST: cancel pending enrollment. |
| `channels/whatsapp/disable/route.ts` | POST: disable active enrollment. |

#### `contact/route.ts` / `demo-request/route.ts` / `feedback/route.ts`

Public form submission handlers. Write to DB and optionally send an internal notification email.

---

_Index: [`docs/directory.md`](../directory.md)_

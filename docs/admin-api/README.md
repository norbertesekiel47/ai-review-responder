# Admin API contract

Generated from application source. Regenerate with `pnpm admin-contract:generate`;
`pnpm ci:admin-contract` fails if committed artifacts drift. This detects change,
not whether a change is breaking. No API version is currently assigned.

Use the method-specific response types for JSON wire bodies. Existing service DTO
exports are also included, but a route may enrich or project a service result.
Declarations have no private repository imports. Wire types describe successfully
serialized JSON: invalid dates and non-finite numbers may be null; unknown nested
source payloads stay JSON values and object properties may be omitted. Types do not
promise serialization succeeds for every runtime value. Status unions are an
over-approximation of reachable source branches, not a status/body discriminant.
Status codes are derived from literals, constant maps and domain-error constructor
arguments. An unresolved status expression fails generation. Unexpected framework
failures may also produce non-JSON 5xx.

Request schemas are built-in Zod JSON Schema input projections. Schema metadata
records source provenance, refinements and normalization limitations. Where marked
as approximate, constraints may apply after normalization: do not use these schemas
as complete preflight validators. The API's runtime parser is authoritative.
Bodyless and hand-parsed requests have no invented request schema.

The general error envelope is `{ error: string }`; its string is display text,
not a universal machine-code vocabulary. Existing exceptions are retained in the
generated response types: solicitation batch halt returns status-union bodies on
404 and 409. Other metadata beside error is preserved where present.

Proxy branch 4 cookie refusals: 401 `{error:'Unauthorized'}`,
403 `{error:'Forbidden'}`, and 403 `{error:<aal gate value>}`.
The MFA vocabulary includes `mfa_required` and `mfa_check_failed`.
On `mfa_required`, the Admin app completes its own MFA challenge and retries
with the resulting AAL2 bearer. An Authorization header selects bearer mode;
the canonical route gate verifies it. CORS may refuse an origin with
403 `{error:'origin'}` before the route. Impersonation remains in the legacy app
with its cookie/CSRF behavior; listing those routes here does not authorize a port.

| Route | Methods | Canonical gates | Request schema or absence | Wire response types | Source status codes |
| --- | --- | --- | --- | --- | --- |
| `/api/admin/autonomy/suspensions` | GET | GET: requireAdminWithAal2 | GET: no request body | `AutonomySuspensionsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/autonomy/unsuspend` | POST | POST: requireAdminJson | POST body: [UnsuspendSchema](schemas/AutonomyUnsuspendPOST-body-UnsuspendSchema.json) (approximate) | `AutonomyUnsuspendPOSTResponse` | POST: 200, 400, 401, 403, 409, 500 |
| `/api/admin/billing/grant-extension` | POST | POST: requireAdminWithAal2 | POST body: [GrantExtensionSchema](schemas/BillingGrantExtensionPOST-body-GrantExtensionSchema.json) (approximate) | `BillingGrantExtensionPOSTResponse` | POST: 200, 400, 401, 403, 409, 500 |
| `/api/admin/businesses/[id]/channels` | GET | GET: requireAdminWithAal2 | GET: no request body | `BusinessesIdChannelsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/businesses/[id]/keywords` | PUT | PUT: requireAdminWithAal2 | PUT body: [KeywordsSchema](schemas/BusinessesIdKeywordsPUT-body-KeywordsSchema.json) (approximate) | `BusinessesIdKeywordsPUTResponse` | PUT: 200, 400, 401, 403, 404, 500 |
| `/api/admin/businesses/[id]/ranking` | POST | POST: requireAdminWithAal2 | POST body: [RankingSchema](schemas/BusinessesIdRankingPOST-body-RankingSchema.json) (approximate) | `BusinessesIdRankingPOSTResponse` | POST: 200, 400, 401, 403, 404, 500 |
| `/api/admin/businesses/[id]/resend-invite` | POST | POST: requireAdminWithAal2 | POST: no request body | `BusinessesIdResendInvitePOSTResponse` | POST: 200, 401, 403, 404, 409, 422, 429, 500, 502, 429, 500, 503 |
| `/api/admin/businesses/[id]` | GET, PATCH | GET: requireAdminWithAal2<br>PATCH: requireAdminWithAal2 | GET: no request body<br>PATCH body: [UpdateBusinessSchema](schemas/BusinessesIdPATCH-body-UpdateBusinessSchema.json) (approximate) | `BusinessesIdGETResponse`<br>`BusinessesIdPATCHResponse` | GET: 200, 401, 403, 404, 500<br>PATCH: 200, 400, 401, 403, 404, 409, 500 |
| `/api/admin/businesses/[id]/zernio-queue` | POST | POST: requireAdminWithAal2 | POST body: [ActionSchema](schemas/BusinessesIdZernioQueuePOST-body-ActionSchema.json) | `BusinessesIdZernioQueuePOSTResponse` | POST: 200, 400, 401, 403, 409, 500, 503 |
| `/api/admin/businesses/options` | GET | GET: requireAdminWithAal2 | GET: no request body | `BusinessesOptionsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/businesses` | GET, POST | GET: requireAdminWithAal2<br>POST: requireAdminWithAal2 | GET: no request body<br>POST body: [OnboardBusinessSchema](schemas/BusinessesPOST-body-OnboardBusinessSchema.json) | `BusinessesGETResponse`<br>`BusinessesPOSTResponse` | GET: 200, 401, 403, 500<br>POST: 201, 400, 401, 403, 409, 500, 500 |
| `/api/admin/channels/telegram/cancel` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsTelegramCancelPOSTResponse` | POST: 200, 400, 401, 403, 404, 500, 503 |
| `/api/admin/channels/telegram/disable` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsTelegramDisablePOSTResponse` | POST: 200, 400, 401, 403, 404, 500, 503 |
| `/api/admin/channels/telegram/start` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsTelegramStartPOSTResponse` | POST: 200, 400, 401, 403, 404, 409, 500, 503 |
| `/api/admin/channels/whatsapp/cancel` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsWhatsappCancelPOSTResponse` | POST: 200, 400, 401, 403, 404, 500, 503 |
| `/api/admin/channels/whatsapp/disable` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsWhatsappDisablePOSTResponse` | POST: 200, 400, 401, 403, 404, 500, 503 |
| `/api/admin/channels/whatsapp/start` | POST | POST: resolveAdminActor | POST: hand-parsed-json | `ChannelsWhatsappStartPOSTResponse` | POST: 200, 400, 401, 403, 404, 409, 500, 503 |
| `/api/admin/costs` | GET | GET: requireAdminWithAal2 | GET: no request body | `CostsGETResponse` | GET: 200, 400, 401, 403, 500 |
| `/api/admin/demos/generate` | POST | POST: requireAdminWithAal2 | POST body: [GenerateDemoSchema](schemas/DemosGeneratePOST-body-GenerateDemoSchema.json) (approximate) | `DemosGeneratePOSTResponse` | POST: 201, 400, 401, 403, 429, 500, 503 |
| `/api/admin/demos` | GET | GET: requireAdminWithAal2 | GET: no request body | `DemosGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/flagged` | GET, POST | GET: requireAdminWithAal2<br>POST: requireAdminWithAal2 | GET: no request body<br>POST body: [DispositionSchema](schemas/FlaggedPOST-body-DispositionSchema.json) | `FlaggedGETResponse`<br>`FlaggedPOSTResponse` | GET: 200, 401, 403, 500<br>POST: 200, 400, 401, 403, 409, 500 |
| `/api/admin/impersonation/end` | POST | POST: requireAdminWithAal2 | POST: no request body | `ImpersonationEndPOSTResponse` | POST: 200, 400, 401, 403, 500 |
| `/api/admin/impersonation/start` | POST | POST: requireAdminWithAal2 | POST body: [StartImpersonationSchema](schemas/ImpersonationStartPOST-body-StartImpersonationSchema.json) (approximate) | `ImpersonationStartPOSTResponse` | POST: 200, 400, 401, 403, 404, 409, 500 |
| `/api/admin/jobs` | GET | GET: requireAdminWithAal2 | GET: no request body | `JobsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/locations/csv-import` | POST | POST: requireAdminWithAal2 | POST: multipart | `LocationsCsvImportPOSTResponse` | POST: 200, 400, 401, 403, 404, 413, 500 |
| `/api/admin/nav-counts` | GET | GET: requireAdminWithAal2 | GET: no request body | `NavCountsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/notifications` | GET | GET: requireAdminWithAal2 | GET: no request body | `NotificationsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/offboardings/[offboardingId]/provider-disposition` | POST | POST: requireAdminWithAal2 | POST path: [ParamsSchema](schemas/OffboardingsOffboardingIdProviderDispositionPOST-path-ParamsSchema.json)<br>POST body: [ProviderDispositionInputSchema](schemas/OffboardingsOffboardingIdProviderDispositionPOST-body-ProviderDispositionInputSchema.json) (approximate) | `OffboardingsOffboardingIdProviderDispositionPOSTResponse` | POST: 200, 400, 401, 403, 404, 409, 500 |
| `/api/admin/offboardings` | GET | GET: requireAdminWithAal2 | GET: no request body | `OffboardingsGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/overview` | GET | GET: requireAdminWithAal2 | GET: no request body | `OverviewGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/solicitation/batch/halt` | POST | POST: requireAdminJson | POST body: [AdminHaltSchema](schemas/SolicitationBatchHaltPOST-body-AdminHaltSchema.json) (approximate) | `SolicitationBatchHaltPOSTResponse` | POST: 200, 400, 401, 403, 404, 409, 500 |
| `/api/admin/solicitation/breaker/reset` | POST | POST: requireAdminJson | POST body: [ResetSchema](schemas/SolicitationBreakerResetPOST-body-ResetSchema.json) (approximate) | `SolicitationBreakerResetPOSTResponse` | POST: 200, 400, 401, 403, 409, 500 |
| `/api/admin/solicitation/breaker` | GET | GET: requireAdminWithAal2 | GET: no request body | `SolicitationBreakerGETResponse` | GET: 200, 401, 403, 500 |
| `/api/admin/suppressions/correct` | POST | POST: requireAdminWithAal2 | POST body: [CorrectSchema](schemas/SuppressionsCorrectPOST-body-CorrectSchema.json) (approximate) | `SuppressionsCorrectPOSTResponse` | POST: 200, 400, 401, 403, 404, 500 |
| `/api/admin/suppressions/lookup` | POST | POST: requireAdminWithAal2 | POST body: [LookupSchema](schemas/SuppressionsLookupPOST-body-LookupSchema.json) (approximate) | `SuppressionsLookupPOSTResponse` | POST: 200, 400, 401, 403, 500 |
| `/api/admin/suppressions` | POST | POST: requireAdminWithAal2 | POST body: [EntrySchema](schemas/SuppressionsPOST-body-EntrySchema.json) (approximate) | `SuppressionsPOSTResponse` | POST: 200, 400, 401, 403, 500 |

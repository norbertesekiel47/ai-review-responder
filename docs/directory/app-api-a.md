## `src/app/`

### `api/` — API routes (all thin; no LLM or heavy work)

#### `_shared/channels/`

Shared by BOTH portals' channel routes — placed at the common ancestor of
`api/admin/channels/*` and `api/dashboard/channels/*` per the `_shared`
convention. All 12 enrollment routes are binding shims over these.

> **Channel-route rules the code does not make obvious** (moved here from the
> CLAUDE.md routing row on 2026-08-16; `docs/context/core-accounts-channels-admin.md` → **Channel actor** + spec
> `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 —
> PR 2 of 3; the spec is fully shipped: §3/PR 1 as #827, §4/PR 2 as #831,
> §5/PR 3 as #833). The 12 routes
> (`{admin,dashboard}/channels/{telegram,whatsapp}/{start,cancel,disable}`) are
> thin shims — name a channel, bind a resolver, call a runner
> (`start.ts`/`action.ts` here); put behaviour in the runner or the resolver,
> never back in a route. `resolve-actor.ts` holds the two portal resolvers,
> which must stay TWO functions: `resolveAdminActor` reads `businessId` from the
> request BODY behind `requireAdminWithAal2`, `resolveOwnerActor` reads
> `locationId` from the SESSION behind `requireRoleOr401` and never from the
> body — that asymmetry is a tenant-isolation boundary, and each resolver also
> owns its portal's subscription gate (admin `start` requires full access; admin
> `cancel`/`disable` deliberately require none; owner applies
> `resolveWritableAccountForLocation` on all three). `ChannelRouteConfig` is 4
> fields on purpose — **a fifth means the seam is wrong; re-plan rather than
> widen**. Deep links have ONE owner
> (`src/lib/notifications/channels/deep-links.ts`), as do the flag/env modules
> beside it (they are read by a server-component page, which is why they are in
> `src/lib` and not under `api/`). **The admin MFA gate is now configuration, not
> structure** — the runners call `config.resolveActor`, so `tsc` cannot reject a
> mis-binding and `ci:admin-aal2` is the compensating check (its mechanics: the
> `### admin/` section of `src/app/` above).

| File | Purpose |
|------|---------|
| `resolve-actor.ts` | The **Channel actor** seam: `resolveAdminActor` (body `businessId` + admin MFA gate, optional full-access check) and `resolveOwnerActor` (session `locationId` + `resolveWritableAccountForLocation`). The only axis that varies between the portals. |
| `start.ts` | `runChannelStart` + the shared 4-field `ChannelRouteConfig`. Token mint → advisory-locked enrollment upsert → cache invalidate → QR/deep-link response. |
| `action.ts` | `runChannelCancel`, `runChannelDisable`. |
| `flag-off.ts` | `flagOff()` — the single "channel disabled" 404. Called by the runners directly, never a config field. |

#### `u/` — unauthenticated recipient opt-out

| Route | What it does |
|-------|--------------|
| `u/[token]/route.ts` | **(#644, #652)** POST target of the `/u/<token>` unsubscribe form. Redeems the token (`source='unsubscribe_link'`) by passing `sql` into the **module-owned** transaction — this route opens none of its own, so the receipt below cannot be minted before the commit — then `303`s back to the landing page with a **relative** Location carrying `?ok=<receipt>` and `cache-control: no-store`. Mints the Success receipt **only** for `redeemed` / `already_suppressed` — never for `already_redeemed_not_suppressed`, whose whole purpose is to refuse a success claim the ledger cannot support. No auth and no session by design: the token IS the authorisation, and requiring a login to opt out would itself be the compliance defect. |

#### `auth/`

| Route | What it does |
|-------|--------------|
| `signup/route.ts` | Creates `users` + `businesses` rows in one transaction (`createBusinessTx`). Rate-limited. Returns 409 on duplicate email. |
| `finish-signup/route.ts` | Saves business details after Google OAuth. Guards against non-`email_confirmed` calls. |
| `callback/route.ts` | Supabase OAuth callback (Google sign-in). |
| `verify-otp/route.ts` | Verifies the 6-digit OTP from the confirmation email; transitions user to the onboarding flow. |
| `forgot-password/route.ts` | Requests password reset email via Supabase. |
| `reset-password/route.ts` | Consumes reset token and updates password. Signs out immediately after. |
| `mfa/challenge/route.ts` | **(Wave 2)** Same-origin, session-bound Supabase MFA challenge/verify endpoint with strict rate limiting. |
| `resend-confirmation/route.ts` | Resends verification email. Owner-only. |
| `signup-status/route.ts` | Polls whether the email confirmation has been clicked. |

#### `approve/[token]/`

The approval API. All routes read the token from the URL path and verify a device cookie + CSRF header.

| Route | What it does |
|-------|--------------|
| `route.ts` (GET) | Returns approval session data (review text, draft response, business name). **(WS4)** includes the scheduled-auto-post state (`auto_post_scheduled_at`) so the page can render the veto surface. |
| `session/route.ts` | POST: binds a device cookie to the approval session. Called on first page load. |
| `approve/route.ts` | POST: approves the draft. |
| `edit/route.ts` | POST: saves the owner's edited text. |
| `regenerate/route.ts` | POST: marks current draft superseded; enqueues a new generation job. |
| `veto/route.ts` | **(WS4)** POST: owner cancels a scheduled auto-post inside the veto window. Same wrapper machinery as the siblings (rate limit, CSRF, device binding, one tx), but the action is `vetoAutoPost` — NOT `lockPendingResponse` — because the target response is `approved`/`auto_policy`. `cancelled`/`already_cancelled` → 200 (idempotent double-tap); `too_late` → tx rollback + truthful 409. |

#### `dashboard/`

| Route | What it does |
|-------|--------------|
| `route.ts` (GET) | Returns all dashboard data for the logged-in owner (reviews, responses, metrics, Zernio connection state, pending-payment banner flag). Delegates to `src/lib/dashboard/service.ts`. |
| `import-offer/route.ts` | **(#677)** GET + POST for the **Import offer**. **GET** resolves owner scope, calls `createImportOffer` idempotently as a self-heal (its own `sql.begin` holding the `businesses` row lock — this is what makes best-effort offer creation on the Stripe path safe; drop one and you must drop the other), then returns `readImportOfferView`. No CSRF wrapper — GETs are exempt, per `past-replies/draft-status`. **POST** is `withSameOrigin`, validates `{ decision: 'accepted' \| 'declined' }` with zod, and makes ONE call to `recordImportDecisionAndEnqueue`, mapping its four outcomes: `recorded` → 200, `expired` / `already_answered` → 409 (so the banner can tell "too late" from "recorded" without reading a body field), `no_offer` → 404. The location comes from scope, never the body. |
| `reviews/pending/route.ts` | **(UX audit D2)** GET: the Needs Action queue's paged read — `?scope=<locationId\|all>&offset=<n>` → `{ items, total, pendingTotal, limit, offset }`. Composition root only: `withDashboardOwnerRead`, `resolveDashboardScopePolicy`, `resolveDashboardLocation` (legacy-kpis exposure, same as the main dashboard route), then one call to `src/lib/dashboard/pending-approvals.ts`. |
| `reviews/[reviewId]/approve/route.ts` | Approve from dashboard. |
| `reviews/[reviewId]/edit/route.ts` | Edit from dashboard. |
| `reviews/[reviewId]/regenerate/route.ts` | Regenerate from dashboard. |
| `reviews/[reviewId]/timeline/route.ts` | **(WS5)** GET: owner/account-scoped read of one review's run timeline. Returns 404 for unknown or out-of-scope reviews and delegates all spine reads to `src/lib/agents/read.ts`. |
| `reviews/[reviewId]/generate/route.ts` | **(#678, extracted #729)** POST: the **On-demand generation** `Generate` door for a never-replied review on the **Reviews list**. Composition root only (invariants #12/#15): `withSameOrigin`; per-owner-account rate limit *before* any DB work, ownership proof, account writable pre-check, per-review regen-budget peek, then `sql.begin(onDemandGenerateTx)` and result→HTTP mapping. The transaction itself — review lock, in-tx TOCTOU writable re-check, sibling/orphan/in-flight exclusions, `MAX(version)+1`, atomic enqueue on the `on_demand_generate` **Origin lane** (structurally excluded from auto-approval, so the draft is always owner-only, invariant #3) — lives in `src/lib/reviews/on-demand-generate.ts`, every sibling read natively business-scoped. Error strings are closed and unchanged: `review_not_found`, `already_answered`, `draft_already_exists`, `orphan_recovery_pending`, `regenerate_in_progress`, `rate_limited`, `regen_limit_reached`. |
| `reviews/[reviewId]/draft-status/route.ts` | **(#678)** GET: `reviewId`-keyed poller the inline Generate panel drives while a draft is in flight. Same-account sibling-location access is intentional; cross-account is a 404. A **moderation-held** response (open `flagged_responses` row) returns `{ status: 'idle' }` and never `response_text` — invariant #4 means the owner's only path is admin re-notification. |
| `agent-team/route.ts` | **(WS5)** GET: windowed Reply/Guardian/Insights outcome counts for the current account or selected location. Foreign or archived location scopes return 404. |
| `refusals/route.ts` | **(#1014)** The **Restraint tab**'s read endpoint — `agent-team/route.ts` with one name changed and one field added. Calls `getRefusalLog` ONCE and returns `{ window, autoApprovalEnabled, ...log }`. Traps: (a) `autoApprovalEnabled` is read HERE, not in the read module, so the reader stays flag-blind (invariant #13 + the `resolveFunnelEntry` purity precedent); (b) the error arm is `withDashboardOwnerRead`'s fixed message and must never map or echo a database error body, whose `query`/`parameters`/`detail` can carry moderation prose; (c) an archived location is a uniform 404 via `resolveDashboardLocation`, so a location read can never target one. |
| `escalations/route.ts` | **(WS5)** GET: bounded Needs-attention queue of the account's open Guardian escalations, with a separate `totalOpen` count. Delegates to `src/lib/escalations/list.ts`. |
| `escalations/[escalationId]/acknowledge/route.ts` | **(WS3)** POST: owner acknowledges an open Guardian escalation. Same-origin + owner auth + writable-subscription guard; delegates to `src/lib/escalations/transitions.ts` (404 not-found in scope, 409 already-resolved). |
| `escalations/[escalationId]/resolve/route.ts` | **(WS3)** POST: owner resolves an escalation (direct escalated → resolved stamps both timestamps). Same guards; records `escalation_resolved` on a completed run. |
_(The `past-replies/*` route set — `draft`, `draft/[responseId]`, `draft-status`, `publish`, `[responseId]/retry`, `[responseId]/restore-original` — is the `Regenerate` lane on the **Reviews list** (it replaces a LIVE Google reply, so it stays separate from the `reviews/[reviewId]/generate` door above). All of them gate on `editRepliesEnabled()` and return 503 `feature_disabled` when `EDIT_REPLIES_ENABLED` is off; the retired `PAST_REPLIES_VIEW_ENABLED` half of the old two-flag check is gone as of #678. Shared request parsing/guards live in `past-replies/_shared/edit-reply-request.ts`.)_
| `channels/route.ts` | GET: returns owner-scoped enrollment status for all channels (`{ enrollments, available, reasons }`). Auth: `businessId` from session only. |
| `channels/telegram/start/route.ts` | POST: starts a Telegram enrollment for the owner (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancels a pending Telegram enrollment. |
| `channels/telegram/disable/route.ts` | POST: disables an active Telegram enrollment. |
| `contacts/route.ts` | **(#541)** GET: paginated per-location contacts list; untrusted `limit`/`offset` clamped by `clampContactListPage` before any SQL. All four `contacts/**` routes 404 **before auth** when `SOLICITATION_WATCH_ENABLED` is off, and reject the aggregate ("all locations") scope with 400. |
| `contacts/[id]/route.ts` | **(#541)** DELETE: removes one contact (same-origin + `requireWritableOwner`); uniform 404 for malformed/unknown/out-of-scope ids; delegates to `deleteContact` in `src/lib/solicitation/contacts-repo.ts`. |
| `contacts/[id]/suppression/route.ts` | **(#645)** POST §7.5 owner do-not-contact (`scope='account'` / `owner_manual`, keyed on the **Normalized handle**, never the contact row id) + DELETE §7.6 clearing of a row **this account** created. An owner may never clear a `global` row: the repo predicate cannot reach one, so there is no input to this route that expresses the forbidden operation. Same posture as the sibling contact DELETE — flag gate + `requireWritableOwner` + same-origin, all inside `requireContactsWriteAccess`; uniform 404 out of scope; delegates to `markContactDoNotContact` / `clearContactDoNotContact`. |
| `contacts/uploads/route.ts` | **(#541)** POST: multipart contacts/visits CSV upload with required consent attestation (same-origin + `requireWritableOwner`); delegates to `createContactsCsvUpload` (one tx: upload row + `csv_ingest` outbox enqueue). |
| `contacts/uploads/[id]/route.ts` | **(#541)** GET: upload status/report read for the dashboard polling loop; delegates to `getUploadStatus` in `src/lib/solicitation/uploads.ts`. |
| `solicitation/batch/route.ts` | **(#544)** GET: the latest Solicitation batch for one location, as the Requests screen renders it. Pure read — flag gate (404 before auth), `withDashboardOwnerRead`, `requireContactsLocationScope`, then `readLatestBatch` in `src/lib/solicitation/batch-view.ts`. Logs one `batch_view_read` line per non-`building` response (the client polls `building` every 2s). |
| `solicitation/batch/_shared/scoped-batch-route.ts` | **(#629)** `withScopedBatch` — the write preamble the five batch POSTs share (flag gate → writable-owner auth → `requireContactsLocationScope` → body parse → handler → `endpoint`/`failureMessage` 500 mapping), plus the body readers `readJsonObject` + `readBatchId` + `readBatchAsk` (**#872** hoisted the `{ batchId, askId }` reader here so regenerate and withdraw share one parse boundary). Batch-shaped sibling of `withScopedContact`. The gate is a **bound function per route, never a boolean**: `approve`/`halt`/`regenerate`/`withdraw` pass `requireSolicitationSendWriteAccess` (watch AND send), `reviewed` passes `requireContactsWriteAccess` (watch only) — one collapsed gate would 404 the watch-only report ping for every customer, since `SOLICITATION_SEND_ENABLED` is unset everywhere today. Auth runs outside the catch (rethrow contract preserved); `withSameOrigin()` stays on each route as the outermost wrapper. |
| `solicitation/batch/approve/route.ts` | **(#629)** POST: the owner approves a built batch, optionally excluding individual asks. Thin adapter (invariant #12) — binds `requireSolicitationSendWriteAccess` (BOTH flags, gate ahead of auth so the surface 404s as if absent) and its own `readApproval` body reader into `withScopedBatch`, then one `approveBatch` call whose result union maps to a status: approved/already_approved → 200, not_ready/not_approvable → 409, unknown_exclusion → 400, not_found → 404. Logs ids and counts only — no rendered subject or body is ever interpolated into a log string. |
| `solicitation/batch/halt/route.ts` | **(#629)** POST: the owner stops a batch through the **Halt latch**. Same shape as `approve`, reading **only** `batchId` — the halt reason is derived server-side from **Batch state** by `ownerHaltReason` and is never accepted, forwarded, or defaulted from the client, because a client that could name its own reason could file a mid-drip halt as a veto and make the audit trail lie about whether email had left. halted/already_halted → 200, not_haltable → 409, not_found → 404. Its cross-origin refusal is pinned by a test on purpose: halt is as destructive as approval and must not be the one verb whose CSRF guard is unasserted. |
| `solicitation/batch/regenerate/route.ts` | **(#860)** POST: the owner asks for one new draft of one rendered ask (**Ask regeneration**). Fourth `withScopedBatch` adapter — same `requireSolicitationSendWriteAccess` gate as approve/halt, the shared `readBatchAsk` body reader (hoisted to `_shared/` by #872) (batch id **and** ask id, both UUIDs or a uniform 404), then one `requestAskRegeneration` call: accepted → **202** (accepted, not done), already_in_flight/not_regenerable/ask_not_regenerable → 409, budget_exhausted → `askRegenLimitResponse` 429, not_found → 404. TWO advisory gates precede the domain call and both fail OPEN — the per-owner `enforceDashboardRegenRateLimit` and the per-ask `peekAskRegenBudgetBatch`. The peek only READS: the route passes `budgetRemaining` and `requestAskRegeneration` decides, so the 429 lands AFTER tenant validation and an over-budget foreign ask still answers 404 (codex round 1, finding 4). Logs ids and statuses only. |
| `solicitation/batch/withdraw/route.ts` | **(#872)** POST: the owner withdraws ONE approved ask (**Ask withdrawal**, ADR 0021). Fifth `withScopedBatch` adapter — same `requireSolicitationSendWriteAccess` gate as approve/halt/regenerate, the shared `readBatchAsk` body reader (batch id **and** ask id, both UUIDs or a uniform 404), then one `withdrawAsk` call: withdrawn/already_withdrawn → 200, not_withdrawable/not_live → 409, not_found → 404. The reason (`owner_withdrawn`) is fixed server-side and the row is resolved under the batch lock, so nothing client-supplied names a reason, a row or a status; the wire projects `remainingLive` + `closed` and never the send parent run id (the halt/approve `toWire` precedent). Logs ids and statuses only. |
| `solicitation/batch/reviewed/route.ts` | **(#544)** POST: records that an owner opened the Spoilage report (`reviewed_at`, first-write-wins → 204 either way). Separate from the GET on purpose — a poll must not mean "a human looked". Same-origin + `requireContactsWriteAccess` (flag gate ahead of `requireWritableOwner`); `?scope=` is required, since the body carries only `batchId`. Shares `withScopedBatch` with the four send-lane verbs (approve/halt/regenerate/withdraw) but **not** their gate — it is watch-only, and a test pins the 204 with `SOLICITATION_SEND_ENABLED` explicitly off. |
| `solicitation/scope-param.ts` | **(#544)** How the Solicitation client islands SEND the `scope` location query param (`SOLICITATION_SCOPE_PARAM` + `withSolicitationScope`) — a mirror of the name `resolveDashboardRequest` (`policy.ts`) reads, not its owner; the two must stay in lockstep. Server-import-free so client islands can build URLs without pulling the DB client into the bundle; a misspelled param would otherwise silently fall back to the owner's default location. |


_`api/` continues in [`app-api-b.md`](app-api-b.md) (`settings/` … `contact/`)._

---

_Index: [`docs/directory.md`](../directory.md)_

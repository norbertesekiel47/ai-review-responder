# Modularization Design — High + Medium Priority Files

**Date:** 2026-04-26
**Branch:** `refactor/modularization`
**Status:** Approved (pending user spec review)
**Scope:** Pure mechanical extraction with safe cleanups (parseArray dedup, import normalization). No behavior changes.

---

## 1. Goal

Decompose 11 oversized source files (6 high-priority + 5 medium-priority from the structural pass) into focused, single-purpose modules. Eliminate duplication of `parseArray` across three call sites. Behavior remains 100% identical; only file boundaries and import paths change.

## 2. Non-goals

- No behavioral changes. Residual risks already tracked in `CLAUDE.md` (e.g., the `subscription_status_changed_at` plan, the approval email crash-after-send race) stay deferred to their planned billing/notification sprints.
- No new tests. Existing test suites are the regression net.
- No test-file splits. The structural pass flagged 4 large test files; those are deferred to a later cleanup pass.
- No behavior refactors outside the 11 targets. Mechanical changes to non-target files are allowed and expected: import updates (e.g., `parseArray` callers in `worker/jobs/ResponseGeneratorWorker.ts`), additions of new shared utility modules (`src/lib/shared/db-array.ts`, `src/lib/approval/audit.ts`), and small extensions to existing shared modules (`worker/ingress/shared.ts`). Adjacent code with unrelated smells stays untouched.

## 3. Inputs

Findings from a repo-wide structural pass (427 tracked files, 382 TS/TSX). Confirmed by reading each file before this spec was written:

| File | Lines | Concerns |
|---|---|---|
| `src/lib/notifications/email.ts` | 1110 | Resend client + headers/tags + 8 template families in one file |
| `src/app/admin/businesses/[id]/page.tsx` | 990 | Data load + mutations + 6 panels in one client component |
| `src/lib/approval/service.ts` | 590 | 9 public functions across 3 auth modes; audit logger duplicated |
| `worker/jobs/NotificationWorker.ts` | 423 | Subscription guard + enrollments + 9 provider error classes + cost guard + outbox in one loop |
| `worker/ingress/twilio-whatsapp.ts` | 420 | Status + inbound handlers + helpers in one file |
| `worker/ingress/telegram.ts` | 447 | Parallel pattern to whatsapp; shares `markProcessed`/`markFailed` |
| `src/app/api/dashboard/route.ts` | 405 | Auth + 8 queries + assembly + duplicate `parseArray` |
| `src/app/api/admin/businesses/route.ts` | 390 | Onboarding service logic in route handler |
| `src/app/api/admin/businesses/[id]/route.ts` | 378 | GET aggregation + PATCH update + duplicate `parseArray` |
| `src/app/admin/businesses/new/page.tsx` | 549 | Form + schema + prefill race + payload shaping |
| `src/components/DashboardContent.tsx` | 470 | Fetch + screens + charts + reviews + actions |

`parseArray` duplicate locations (verified):
- `worker/jobs/ResponseGeneratorWorker.ts:100`
- `src/app/api/admin/businesses/[id]/route.ts:11`
- `src/app/api/dashboard/route.ts:80`

## 4. Strategy

### 4.1 Behavior preservation
- All extracted code is moved verbatim (or with the smallest possible adjustments to satisfy module boundaries).
- For each big file split, the original path is kept as a barrel re-export so call sites compile unchanged within the same commit.
- A final optional cleanup commit (Wave 5) may inline imports and delete barrels — only if the inlining stays codex-reviewable.

### 4.2 Sequencing — wave-ordered, risk-ascending
1. **Wave 1 — Shared utilities.** Smallest, lowest blast radius. Other waves depend on these.
2. **Wave 2 — Leaf UI extractions.** No worker risk; pure React/UI.
3. **Wave 3 — Service-layer extractions.** Server-side data assembly out of route handlers.
4. **Wave 4 — High-risk extractions.** `email.ts`, approval service, NotificationWorker, ingress.

Each wave is independently shippable. If Wave 4 surfaces a problem, Waves 1-3 are already in.

### 4.3 Per-commit gate
Every commit must pass, in order:
1. `pnpm lint`
2. `pnpm tsc --noEmit`
3. `pnpm test`
4. `pnpm build`

**Codex review** runs after every commit but is environment-conditional. The Codex Review Bridge scripts live in WSL2 at `~/dev/codex-bridge/`, but this workspace runs Git Bash on Windows. The actual invocation from this shell is:

```bash
wsl bash -c 'bash ~/dev/codex-bridge/start'                                    # once at session start (idempotent)
wsl bash -c "bash ~/dev/codex-bridge/nudge 'review commit <SHA>: <summary>'"   # after every commit
```

If WSL2 is unavailable (e.g., running on a different machine, in CI), the codex step is skipped and the commit proceeds. The `CODEX_BRIDGE_DISABLED=1` env var also skips the nudge if the user wants quieter sessions. `watch` is not used because there is no PR; codex's feedback surfaces in its tmux session for asynchronous review.

If any gate fails, fix the cause and create a NEW commit (never `--amend` after partial completion). If a wave is in progress and a gate fails repeatedly, halt the wave and surface the issue.

### 4.4 Backwards-compat for big-file splits
- `email.ts`, `approval/service.ts`, and `worker/ingress/twilio-whatsapp.ts` keep their original paths as barrel re-exports in the split commit. The barrel file contains ONLY `export * from './...'` lines. No logic remains. Call sites stay unchanged in that commit; a follow-up cleanup commit may inline imports and delete barrels if it stays codex-reviewable.
- `worker/jobs/NotificationWorker.ts` is the EXCEPTION: it is the canonical entry called by `worker/index.ts`, so it is rewritten in place as a thin orchestrator (~80 lines) without a barrel-indirection layer. `worker/index.ts` continues to import `handleSendNotification` from the same path.
- Tests that currently import from `src/lib/notifications/email` continue to work without modification.

## 5. Wave 1 — Shared utilities

### 5.1 `src/lib/shared/db-array.ts`
**Replaces:** 3 copies of `parseArray` in `worker/jobs/ResponseGeneratorWorker.ts:100`, `src/app/api/dashboard/route.ts:80`, `src/app/api/admin/businesses/[id]/route.ts:11`.

**Export:**
```ts
export function parseDbArray(val: unknown): string[];
```

**Semantics:** identical to the most-correct of the three existing implementations (the one handling JSONB-as-string from PgBouncer per the lab note dated 2026-04-09). All three sites get updated to import from this module in the same commit.

### 5.2 `worker/ingress/shared.ts` (extend existing)
**Adds:**
- `markInboundEventProcessed(dedupKey: string): Promise<void>`
- `markInboundEventFailed(dedupKey: string, reason: string): Promise<void>`

**Replaces:** `markProcessed` / `markFailed` private helpers in `worker/ingress/telegram.ts:106,114` and `worker/ingress/twilio-whatsapp.ts:168,175`. The existing `claimInboundEvent` already lives in `shared.ts`; this completes the symmetry.

Provider-specific payload-redaction helpers (`redactWhatsAppPayload`, `redactForAudit`) stay in their own files because their shapes differ.

### 5.3 `src/lib/approval/audit.ts`
**Replaces:**
- `insertAuditLog` (token mode) — `service.ts:49`
- `insertAuditLogSession` (session mode) — `service.ts:313`
- `buildCallbackAudit` — `service.ts:488`

**Exports (names match current code; nothing renamed):**
```ts
export interface AuditContext { tokenHash: string; deviceCookieHash: string | null; ipAddress: string | null; }
export interface SessionAuditContext { /* unchanged from service.ts:308 */ }

// Existing public input union — DO NOT rename. External callers (ingress layers) construct values of this type.
export type CallbackAuditContext = /* discriminated telegram | whatsapp union, unchanged from service.ts:449 */;

// New name for the buildCallbackAudit return shape so it doesn't collide with the input type above.
export interface CallbackAuditArtifacts { audit: AuditContext; metadata: Record<string, unknown>; }

export interface CallbackApprovalInput { /* unchanged from service.ts:461 */ }

export function buildCallbackAudit(
  link: ApprovalLink,
  input: CallbackApprovalInput,
  correlationId: string,
): CallbackAuditArtifacts;

export async function insertAuditLog(tx, responseId, businessId, action, audit, metadata?): Promise<void>;
export async function insertAuditLogSession(tx, responseId, businessId, action, audit, metadata?): Promise<void>;
```

The two `insertAuditLog*` functions remain separate because they accept different audit-context shapes. They can be unified later if a common interface emerges — out of scope for this refactor.

`CallbackAuditArtifacts` is a new internal name. `buildCallbackAudit`'s current return type is an inline anonymous shape (`{ audit: AuditContext; metadata: Record<string, unknown> }`), so naming it doesn't change any public API.

## 6. Wave 2 — Leaf UI extractions

### 6.1 `src/app/admin/businesses/[id]/page.tsx` (990 → ~150 lines)
Page becomes a thin orchestrator that wires sections together.

**New files (colocated):**
- `[id]/components/ProfileEditor.tsx`
- `[id]/components/TrackedKeywordsSection.tsx`
- `[id]/components/ManualRankingSection.tsx`
- `[id]/components/ChannelsPanel.tsx`
- `[id]/components/ReviewsList.tsx`
- `[id]/components/ManualPostFlow.tsx`
- `[id]/hooks/useBusinessDetail.ts` — owns `fetch`/`mutate` for the GET /api/admin/businesses/[id] data shape.

The exact section list will be confirmed against the actual file's render tree in the writing-plans phase. If a panel is small enough that extraction adds more import noise than it removes, it stays inlined.

### 6.2 `src/app/admin/businesses/new/page.tsx` (549 → ~120 lines)
**New files (colocated):**
- `new/components/IdentitySection.tsx`, `new/components/BrandVoiceSection.tsx`, `new/components/OnboardingMetaSection.tsx` (mapped to actual fieldsets — names finalized in plan).
- `new/hooks/useBusinessPrefill.ts` — handles SerpAPI prefill race.
- `new/schema.ts` — colocated Zod schema.

Server-side schema reuse: if `src/lib/shared/schemas` already exports a compatible schema, the client schema is derived; otherwise both schemas reference the same type definitions.

### 6.3 `src/components/DashboardContent.tsx` (470 → ~120 lines)
**New files:**
- `src/components/dashboard/ValueSummary.tsx`
- `src/components/dashboard/Charts.tsx`
- `src/components/dashboard/ReviewsList.tsx`
- `src/components/dashboard/ReviewActions.tsx`
- `src/components/dashboard/AccountStateScreens.tsx`
- `src/hooks/useDashboardData.ts`

**Type contract:** `src/lib/dashboard/types.ts` becomes the shared `DashboardData` type imported by both `src/app/api/dashboard/route.ts` and `src/components/DashboardContent.tsx`. The current pattern of importing route handler types directly is replaced.

## 7. Wave 3 — Service-layer extractions

### 7.1 `src/lib/dashboard/service.ts`

The current route at `src/app/api/dashboard/route.ts` has a cheap pre-query (lines 110-171) that returns 3 distinct state shapes BEFORE the heavy 8-query block:

- `pending_payment` — owner self-serve, hasn't paid yet → return payment URL CTA
- `pending_payment_admin_handoff` — admin onboarded, no payment URL → handoff CTA
- `active_pending_business` — paid but never finished business wizard → wizard CTA

Only after those three early-return branches does the route run the 8 heavy queries that produce `DashboardDataActive`. The full `DashboardData` discriminated union is the route's external contract.

**Decision:** the route keeps the preflight (it's small auth/state branching that fits the route's job). The service owns ONLY the heavy assembly for the active path:

```ts
// service.ts
export async function getActiveDashboardData(
  businessId: string,
  opts?: { sql?: SqlClient }
): Promise<DashboardDataActive>;
```

```ts
// route.ts (after refactor)
const subRow = await /* preflight query */;
if (subRow.subscription_status === 'pending_payment' && subRow.onboarded_by !== null) { /* admin handoff branch */ }
if (subRow.subscription_status === 'pending_payment') { /* self-serve payment branch */ }
if (subRow.subscription_status === 'active' && !subRow.place_id_verified && !subRow.google_maps_url) { /* active_pending_business branch */ }
const data = await getActiveDashboardData(businessId);
return jsonResponse(data);
```

Route shrinks to ~120 lines (preflight + auth + thin glue). Service is ~250-300 lines (the 8-query assembly + ranking grouping + brief selection).

The `DashboardData*` types stay in the route file (or move to `src/lib/dashboard/types.ts` per §6.3) so both the service and the UI hook can import them without depending on the route handler.

### 7.2 `src/lib/onboarding/admin-onboarding-service.ts`
Owns the admin-mode business creation logic currently inline in `src/app/api/admin/businesses/route.ts:109`. The route stays as auth + Zod parse + service call + response shaping.

This complements the existing `createBusinessTx` (which has both `admin` and `self_serve` modes from the recent self-serve signup PR). The new service module is a layer above `createBusinessTx`, owning the admin-specific orchestration (invite-user-by-email, auth_id patch, compensating delete, etc.).

### 7.3 `src/app/api/admin/businesses/[id]/route.ts`
**Split inside the route file** (or extracted to `src/lib/admin/business-detail-service.ts` if the GET aggregation is large enough to justify a separate module — decided in plan):
- GET: aggregation logic moves to a private `getBusinessDetail(id)` function or service module.
- PATCH: update/upsert logic moves to a private `updateBusiness(id, patch)` function.

`parseArray` is replaced by `parseDbArray` from Wave 1.

## 8. Wave 4 — High-risk extractions

### 8.1 `src/lib/notifications/email.ts` split

**New module tree:**
```
src/lib/notifications/
├── email.ts                        # barrel re-export
└── email/
    ├── client.ts                   # lazy Resend client (lines 1-14 of original)
    ├── headers.ts                  # getEmailHeaders, getEmailTags, extractMailbox, EmailCategory
    └── templates/
        ├── shared.ts               # base HTML chrome (header/footer/button/divider helpers if any)
        ├── approval.ts             # sendApprovalEmail, ApprovalEmailParams (lines 105-219 of original)
        ├── manual-post.ts          # buildManualPostEmailHtml, ManualPostEmailParams
        ├── internal.ts             # sendInternalEmail, InternalEmailParams
        ├── weekly-value-report.ts  # buildWeeklyValueReportHtml + params
        ├── monthly-impact.ts       # buildMonthlyImpactEmailHtml + params
        ├── owner-nudge.ts          # buildOwnerNudgeEmailHtml + params
        ├── partner-alerts.ts       # 4 partner alert builders (engagement, escalation, low-engagement, satisfaction)
        └── onboarding.ts           # day1, day7, day30 builders
```

**Barrel `email.ts`:**
```ts
export * from './email/client';
export * from './email/headers';
export * from './email/templates/approval';
export * from './email/templates/manual-post';
export * from './email/templates/internal';
export * from './email/templates/weekly-value-report';
export * from './email/templates/monthly-impact';
export * from './email/templates/owner-nudge';
export * from './email/templates/partner-alerts';
export * from './email/templates/onboarding';
```

All existing imports from `@/lib/notifications/email` continue to resolve.

### 8.2 `src/lib/approval/service.ts` split

**Decision:** mode-only split. Each auth mode (token, session, callback) gets its own file with its current logic preserved verbatim. We do NOT extract a shared "core action" abstraction in this refactor.

**New module tree:**
```
src/lib/approval/
├── service.ts                  # barrel re-export
├── audit.ts                    # from Wave 1 — insertAuditLog, insertAuditLogSession,
│                               #   buildCallbackAudit, types
├── locks.ts                    # lockValidLink, lockPendingResponse, lockLinkByIdForCallback,
│                               #   revokeSiblings, consumeLink, revokeOpenLinksForResponse, verifyDevice
├── token-mode.ts               # approve, edit, regenerate (token-flow versions, verbatim from service.ts)
├── session-mode.ts             # approveBySession, editBySession, regenerateBySession,
│                               #   establishApprovalSession (verbatim)
└── callback-mode.ts            # approveViaCallback, regenerateViaCallback (verbatim)
```

**Why no shared core actions:** The three modes look superficially similar but differ in five substantive ways:

| Concern | Token | Session | Callback |
|---|---|---|---|
| Authorization | `verifyDevice` (cookie hash) | session lookup (route-level) | `lockLinkByIdForCallback` + provider signature |
| Link consumption | `consumeLink` | none (no current link) | `consumeLink` |
| Sibling revocation | `revokeSiblings` (excludes consumed link) | `revokeOpenLinksForResponse` (revokes all open) | `revokeSiblings` (excludes consumed link) |
| Correlation ID | passed in by caller | passed in by caller | recovered via `recoverCorrelationId` from outbox history |
| Audit insertion | `insertAuditLog` (AuditContext) | `insertAuditLogSession` (SessionAuditContext) | `buildCallbackAudit` → `insertAuditLog` w/ metadata |

Forcing a shared core action would parameterize all five differences and force the orchestrator to know about each mode's internals — which is what the original file already does, just in line. That's a behavior-aware refactor, not mechanical, and is explicitly out of scope (§2). A future sprint can revisit deduplication after this refactor lands and after we have stronger test coverage on each mode.

**Barrel `service.ts`:** re-exports from `audit`, `locks`, `token-mode`, `session-mode`, `callback-mode` so all current external imports continue to resolve.

### 8.3 `worker/jobs/NotificationWorker.ts` decomposition

**New module tree:**
```
worker/jobs/
├── NotificationWorker.ts          # ~80 lines — thin orchestrator
└── notification/
    ├── eligibility.ts             # subscription gate + per-channel feature flag + verified enrollments
    ├── dispatch.ts                # per-channel send loop with isolated try/catch
    ├── errors.ts                  # provider error classification → enrollment mutation rules
    │                              #   (owner-intent vs config-error vs transient)
    └── sms-budget.ts              # reserveSmsCost / refundSmsCost wrapper
```

**`NotificationWorker.ts` becomes:**
```ts
export async function handleSendNotification(job): Promise<void> {
  const ctx = await loadContext(job);
  if (!ctx) return;  // already-handled cases (not found, mismatch, not pending)
  const eligible = await getEligibleChannels(ctx);
  if (!eligible.length) return await handleNoEligibleChannels(ctx);
  const results = await dispatchAll(ctx, eligible);
  await finalizeOutcomes(ctx, results);
}
```

Provider error handling (`SmsRecipientUnsubscribedError`, `TelegramRecipientBlockedError`, the 5 WhatsApp errors, etc.) lives in `errors.ts` as a `classifyError(channelId, err): ErrorClassification` function returning the enrollment-mutation directive. The dispatch loop calls this and applies it.

**Risk note:** This is the highest-risk wave because NotificationWorker is on the critical-path for owner approval emails. Mitigations:
- Existing test coverage in `worker/__tests__/NotificationWorker.test.ts` is the regression net (verified to exist before starting; if not, halt and add coverage first).
- Each file in `worker/jobs/notification/` is committed and reviewed by codex separately before the orchestrator commit lands.
- The barrel pattern is NOT applied here — `NotificationWorker.ts` is the canonical entry called by `worker/index.ts`. We rewrite it in place; we don't add a re-export indirection.

### 8.4 `worker/ingress/twilio-whatsapp.ts` split

**New files:**
- `worker/ingress/twilio-whatsapp-status.ts` — `handleTwilioWhatsAppStatus`
- `worker/ingress/twilio-whatsapp-inbound.ts` — `handleTwilioWhatsAppInbound`
- `worker/ingress/whatsapp-shared.ts` — provider-specific shared helpers (`redactWhatsAppPayload`, `parseButtonPayload`, `fullUrl` if shared between status and inbound)

Per §4.4, `worker/ingress/twilio-whatsapp.ts` becomes a barrel re-export of the two split handlers + helpers in the split commit. `worker/index.ts` imports stay unchanged in that commit. A follow-up cleanup commit may update `worker/index.ts` to import directly from the split files and delete the barrel; that's optional.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Barrel re-exports break tree-shaking or cause cycles | `pnpm build` per commit catches cycle errors; tree-shaking impact is negligible for server code. |
| Test coverage gap on NotificationWorker | Verify existing tests before Wave 4.3 begins; halt and add coverage if missing. |
| Codex review surfaces a real concern mid-wave | Address in a follow-up commit before the next wave's commits. Don't batch. |
| Worker startup-assertions reference old paths | `worker/startup-assert.ts` is grep'd before Wave 4 commits to confirm no path references break. |
| `pnpm build` slow per commit | Accepted — user explicitly chose full gates. Estimated +90s per commit. |
| External callers import private helpers | `parseArray` is the only known case. Confirmed scope after grep; barrel exports cover everything else. |

## 10. Out of scope (deferred, tracked elsewhere)

- Test file splits (`src/app/api/admin/channels/sms/__tests__/routes.test.ts`, `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`, `src/app/api/admin/costs/__tests__/route.test.ts`, `worker/__tests__/EngagementAlertWorker.test.ts`) — separate cleanup pass.
- The `subscription_status_changed_at` column work — existing residual risk in CLAUDE.md.
- The approval email crash-after-send race — existing residual risk in CLAUDE.md.
- New tests for new module boundaries.
- Linting rule additions or stricter TS config.

## 11. Acceptance

This refactor is complete when:
1. All 11 target files are decomposed per this spec.
2. `parseArray` exists in exactly one place (`src/lib/shared/db-array.ts`).
3. All 4 per-commit gates pass on every commit in `refactor/modularization`.
4. Codex received a review nudge for every commit.
5. `pnpm test` and `pnpm build` pass on the final commit of the branch.
6. No orchestrator or mixed-responsibility file in the refactored set exceeds ~250 lines. Focused single-purpose template files (e.g., `email/templates/weekly-value-report.ts`, `email/templates/monthly-impact.ts`) may legitimately exceed this — long inline HTML strings are not a code smell. The ceiling targets files where multiple concerns are tangled, not files that are simply long because their one concern is verbose.

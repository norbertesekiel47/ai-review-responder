# Owner Operator Run B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in owner opens the Operator screen, sends an **Operator turn**, reads the stored **Proposal** cards it earned, and applies one voice Proposal through `applyProposal` — reading back a server-written **Receipt** committed in the same transaction as the voice write — or declines it. A repeat Apply returns the stored Receipt and executes nothing; a moved **Version token** marks the card stale with a **Refresh plan** action; and the screen recovers a failed or stranded turn instead of spinning.

**Architecture:** One new deep module, `src/lib/agents/operator/apply.ts`, owns the whole Apply protocol behind a single call: contract check before any lock, then `sql.begin` with the `businesses` row locked first and the `agent_proposals` row second, revalidation of actor/subscription/tier/ownership under those locks, a text-to-text **Version token** comparison, the operation's own fields written through the shared voice writer, a read-back, the **Receipt**, and the sibling-stale sweep — all or nothing. A second new module, `version-token.ts`, owns the token type, its JSONB parse site and its equality. Two new POST composition roots map the module's result kinds to status codes. The screen is a Console (Harbor) client island under the authenticated shell that holds `conversationId` and `turnId` in URL state, polls the existing `GET /api/operator/turns/:id`, and renders every card from a stored row.

**Tech Stack:** Next.js 16 App Router (server page + client island) · Postgres.js (`postgres`) transactions · zod · React Testing Library + jsdom · fast-check · Playwright · vitest.

---

## What this run builds

Run B is the executor and the screen, and nothing else.

**In:** `src/lib/agents/operator/version-token.ts` (new) · `src/lib/agents/operator/apply.ts` (new) · `ReceiptSchema` / `parseReceipt` / `PROPOSAL_FAILURE_REASON` on `schema.ts` · `writerFields` on every proposable in `catalog.ts` · `ProposalView` extension, `readProposalForAccount`, `lockProposalForAccount`, `declineProposal` and `markSiblingProposalsStale` on `proposals.ts` · `POST /api/operator/proposals/:id/apply` and `.../decline` · `?locationId=` and `connectionStatus` on the conversation read · one `hasImpersonationCookie` in `src/lib/admin/impersonation/cookie.ts` with both existing call sites migrated · `/api/operator` joining `isProtectedOwnerApiRoute` · the Operator screen (`page.tsx`, `OperatorClient.tsx`, `ProposalCard.tsx`, `ReceiptView.tsx`, `RequestedCapabilityCard.tsx`, `SummaryPanel.tsx`, `StarterActions.tsx`, `wording.ts`, `operator.css`) · the `operatorEnabled` nav prop and the `'operator'` `NavSection` · the e2e spec and its SQL seed helper · the documentation owed by Run A's alerting decision.

**Out (per the intake `non_goals`):** the three auto-approval proposable operations, `patchAutoApprovalSettingsInTransaction`, `lockAccount` ordering, `assertConfirmationProvided`, the consequence line, asymmetric friction and expansion cards — slice 2 · undo from Receipts, `createRestoreProposal`, `clear_location_override`, the policy-refused card — post-checkpoint · any change to the model schema, the validator, the **Context snapshot**, the prompt, the catalog's operation SET, migration 120, or anything Run A settled · a fix for the stranded-turn open item (spec §14 CA1) or the predecessor-wait/watchdog clock conflict (CA4) — the screen only surfaces them · the "last five posted replies" list — Run B shows the posted-7d count · flipping `OWNER_OPERATOR_ENABLED` in production · a Decline reason.

**No migration.** Every column Apply writes already exists: `supabase/migrations/120_owner_operator.sql:105-111` declares `status`, `superseded_by`, `decided_by_user_id`, `applied_at`, `receipt` and `failure_reason` on `agent_proposals`. Run B writes columns Run A created and left NULL.

---

## Decisions this plan locks

D1–D12 are the owner's locked decisions (sign-off 2026-09-12) and are not reopened here. V-items are findings verified against this worktree's HEAD `6edacd0b0` while writing; P-items are plan-level choices the brief did not cover, recorded so the root can ratify or reverse them.

**D1 — Visual system: Console (Harbor), inside the authenticated shell.** Spec §3.1 says Island. That is wrong: the screen lives at `src/app/(authenticated)/dashboard/operator/page.tsx`, under the shell that already loads `_styles/tokens.css` + `_styles/console.css` and wraps everything in `.rw-console` (`src/app/(authenticated)/layout.tsx:31-32`, `:182`). T6 corrects the one line in §3.1 and records the correction in §15.

**D2 — `All locations` disables the composer.** Under scope `all` the composer is disabled and an inline chooser is shown; choosing calls the existing `setLocationScope` (`src/contexts/LocationContext.tsx:93-102`). No turn is ever posted without one stored location. `GET /api/operator/conversation` gains an optional `?locationId=` that scopes the summary **when the conversation has no turns** — additive to Run A's null rule (`src/lib/agents/operator/reads.ts:132-144`), never a replacement for the latest-turn scoping. The summary also carries `connectionStatus`, the latest `zernio_connections` row for that location, account-scoped through `businesses`.

**D3 — Disabled state.** `page.tsx` calls `notFound()` when `ownerOperatorEnabled()` is false, exactly as `src/app/(authenticated)/dashboard/requests/page.tsx:13-16` does for watch-mode. The nav entry is omitted via a server-authoritative `operatorEnabled` prop from the layout, exactly as `solicitationEnabled` is (`src/app/(authenticated)/layout.tsx:179`, `:194-200`). An already-open screen that receives a 404 `operator_disabled` from ANY route shows the not-available notice and stops polling.

**D4 — Card note.** Exactly `Prepared for <location display label>`, shown only when the browser's current scope differs from the turn's stored `location_id` — including when the scope is `all`.

**D5 — Decline records the actor only.** `status='rejected'`, `decided_by_user_id` set, `failure_reason` NULL. Idempotent on repeat: the second call returns the same row with 200.

**D6 — Alerting.** The six domain terminal reasons stay structured logs only. The decision is recorded in spec §14 and in the runbook with the staging distribution query; the revisit trigger is the §12.1 checkpoint. Runbook **rule 11 already exists** as a pending row (`docs/runbooks/beta-launch-alerting.md:412`) and is flipped to BUILT by T6 once the root has built it in both Sentry projects.

**D7 — T8 runs after merge.** The staging flip, the p50/p95 measurement, the constants tune, the §12.1 checkpoint report and the §15 entry land in a follow-up PR.

**D8 — One impersonation check.** `hasImpersonationCookie(request: NextRequest)` is exported from `src/lib/admin/impersonation/cookie.ts` beside `IMPERSONATION_COOKIE_NAME` (`:38`). The two byte-identical private copies — `src/app/api/operator/turns/route.ts:97-99` and `src/app/api/settings/auto-approval/route.ts:116-118` — are deleted and both routes import it; the two new routes import it too. Architecture pass H1-B.

**D9 — Version token.** `{ businessId, updatedAt }` with `updatedAt` the verbatim `updated_at::text` both `readVoiceConfig` (`src/lib/responses/voice-settings.ts:79-100`) and `updateVoiceConfig` (`:147-153`) already return. Compared TEXT TO TEXT. **Current** (from the locked `businesses` row), **prepared** (`agent_proposals.prepared_version_token`) and **expected** (the client body) must all be equal, else the Proposal is `stale`.

**D10 — Apply executes only the operation's own fields.** `ProposableOperation.writerFields(input): Partial<VoiceConfig>` is added in `catalog.ts` through `defineProposable` (`src/lib/agents/operator/catalog.ts:53-100`) and passed to `updateVoiceConfig(tx, { accountId, locationId, fields })`. Applying `after` wholesale would write the four fields the proposal did not name, clobbering a concurrent settings edit to a different field that the token check does not cover — the token proves the ROW did not move, and once we have established that, writing more than was proposed is a widening nobody approved.

**D11 — Sibling pending proposals go stale in the same transaction.** Every other `pending` Proposal on the same `location_id` and account becomes `stale` with `failure_reason='version_mismatch'` inside the Apply transaction. Spec §8.3: approved intent is never rewritten silently.

**D12 — Executor throw vs. executor refusal.** A throw (constraint, connection loss) propagates out of `sql.begin`, rolls mutation and Receipt back together, and the route answers 500 `apply_failed` with the Proposal still `pending`. A DETERMINISTIC refusal — `updateVoiceConfig` returning `{ ok: false, reason: 'no_fields' }` — is not an exception: it writes `status='failed'`, `failure_reason='write_failed'`, `receipt` NULL, and commits that state change.

---

**V1 (verified) — every column Apply writes exists; no migration.** `supabase/migrations/120_owner_operator.sql:89-113` declares `decided_by_user_id UUID NULL REFERENCES users(id)`, `applied_at TIMESTAMPTZ NULL`, `receipt JSONB NULL` and `failure_reason TEXT NULL`, and `agent_proposals_status_check` (`:105`) already admits all six statuses. `prepared_version_token JSONB NOT NULL` (`:103`) is written by `buildProposalRows` (`src/lib/agents/operator/proposals.ts:81`). Run B adds no DDL, so no `pnpm test:db:setup` re-run is needed and no staging/prod lockstep step exists in this run.

**V2 (verified) — `/api/operator` is NOT in `isProtectedOwnerApiRoute` today.** `src/lib/shared/protected-routes.ts:47-59` names `/api/dashboard`, `/api/settings`, `/api/account`, `/api/billing`, `/api/locations` and three Zernio paths. Proxy branch 6 (`src/proxy.ts:349-364`), which is the only place `getAalGate()` runs for an API route (`src/proxy.ts:260-271`), therefore never runs for an Operator route. The routes are NOT unguarded — `withSameOrigin()` and `requireWritableOwner` give origin, role, `account_id`, writable-subscription and the offboarding gate — **the missing piece is AAL2/MFA only**, and it is latent twice over (the flag is off, and `getAalGate` returns `'ok'` when MFA enforcement is off). **Decision: ONE entry in the existing allowlist, no fourth proxy branch** (architecture pass H1-A). T2 owns it.

**V3 (verified) — the page lives at `/dashboard/operator` and therefore rides proxy branch 7 unchanged.** Owner decision 2026-09-12, reversing an earlier draft that put it at a top-level `/operator`: `isProtectedRoute` already admits `/dashboard/` (`src/lib/shared/protected-routes.ts:92-112`) and branch 7 (`src/proxy.ts:366-385`) already spells `/dashboard` as one of its three owner-page literals, so `/dashboard/operator` gets the login redirect, the `role === 'owner'` check and the AAL2 gate with NO change to `src/proxy.ts` — which is outside this run's edit surface. Combined with V2 (the API on branch 6) the page and its data are behind the same MFA bar as `/settings`, and there is no gap to record. The one consequence that IS load-bearing: `deriveNavSection` must test `/dashboard/operator` BEFORE its `/dashboard` catch-all, or the Operator row silently folds into Dashboard (T3 Step 9, pinned by its own case).

**V4 (verified) — the `'operator'` nav-section cases join the EXISTING `deriveNavSection` suite.** `src/components/dashboard/shell/__tests__/active-nav.test.ts:4` is that suite, and `src/components/dashboard/shell/__tests__/*.ts` is in the amended edit surface, so no second nav-section file is created. The two navs' own render tests stay where they are, in `src/components/dashboard/__tests__/`.

**V5 (verified) — `mock-sql` is the unit seam for a transactional module.** `createMockSql()` (`worker/__tests__/helpers/mock-sql.ts:106-170`) gives a tagged-template double whose `sql.begin(cb)` invokes `cb` with the SAME mock, records every awaited query as `{ text, values, inTransaction }`, and serves a FIFO `sqlReturnQueue`. That is exactly what title 3 ("locks the businesses row before the proposal row") needs: statement ORDER is `sqlCalls`, and `inTransaction` proves the write and the Receipt shared one transaction. `src/lib/agents/operator/__tests__/proposals.test.ts:4-7` is the in-repo wiring precedent. **The live database is still required for titles 4, 13, 14, 15 and 16** — a mock cannot prove a rollback or a row lock.

**V6 (verified) — a `status_ref`-style trap does not exist for the Receipt.** Unlike a metric, a Receipt is frozen state by construction: it is written once, inside the mutation's transaction, and never recomputed on read. `ProposalView.receipt` is therefore a passthrough of the stored JSONB, parsed by `parseReceipt` and rendered. No read path recomputes any Receipt field.

**V7 (verified) — runbook rule 11 already exists as a PENDING row.** `docs/runbooks/beta-launch-alerting.md:412` carries `| 11 | `agent-turn-exhausted → discord` (Owner Operator Run A, red-team P1-3) **REQUIRED BEFORE `OWNER_OPERATOR_ENABLED` GOES ON; NOT CONFIGURED BY THIS CHANGE** | …`. T6 REWRITES that cell to the BUILT form the rule-9 row models (`:410` — `**BUILT 2026-09-04, rule `3946648`**`); it does not add a twelfth row. The §1 checkbox for the same rule is `:325-350`.

**V8 (verified) — `OWNER_OPERATOR_ENABLED` rows already exist in both env inventories.** `.claude/reference/env-vars.md:661` and `docs/eservices-variables.md:215`. T6 AMENDS them for the staging flip; it does not add rows. The lab-notes JSONB allowlist already forward-declares the two new parse sites (`.claude/reference/lab-notes/postgres.md:17`, "their parse sites arrive with Apply in Run B and join this count then") and carries the count in its header (`:10`, "Exactly 23"); T6 turns the forward declaration into two live entries and moves the count to 25.

**V9 (verified) — `src/app/**` and `src/components/**` are NOT audited by `ci:directory-map`.** `pnpm ci:directory-map` passes today over 616 files under `worker/` and `src/lib/` only. **Consequence: the two NEW `src/lib/agents/operator/` files (`apply.ts`, `version-token.ts`) MUST get rows in `docs/directory/lib-owner-operator.md` (the table ends at `:23`) or the gate fails** — T6 owns those two rows and they are the only ones the gate can fail on. The route rows in `app-api-b.md`, the page rows in `app-authenticated.md` and the nav rows in `components.md` are documentation-only. `components.md` is touched only because T3 changes `Sidebar.tsx`/`MobileTabBar.tsx`/`active-nav.ts`, which have no rows there at all today.

**P3 — `appliedAt` has ONE source.** The module computes `const appliedAt = new Date().toISOString()` once and uses that same string for the Receipt's `appliedAt` field AND the `applied_at` column. A `NOW()` in the UPDATE plus an `.toISOString()` in the Receipt are two clocks that can disagree by the transaction's duration, and the Receipt is the owner-facing record of when it happened.

**P4 — `ProposalView` gains `turnId`.** The Receipt carries the verbatim `owner_text` of the turn that produced the Proposal and the turn id as correlation id (spec §6.5), so Apply must read the turn. `ProposalView` has no `turnId` today (`src/lib/agents/operator/proposals.ts:170-183`) while `listProposalsForTurns` already selects `turn_id` into a private `StoredRowWithTurn` (`:167`). T1 folds `turn_id` into `StoredRow`, adds `turnId` to `ProposalView` and deletes the now-redundant intersection type. The card also needs it (the Receipt shows the turn id).

**P5 — the pre-transaction contract check only rewrites a PENDING row.** Spec §6.4 puts the `contract_version` check before the transaction. Taken literally on a row that is already `applied`, that check would overwrite a terminal row's status with `rejected`. **Decision: pre-transaction, a contract mismatch writes `rejected`/`contract_changed` only when the loaded status is `pending`; any other status falls through into the transaction, whose status branch answers `not_pending`.** The property the spec wanted — "refused before any lock or read" for the case that matters — holds exactly.

**P6 — the Receipt's `before` is the STORED preview `before`, not a second read.** The mandated transaction ordering reads the voice config exactly ONCE, after the write. `differsFromPreview` is the flag that says the committed `after` is not the previewed `after` (spec §6.5's "if it does not … the receipt shows the actual state and flags the difference"); the `before` half is the state the card showed the owner when they clicked, which is the more useful record and costs no extra statement.

**P7 — `remainingBlocked` is `[]` for every Run B operation.** Readiness reasons gate autonomy expansions. All four registered proposables are `labelKind: 'fact'` voice changes (`src/lib/agents/operator/catalog.ts:139-172`) and nothing blocks them. The field exists in the Receipt shape now so slice 2's auto-approval operations do not change the Receipt contract version.

**P8 — a Proposal with a NULL `location_id` is refused `location_not_found`.** `scopeRule` is `'location'` on every proposable (`src/lib/agents/operator/catalog.ts:58`), so a voice Proposal always carries a location; a NULL one is a row no writer this run produces. Refusing it inside the transaction (before the lock, since there is nothing to lock) is a stated branch rather than a `!` assertion.

**P9 — tracer count.** Exactly the nine tracers T0–T8 below, matching the brief's "Tracers and edges" list. No extras.

---

## Modules and seams

| Module (file) | Interface (exports) | New or deepen | Precedent |
|---|---|---|---|
| `src/lib/agents/operator/version-token.ts` | `VoiceVersionToken`, `VoiceVersionTokenSchema`, `computeVoiceVersionToken`, `parseVersionToken` (JSONB parse site), `versionTokensEqual` | new (two callers: `apply.ts`, the apply route's body schema) | the parse-and-throw posture of `parseReplySegments` (`src/lib/agents/operator/schema.ts:229-242`) |
| `src/lib/agents/operator/apply.ts` | `applyProposal(sql, { proposalId, accountId, actorUserId, expectedVersionToken }): Promise<ApplyResult>`, `ApplyResult` | new, deep | `createTurn` (`src/lib/agents/operator/turns.ts:90-118`) — one call, result kinds the route maps |
| `src/lib/agents/operator/proposals.ts` | `ProposalView` += `turnId`, `preparedVersionToken`, `receipt`, `appliedAt`, `failureReason`; `readProposalForAccount`, `lockProposalForAccount`, `declineProposal`, `markSiblingProposalsStale` | deepen | `mapStored` (`:185-207`) stays the ONE row mapper |
| `src/lib/agents/operator/schema.ts` | `PROPOSAL_FAILURE_REASON`, `ProposalFailureReason`, `VoiceStateSchema`, `VoiceState`, `parseVoiceState`, `ReceiptSchema`, `Receipt`, `parseReceipt` (JSONB parse site) | deepen | the `.strict()` discipline at `:204-209` |
| `src/lib/agents/operator/catalog.ts` | `ProposableOperation.writerFields(input): Partial<VoiceConfig>` | deepen | `defineProposable`'s closure erasure (`:72-100`) |
| `src/lib/agents/operator/reads.ts` | `OwnerConversationTurn` += `locationId`; `OwnerConversationSummary` += `connectionStatus`; `getConversationForOwner` input += `locationId?` | deepen | the sequential-reads rule at `:234-252` |
| `src/app/api/operator/proposals/[id]/apply/route.ts` | `POST` | new composition root | `src/app/api/operator/turns/route.ts` (flag → same-origin → writable owner → impersonation), uuid-or-404 from `src/app/api/operator/turns/[id]/route.ts:31` |
| `src/app/api/operator/proposals/[id]/decline/route.ts` | `POST` | new composition root | same |
| `src/app/api/operator/conversation/route.ts` | `?locationId=` (uuid or 404 `location_not_found`) | deepen | its own `?id` handling at `:30-33` |
| `src/app/api/operator/turns/route.ts` | imports the shared `hasImpersonationCookie`; deletes its private copy | deepen (D8) | — |
| `src/app/api/settings/auto-approval/route.ts` | same | deepen (D8) | — |
| `src/lib/admin/impersonation/cookie.ts` | `hasImpersonationCookie(request: NextRequest): boolean` | deepen (D8) | it already owns `IMPERSONATION_COOKIE_NAME` (`:38`) |
| `src/lib/shared/protected-routes.ts` | `/api/operator` prefix inside `isProtectedOwnerApiRoute` | deepen (V2) | the `/api/settings` arm at `:52` |
| `src/app/(authenticated)/dashboard/operator/page.tsx` | server page: flag → `notFound()`; `<Suspense>` → `OperatorClient` | new | `src/app/(authenticated)/dashboard/requests/page.tsx:13-16` |
| `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx` | the conversation state machine: URL state, polling with back-off and timeout, composer, scope gate, panel + card slots | new | `RequestsClient.tsx`'s polling island |
| `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx` | one **Proposal** row → a Harbor card with Apply / Not now | new | — |
| `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx` | one **Receipt** → the applied card body | new | — |
| `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx` | one **Requested capability** row, no button | new | — |
| `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx` | the three summary blocks + the connect call to action | new | — |
| `src/app/(authenticated)/dashboard/operator/StarterActions.tsx` | the three fixed starter messages | new | — |
| `src/app/(authenticated)/dashboard/operator/wording.ts` | every owner-facing string: the seven `TURN_FAILURE_REASON` members, the proposal statuses, the route error codes, the fixed sentences | new (no `'use client'` — the server page imports the title) | `src/components/dashboard/shell/active-nav.ts:1-13` is the precedent for a client-safe shared module with no directive |
| `src/app/(authenticated)/dashboard/operator/operator.css` | screen-local Console styles | new | `dashboard/requests/requests.css` |
| `src/app/(authenticated)/layout.tsx` | `operatorEnabled` prop to both navs | deepen | `solicitationEnabled` at `:179`, `:194-200` |
| `src/components/dashboard/shell/active-nav.ts` | `'operator'` joins `NavSection`; `deriveNavSection('/dashboard/operator')` | deepen | `:14`, `:28-34` |
| `src/components/dashboard/shell/Sidebar.tsx` | `operatorEnabled` prop, gated nav row | deepen | the `solicitationEnabled` block at `:183-198` |
| `src/components/dashboard/shell/MobileTabBar.tsx` | `operatorEnabled` prop, gated tab | deepen | the `thirdSlot` pattern at `:69-71` |
| `e2e/operator.spec.ts` + `e2e/helpers/operator-seed.ts` | the unauthenticated redirect (CI) and the two harness-gated flows (local) | new | `e2e/owner-channels.spec.ts:26-31`, `e2e/harness.ts:31-32` |

**`Receipt` (zod `.strict()`):**

```
{
  version: 1,
  operation: string,
  scope: { accountId: uuid, locationId: uuid },
  before: VoiceState,
  after: VoiceState,
  differsFromPreview: boolean,
  effectiveNow: true,
  affects: 'future_drafts',
  remainingBlocked: string[],
  appliedAt: string,
  actorUserId: uuid,
  ownerText: string,
  turnId: uuid,
  versionToken: { before: VoiceVersionToken, after: VoiceVersionToken },
}
```

`VoiceState` is the five `VoiceConfig` fields (`src/lib/responses/voice-settings.ts:10-22`).

**`ApplyResult`** is `applied { proposal, repeated }` | `stale { proposal }` | `rejected { proposal, reason }` | `failed { proposal }` | `not_pending { proposal, status }` | `not_found`. Route map: `applied` → 200 `{ proposal }`; `stale` → 409 `proposal_stale`; `rejected` → 409 `<reason>`; `failed` → 500 `apply_failed`; `not_pending` → 409 `proposal_not_pending`; `not_found` → 404 `proposal_not_found`. **Every non-404 body carries `proposal`** so the card re-renders from the row rather than from the browser's guess about what the failure meant.

---

## Invariants pinned for this run

Verbatim from the intake `invariants`; every task step below is subordinate to them.

1. **#3** Nothing posts to Google and no `auto_approval_policies` row changes: Apply changes voice settings only, through `updateVoiceConfig`, and a conversation is never an approval token — only the recorded owner click on one Proposal id, revalidated inside the transaction, applies anything.
2. **#13/#14** `OWNER_OPERATOR_ENABLED` has no `NEXT_PUBLIC` companion; the screen learns the flag from the server page and from the 404 `operator_disabled` contract; auto-approval policy access stays server-owned.
3. **#15** Every module under `src/lib/agents/operator` receives `sql` or `tx` explicitly; only the routes and pages import the singleton.
4. **Authorization at every boundary:** POST apply and decline run `withSameOrigin`, `requireWritableOwner` and the impersonation rejection; Apply revalidates actor, subscription, offboarding, tier, ownership, status and the **Version token** inside `sql.begin` with the `businesses` row and the proposal row locked first (voice scope: `businesses FOR UPDATE`, then the proposal `FOR UPDATE`).
5. **Receipts are server-written in the same transaction as the mutation**; there is no committed mutation without a Receipt and no Receipt without a committed mutation; the client never supplies any Receipt field.
6. **The Version token is compared text to text** (`{ businessId, updatedAt }` with `updatedAt` from `updated_at::text`); current, prepared and expected must all be equal or the Proposal is `stale`.
7. **No review text, response text or reviewer name reaches the model:** Run B adds no model input; the Receipt and cards are owner-facing reads only.
8. **The model schema still has no field for a count, an approval, a confirmation or a Receipt** (`schema.test.ts` pins it; Run B does not touch `OperatorModelOutputSchema`).
9. **Every SQL statement over `agent_proposals` carries an `account_id` predicate** (`ci:tenant-scope`), and the two new routes answer 404 for another account's Proposal exactly as GET turn does.
10. **The Apply executor writes only the operation's own fields** through the shared voice writer; sibling pending Proposals on the same location are marked stale in the same transaction, so approved intent is never rewritten silently.
11. **Structured logs and Sentry events carry ids only** — never owner text, a Receipt, a segment or a Proposal body.

Additionally binding, from `.claude/CLAUDE.md`:

12. **#1** The two new routes orchestrate only — parse, one module call, map the result — and never import the LLM seam, the cost guard or the worker queue registry.
13. **JSONB parse sites** live only in `schema.ts` (`parseReceipt`) and `version-token.ts` (`parseVersionToken`), each with the `typeof x === 'string' ? JSON.parse(x) : x` guard, each narrowing with zod and throwing on a shape no writer produces. Both are added to the lab-notes allowlist in T6.
14. **`ci:pool-fanout`** forbids a `Promise` combinator over ≥2 DB-issuing elements in `src/lib/{admin,dashboard,locations}`. The operator modules already sequence their reads (`src/lib/agents/operator/reads.ts:85-87`, `:234-252`) — keep it that way; every new read in this run is awaited in sequence.
15. **`postgres.js` decodes `timestamptz` to a JS `Date`, truncating microseconds.** The **Version token** never crosses that boundary: `updated_at::text` end to end, compared as text.

---

## Tasks

Tracer ids and titles are fixed. **Test titles are verbatim from the intake `tests_to_add` and must appear character-for-character in the code.** Every `Run:` line assumes the worktree root `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b`.

### Task T0: Eval scaffold — every promised test title exists

Runs ALONE, before every other tracer. It authors all 51 promised titles, each verbatim, and nothing else — **no production file is created or modified in T0.** (Forty came from the original intake; ten were added by the round-1 review and one by round 3, all listed in the Review appendix.)

**Every vitest title lands as `it.todo(title)` and no T0 file imports a module this run has not written yet.** The reason is mechanical: an unresolved import fails vitest at COLLECTION, which takes the whole file down and reports zero titles — so a scaffold that "fails red" that way proves nothing about the title it was meant to register, while the Step 7 grep still finds the string in the file. Each owning tracer converts its own todos into real tests in its first step, and that conversion is where the RED/GREEN cycle happens. The two Playwright titles land as `test.fixme`, because `e2e/*.spec.ts` is not matched by vitest's include glob (`vitest.config.ts:35-45`) and Playwright has no `todo`.

| Titles | Converted by | In |
|---|---|---|
| 1, 2, 20 | T1 | `version-token.test.ts` |
| 3, 5–12, 19 | T1 | `apply.test.ts` (mocked `sql`) |
| 4, 13–16, R1, R10 | T1 | `apply.integration.test.ts` (live DB) |
| 29 | T1 | `proposals.test.ts` |
| 17, 18 | T2 | `proposals.test.ts` |
| 21 | T2 | `protected-routes.test.ts` |
| 22–25 | T2 | `apply-route.test.ts` |
| 26, 27 | T2 | `decline-route.test.ts` |
| 28 | T2 | `conversation-route.test.ts` |
| R9 | T2 | `reads.integration.test.ts` (live DB) |
| 30–34, R2, R5, R6, R7, R8, R11 | T3 | `dashboard/operator/__tests__/page.test.tsx`, `OperatorClient.test.tsx` |
| 35–37, R4 | T4 | `dashboard/operator/__tests__/ProposalCard.test.tsx` |
| R3 | T4 | `dashboard/operator/__tests__/OperatorClient.test.tsx` |
| 38 | T5 | `dashboard/operator/__tests__/SummaryPanel.test.tsx` |
| 39, 40 | T7 | `e2e/operator.spec.ts` |

R1–R10 are the round-1 additions and R11 the round-3 addition, all named in full in the Review appendix.

**Files:**
- Create: `src/lib/agents/operator/__tests__/version-token.test.ts`
- Create: `src/lib/agents/operator/__tests__/apply.test.ts`
- Create: `src/lib/agents/operator/__tests__/apply.integration.test.ts`
- Create: `src/app/api/operator/__tests__/apply-route.test.ts`
- Create: `src/app/api/operator/__tests__/decline-route.test.ts`
- Create: `src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx`
- Create: `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx`
- Create: `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx`
- Create: `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx`
- Create: `e2e/operator.spec.ts`
- Modify: `src/lib/agents/operator/__tests__/proposals.test.ts`
- Modify: `src/lib/agents/operator/__tests__/reads.integration.test.ts`
- Modify: `src/lib/shared/__tests__/protected-routes.test.ts`
- Modify: `src/app/api/operator/__tests__/conversation-route.test.ts`

**Blocking edges:** none. **Lease:** every file above; no other tracer may start until T0 commits.

- [ ] **Step 1: Create the version-token and apply scaffolds**

Create `src/lib/agents/operator/__tests__/version-token.test.ts`:

```ts
// Unit seams for src/lib/agents/operator/version-token.ts — the **Version
// token**'s type, its JSONB parse site and its equality. T1 converts these.
//
// Titles 1, 2 and 20 (the fast-check property) all live here because they are
// one subject: what "the same token" means. The microsecond case is the whole
// reason the token is text end-to-end (CLAUDE.md's timestamptz gotcha).
import { describe, it } from 'vitest';

describe('voice version token', () => {
  it.todo('version token equality is text-to-text on both fields and a one-microsecond difference is not equal');
  it.todo('version token parser rejects a stored token missing businessId or updatedAt');
});

describe('voice version token invariants', () => {
  it.todo('invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text');
});
```

Create `src/lib/agents/operator/__tests__/apply.test.ts`:

```ts
// Unit seams for src/lib/agents/operator/apply.ts, against the recording
// mock-sql double (worker/__tests__/helpers/mock-sql.ts). These prove
// ORDERING, BRANCHING and WHAT IS BOUND — the things a mock can prove.
//
// Deliberately NOT here: the rollback, the row lock, the sibling sweep and the
// read-back, which are live-DB properties and live in
// apply.integration.test.ts. A mock that "proves" a rollback proves only that
// the double was told to say so.
import { describe, it } from 'vitest';

describe('applyProposal', () => {
  it.todo("applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig");
  it.todo('applyProposal on an applied proposal returns the stored receipt and executes nothing');
  it.todo('applyProposal marks the proposal stale without mutation when the current token differs from the prepared token');
  it.todo("applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token");
  it.todo("applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock");
  it.todo('applyProposal returns proposal_not_found for a proposal of another account');
  it.todo('applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal');
  it.todo('applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner');
  it.todo('applyProposal rejects the proposal location_not_found when the location was archived after preparation');
});

describe('applyProposal invariants', () => {
  it.todo('invariants: from any non-pending status applyProposal never writes businesses');
});
```

Create `src/lib/agents/operator/__tests__/apply.integration.test.ts`:

```ts
// Live-DB proofs for src/lib/agents/operator/apply.ts.
//
// Nothing is mocked. The five cases here are the ones a double cannot answer:
// that the Receipt and the voice write share ONE transaction; that the sibling
// sweep touches this location and no other; that the Receipt's `after` is the
// committed state; that a throwing executor leaves nothing behind; and that two
// concurrent Applies serialize on the `businesses` row lock.
//
// Named *.integration.test.ts so vitest's serialized `integration` project
// picks it up, and it executes NO DDL at run time — the schema is ASSERTED with
// assertSchemaReady(MIGRATION_120_OWNER_OPERATOR) (.claude/rules/live-db-tests.md).
import { describe, it } from 'vitest';

describe('applyProposal (live DB)', () => {
  it.todo('applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write');
  it.todo('applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone');
  it.todo('applyProposal receipt after equals the committed voice state and flags a difference from the stored after');
  it.todo('applyProposal rolls back the receipt when the voice write throws');
  it.todo('two concurrent applies on one proposal produce one voice write and both return the same receipt');
  // Round-1 additions (RB-01, RB-10).
  it.todo('worker-produced proposals render and apply successfully');
  it.todo('repeat Apply after location archival returns the original receipt without writes');
});
```

Append to `src/lib/agents/operator/__tests__/reads.integration.test.ts` (round-1 addition RB-09), inside its existing `describeWithDb` block:

```ts
    it.todo('first-time owner receives a scoped summary and connection CTA before sending');
```

- [ ] **Step 2: Create the route scaffolds**

Create `src/app/api/operator/__tests__/apply-route.test.ts`:

```ts
// Orchestration seams for POST /api/operator/proposals/:id/apply. T2 converts
// these against a mocked `applyProposal`, exactly as turns-route.test.ts mocks
// `createTurn` — the module's own behaviour is T1's subject, not the route's.
import { describe, it } from 'vitest';

describe('POST /api/operator/proposals/[id]/apply', () => {
  it.todo('POST apply returns 404 operator_disabled before auth when the flag is off');
  it.todo('POST apply rejects a missing or mismatched Origin before any read');
  it.todo('POST apply rejects an impersonated session with 409 impersonation_not_allowed');
  it.todo('POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409');
});
```

Create `src/app/api/operator/__tests__/decline-route.test.ts`:

```ts
// Orchestration seams for POST /api/operator/proposals/:id/decline. Same shim
// as the apply route's suite; `declineProposal` is mocked.
import { describe, it } from 'vitest';

describe('POST /api/operator/proposals/[id]/decline', () => {
  it.todo('POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin');
  it.todo("POST decline returns 200 with the rejected proposal and 404 for another account's proposal");
});
```

- [ ] **Step 3: Create the screen scaffolds**

Create `src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx`:

```tsx
// @vitest-environment jsdom
// The Operator screen's flag gate, both halves in one title: the server page
// throws Next's not-found when OWNER_OPERATOR_ENABLED is off, and neither nav
// renders an entry when the server-authoritative prop is false. They are one
// fact — "with the flag off the surface does not exist" — so they are asserted
// together rather than in two files that can drift.
import { describe, it } from 'vitest';

describe('operator page and nav flag gate', () => {
  it.todo('operator page calls notFound when the flag is off and the nav omits the entry');
});
```

Create `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx`:

```tsx
// @vitest-environment jsdom
// The conversation state machine, against a mocked fetch and vitest's fake
// timers. Four titles, four behaviours the owner actually experiences: the
// post-and-poll round trip with URL resumption, the back-off and timeout, the
// per-reason failure wording plus the disabled stop, and the All-locations gate.
import { describe, it } from 'vitest';

describe('OperatorClient', () => {
  it.todo('operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload');
  it.todo('operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes');
  it.todo('operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled');
  it.todo('operator screen disables the composer under All locations and enables it once a location is chosen');
  // Round-1 additions (RB-02, RB-05, RB-06, RB-07, RB-08).
  it.todo('operator times out while a poll request remains unresolved');
  it.todo('retry after a lost POST response resumes the original turn');
  it.todo('operator renders every stored segment kind in order');
  it.todo('terminal failures and requested capabilities survive reload and subsequent turns');
  it.todo('loaded conversations retain identity and starting over stays empty');
  // Round-3 addition (RB3-01).
  it.todo('a delayed conversation response never replaces a newly submitted turn');
  // Round-1 addition RB-03, converted by T4 (it wires Refresh plan).
  it.todo('Refresh plan preserves the original instruction and location after scope changes');
});
```

Create `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx`:

```tsx
// @vitest-environment jsdom
// The card contracts (spec §3.3). Every assertion reads from a stored-row
// fixture, never from prose, and never from the browser's location selector.
import { describe, it } from 'vitest';

describe('ProposalCard', () => {
  it.todo('proposal card renders the target from the stored location and shows Prepared for the location when the selector moved');
  it.todo('proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch');
  // Round-1 addition (RB-04).
  it.todo('proposal previews expose exact fact replacements before approval');
});

describe('RequestedCapabilityCard', () => {
  it.todo('requested capability card has no Apply button');
});
```

Create `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
// The summary panel's three blocks and the connect call to action.
import { describe, it } from 'vitest';

describe('SummaryPanel', () => {
  it.todo('summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing');
});
```

- [ ] **Step 4: Create the Playwright scaffold**

Create `e2e/operator.spec.ts`:

```ts
// e2e/operator.spec.ts
//
// The Operator screen end to end. Three lanes, on purpose:
//
//  1. The unauthenticated redirect runs EVERYWHERE, CI included — it needs no
//     database and no Supabase Auth.
//  2. The signed-in flows are gated on `isAuthHarnessConfigured` (e2e/harness.ts),
//     which is false in CI because the staging Supabase secrets never reach a
//     CI runner. They self-skip there and run locally.
//  3. The worker is STOOD IN FOR by SQL: e2e/helpers/operator-seed.ts completes
//     a seeded turn with a `proposal` segment and a pending set_tone Proposal,
//     so the browser flow does not depend on a running Railway worker or on a
//     provider key.
//
// T7 converts the two fixmes below. They are `test.fixme`, not `it.todo`:
// Playwright has no todo, and this file is not matched by vitest's include glob.
import { test } from '@playwright/test';

test.describe('Operator screen — unauthenticated', () => {
  test('unauthenticated /dashboard/operator redirects to the owner login', async ({ page }) => {
    await page.goto('/dashboard/operator');
    await page.waitForURL(/\/login\?from=/, { timeout: 10_000 });
  });
});

test.describe('Operator screen — authenticated', () => {
  test.fixme('e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440', async () => {
    // T7 writes this body.
  });

  test.fixme('e2e: a settings write between proposal and Apply produces a stale card with Refresh plan', async () => {
    // T7 writes this body.
  });
});
```

- [ ] **Step 5: Append the todos to the three existing suites**

In `src/lib/agents/operator/__tests__/proposals.test.ts`, append at the end of the file:

```ts
describe('declineProposal', () => {
  it.todo('declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent');
  it.todo('declineProposal answers proposal_not_pending for an applied proposal');
});

describe('proposal view', () => {
  it.todo('proposal view carries receipt, prepared version token, applied_at and failure_reason');
});
```

In `src/lib/shared/__tests__/protected-routes.test.ts`, append inside the existing `describe('protected API route roles', …)` block (it ends after the case at `src/lib/shared/__tests__/protected-routes.test.ts:162`):

```ts
  it.todo('isProtectedOwnerApiRoute returns true for /api/operator, /api/operator/turns, /api/operator/conversation and both proposal routes');
```

In `src/app/api/operator/__tests__/conversation-route.test.ts`, append at the end of the file:

```ts
describe('GET /api/operator/conversation — location scoping', () => {
  it.todo('GET conversation scopes the summary to ?locationId= when the conversation has no turns');
});
```

If the file does not already import `describe`, add it to the existing `vitest` import rather than writing a second import statement.

- [ ] **Step 6: RUN every scaffold file and check its output, one file at a time**

A whole-glob run reports one summary line, and a file that fails COLLECTION reports zero titles while the Step 7 grep still finds the strings in it — which is how a broken suite reaches T7 wearing a green scaffold. So each file is executed on its own and its expected output is written down:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
for f in \
  src/lib/agents/operator/__tests__/version-token.test.ts \
  src/lib/agents/operator/__tests__/apply.test.ts \
  src/lib/agents/operator/__tests__/proposals.test.ts \
  src/lib/shared/__tests__/protected-routes.test.ts \
  src/app/api/operator/__tests__/apply-route.test.ts \
  src/app/api/operator/__tests__/decline-route.test.ts \
  src/app/api/operator/__tests__/conversation-route.test.ts \
  "src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx" \
  "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx" \
  "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx" \
  "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx" \
; do echo "── $f"; pnpm exec vitest run "$f" 2>&1 | tail -5; done
```

| File | Expected |
|---|---|
| `version-token.test.ts` | `3 todo` — no tests, no failures |
| `apply.test.ts` | `10 todo` |
| `proposals.test.ts` | the existing `insertProposals` cases PASS + `3 todo` |
| `protected-routes.test.ts` | the whole existing suite PASSES + `1 todo` |
| `apply-route.test.ts` | `4 todo` |
| `decline-route.test.ts` | `2 todo` |
| `conversation-route.test.ts` | the existing cases PASS + `1 todo` |
| `page.test.tsx` | `1 todo` |
| `OperatorClient.test.tsx` | `11 todo` |
| `ProposalCard.test.tsx` | `4 todo` |
| `SummaryPanel.test.tsx` | `1 todo` |

And the two live-DB files, in the serialized project:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
pnpm exec vitest run --project integration \
  src/lib/agents/operator/__tests__/apply.integration.test.ts \
  src/lib/agents/operator/__tests__/reads.integration.test.ts 2>&1 | tail -8
```

Expected: `apply.integration.test.ts` reports `7 todo`; `reads.integration.test.ts` reports its existing cases PASS (or SKIP, without `TEST_DATABASE_POOL_URL`) plus `1 todo`.

**Zero failures and ZERO collection errors anywhere.** A collection error means a scaffold file imported something this run has not written yet, which is the one thing Step 1's rule forbids — and catching it here rather than at T7 is the entire reason this step executes instead of grepping.

Finally the Playwright file, which vitest does not match:

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec playwright test e2e/operator.spec.ts --list`
Expected: three tests listed — the unauthenticated redirect plus the two `fixme` flows.

- [ ] **Step 7: Spot-check every promised title, verbatim**

Run:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
node -e '
const fs = require("fs");
const titles = JSON.parse(fs.readFileSync("docs/superpowers/plans/feat-owner-operator-run-b-intake.json", "utf8")).tests_to_add;
const files = [
  "src/lib/agents/operator/__tests__/version-token.test.ts",
  "src/lib/agents/operator/__tests__/apply.test.ts",
  "src/lib/agents/operator/__tests__/apply.integration.test.ts",
  "src/lib/agents/operator/__tests__/proposals.test.ts",
  "src/lib/agents/operator/__tests__/reads.integration.test.ts",
  "src/lib/shared/__tests__/protected-routes.test.ts",
  "src/app/api/operator/__tests__/apply-route.test.ts",
  "src/app/api/operator/__tests__/decline-route.test.ts",
  "src/app/api/operator/__tests__/conversation-route.test.ts",
  "src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx",
  "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx",
  "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx",
  "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx",
  "e2e/operator.spec.ts",
];
const haystack = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const missing = titles.filter((t) => !haystack.includes(t));
console.log(missing.length === 0 ? "all " + titles.length + " titles present" : "MISSING:\n" + missing.join("\n"));
'
```

Expected: `all 51 titles present`. The script reads the titles from the intake, which the root amended with the ten round-1 additions and the round-3 one — so a title added to the intake and forgotten here fails HERE, not in T7.

- [ ] **Step 8: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add src/lib/agents/operator/__tests__/version-token.test.ts \
        src/lib/agents/operator/__tests__/apply.test.ts \
        src/lib/agents/operator/__tests__/apply.integration.test.ts \
        src/lib/agents/operator/__tests__/proposals.test.ts \
        src/lib/agents/operator/__tests__/reads.integration.test.ts \
        src/lib/shared/__tests__/protected-routes.test.ts \
        src/app/api/operator/__tests__/apply-route.test.ts \
        src/app/api/operator/__tests__/decline-route.test.ts \
        src/app/api/operator/__tests__/conversation-route.test.ts \
        "src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx" \
        "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx" \
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx" \
        "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx" \
        e2e/operator.spec.ts
git commit -m "test(operator): Run B eval scaffold — all 40 promised test titles exist"
```

---

### Task T1: The Version token, `applyProposal`, the Receipt, `writerFields` and the `ProposalView` extension

Runs ALONE after T0. It is the only tracer that touches `apply.ts`, `version-token.ts`, `schema.ts`, `catalog.ts` and the `ProposalView`/reader half of `proposals.ts`; T2 appends `declineProposal` to the same file afterwards, so the two are strictly sequential.

**Blocking edges:** T0. **Lease:** `src/lib/agents/operator/{apply,version-token,schema,catalog,proposals}.ts` and `src/lib/agents/operator/__tests__/{version-token,apply,apply.integration,proposals}.test.ts`.

**Turns green (verbatim):**
1. `version token equality is text-to-text on both fields and a one-microsecond difference is not equal`
2. `version token parser rejects a stored token missing businessId or updatedAt`
3. `applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig`
4. `applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write`
5. `applyProposal on an applied proposal returns the stored receipt and executes nothing`
6. `applyProposal marks the proposal stale without mutation when the current token differs from the prepared token`
7. `applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token`
8. `applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock`
9. `applyProposal returns proposal_not_found for a proposal of another account`
10. `applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal`
11. `applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner`
12. `applyProposal rejects the proposal location_not_found when the location was archived after preparation`
13. `applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone`
14. `applyProposal receipt after equals the committed voice state and flags a difference from the stored after`
15. `applyProposal rolls back the receipt when the voice write throws`
16. `two concurrent applies on one proposal produce one voice write and both return the same receipt`
19. `invariants: from any non-pending status applyProposal never writes businesses`
20. `invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text`
29. `proposal view carries receipt, prepared version token, applied_at and failure_reason`
R1. `worker-produced proposals render and apply successfully`
R10. `repeat Apply after location archival returns the original receipt without writes`

**Files:**
- Create: `src/lib/agents/operator/version-token.ts`
- Create: `src/lib/agents/operator/apply.ts`
- Modify: `src/lib/agents/operator/schema.ts:52-62` (after `TURN_FAILURE_REASON`) and `:243` (end of file)
- Modify: `src/lib/agents/operator/catalog.ts:53-100` (`ProposableOperation` + `defineProposable`) and `:139-172` (the four proposables)
- Modify: `src/lib/agents/operator/proposals.ts:161-183` (`StoredRow`, `StoredRowWithTurn`, `ProposalView`), `:185-207` (`mapStored`), `:209-269` (the three list readers), `:313` (end of file)
- Test: `src/lib/agents/operator/__tests__/version-token.test.ts` (titles 1, 2, 20)
- Test: `src/lib/agents/operator/__tests__/apply.test.ts` (titles 3, 5–12, 19)
- Test: `src/lib/agents/operator/__tests__/apply.integration.test.ts` (titles 4, 13–16)
- Test: `src/lib/agents/operator/__tests__/proposals.test.ts` (title 29)

**Precedent paths:** `src/lib/responses/voice-settings.ts:79-156` (the writer and its `updated_at::text` discipline) · `src/lib/agents/operator/turns.ts:90-118` (a module that owns a transaction and returns result kinds) · `src/lib/agents/operator/schema.ts:229-242` (the parse-and-throw posture) · `worker/__tests__/helpers/mock-sql.ts:106-170` (the recording double) · `src/lib/agents/operator/__tests__/reads.integration.test.ts:171-236` (the live-DB fixture) · `src/lib/shared/__tests__/helpers/abort-injection.ts:51-86` (the sanctioned rollback injection) · `src/lib/reviews/__tests__/sentiment.test.ts:45-56` (the fast-check "invariants" block).

**Completion evidence:** `pnpm exec vitest run src/lib/agents/operator` green with all 19 titles reported as passing (not todo); `pnpm ci:tenant-scope`, `pnpm ci:db-imports`, `pnpm ci:pool-fanout` and `pnpm typecheck` green.

- [ ] **Step 1: Convert the version-token todos into failing tests (titles 1, 2, 20)**

Replace `src/lib/agents/operator/__tests__/version-token.test.ts` with:

```ts
// Unit seams for src/lib/agents/operator/version-token.ts — the **Version
// token**'s type, its JSONB parse site and its equality.
//
// The microsecond case is the whole reason the token is text end-to-end:
// postgres.js decodes `timestamptz` into a JS `Date`, which holds milliseconds
// and silently truncates the microseconds Postgres stores (CLAUDE.md's
// timestamptz gotcha). A token built from a round-tripped Date compares EQUAL
// to a row written up to a microsecond later — a stale proposal reading as
// fresh, which is exactly the check the token exists to make.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseVersionToken,
  versionTokensEqual,
  type VoiceVersionToken,
} from '../version-token';

const BUSINESS = '33333333-3333-4333-8333-333333333333';
const OTHER_BUSINESS = '44444444-4444-4444-8444-444444444444';

describe('voice version token', () => {
  it('version token equality is text-to-text on both fields and a one-microsecond difference is not equal', () => {
    const base: VoiceVersionToken = {
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123456+00',
    };

    expect(versionTokensEqual(base, { ...base })).toBe(true);

    // One MICROSECOND later. A JS Date round trip flattens both of these to
    // 10:00:00.123 and would call them equal.
    const oneMicrosecondLater: VoiceVersionToken = {
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123457+00',
    };
    expect(versionTokensEqual(base, oneMicrosecondLater)).toBe(false);
    expect(new Date(base.updatedAt).getTime()).toBe(
      new Date(oneMicrosecondLater.updatedAt).getTime(),
    );

    // The businessId half is compared too: the same instant on another row is
    // not the same token.
    expect(versionTokensEqual(base, { ...base, businessId: OTHER_BUSINESS })).toBe(false);

    // No normalization, deliberately: an ISO spelling of the same instant is a
    // DIFFERENT string and therefore a different token. The writer and the
    // reader both return `updated_at::text`, so they always agree; anything
    // that reformats has left the contract.
    expect(
      versionTokensEqual(base, { businessId: BUSINESS, updatedAt: '2026-09-12T10:00:00.123456Z' }),
    ).toBe(false);
  });

  it('version token parser rejects a stored token missing businessId or updatedAt', () => {
    expect(() => parseVersionToken({ updatedAt: '2026-09-12 10:00:00.123456+00' }))
      .toThrow(/prepared_version_token/);
    expect(() => parseVersionToken({ businessId: BUSINESS })).toThrow(/prepared_version_token/);
    expect(() => parseVersionToken(null)).toThrow(/prepared_version_token/);
    expect(() => parseVersionToken({ businessId: 'not-a-uuid', updatedAt: 'x' }))
      .toThrow(/prepared_version_token/);
    // An extra key is a shape no writer produces — `.strict()` rejects it
    // rather than dropping it silently.
    expect(() => parseVersionToken({
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123456+00',
      locationRow: 'absent',
    })).toThrow(/prepared_version_token/);

    // The PgBouncer string form is the one shape that must succeed: the column
    // is JSONB and Postgres.js behind PgBouncer can hand it back as text.
    const stored = { businessId: BUSINESS, updatedAt: '2026-09-12 10:00:00.123456+00' };
    expect(parseVersionToken(JSON.stringify(stored))).toEqual(stored);
    expect(parseVersionToken(stored)).toEqual(stored);
  });
});

describe('voice version token invariants', () => {
  const token = fc.record({
    businessId: fc.constantFrom(BUSINESS, OTHER_BUSINESS),
    updatedAt: fc.string({ minLength: 1, maxLength: 40 }),
  });

  it('invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text', () => {
    fc.assert(
      fc.property(token, token, (a, b) => {
        const expected = a.businessId === b.businessId && a.updatedAt === b.updatedAt;
        expect(versionTokensEqual(a, b)).toBe(expected);
        // Symmetric, and reflexive on a fresh copy.
        expect(versionTokensEqual(b, a)).toBe(expected);
        expect(versionTokensEqual(a, { ...a })).toBe(true);
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/version-token.test.ts`
Expected: FAIL at collection — `Failed to resolve import "../version-token"`.

- [ ] **Step 3: Write `version-token.ts`**

Create `src/lib/agents/operator/version-token.ts`:

```ts
// The voice-scope **Version token**: one owner for its shape, its JSONB parse
// site and its equality.
//
// Two callers — `apply.ts` (the stored token and the locked row's token) and
// the apply route's body schema (the client's `expectedVersionToken`). Before
// this module the rule lived in a comment on the voice writer and in the
// literal `{ businessId, updatedAt }` object `buildProposalRows` writes; a
// third spelling in Apply is how the three drift.
//
// TEXT END TO END, and that is the entire design. `readVoiceConfig` and
// `updateVoiceConfig` both return `updated_at::text` verbatim
// (src/lib/responses/voice-settings.ts:85, :152) because postgres.js decodes
// `timestamptz` into a JS `Date`, which holds milliseconds and silently
// truncates the MICROSECONDS Postgres stores (CLAUDE.md's timestamptz gotcha).
// A token built from a round-tripped Date compares EQUAL to a row that was
// written up to a microsecond later — a stale proposal that reads as fresh,
// which is precisely the check this token exists to make. So nothing here
// parses, normalizes or reformats the timestamp: it is an opaque string that
// is compared with `===`.
import { z } from 'zod';

/** The voice scope's freshness stamp, as stored on `prepared_version_token`. */
export interface VoiceVersionToken {
  businessId: string;
  /** `businesses.updated_at::text`, VERBATIM. Never an ISO string, never a Date. */
  updatedAt: string;
}

/**
 * `.strict()`: an unknown key means the row carries an auto-approval-scope
 * token (spec §6.2 gives those a different shape), or something no writer
 * produces. Either way Apply must refuse rather than compare two of the three
 * fields and call it a match.
 */
export const VoiceVersionTokenSchema = z.object({
  businessId: z.uuid(),
  updatedAt: z.string().min(1),
}).strict();

/** The token for a location whose `updated_at::text` has just been read. */
export function computeVoiceVersionToken(input: {
  businessId: string;
  updatedAt: string;
}): VoiceVersionToken {
  return { businessId: input.businessId, updatedAt: input.updatedAt };
}

/**
 * `agent_proposals.prepared_version_token` → a token. A PgBouncer JSONB parse
 * site (lab-notes/postgres.md allowlist): guard `typeof x === 'string'`, narrow
 * with zod, throw on a shape no writer produces — never widen to `any`.
 */
export function parseVersionToken(value: unknown): VoiceVersionToken {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const validated = VoiceVersionTokenSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      'agents/operator: agent_proposals.prepared_version_token holds a shape no writer produces',
    );
  }
  return validated.data;
}

/**
 * Equality, TEXT TO TEXT on both fields. No `Date` anywhere in this function,
 * and no normalization: two spellings of one instant are two different tokens,
 * because the only producers both emit `updated_at::text`.
 */
export function versionTokensEqual(a: VoiceVersionToken, b: VoiceVersionToken): boolean {
  return a.businessId === b.businessId && a.updatedAt === b.updatedAt;
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/version-token.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the Receipt vocabulary to `schema.ts`**

In `src/lib/agents/operator/schema.ts`, add after `TURN_FAILURE_REASON`'s type alias (`src/lib/agents/operator/schema.ts:62`):

```ts
/**
 * Every reason a **Proposal** can carry in `failure_reason`. Six members, and
 * the split between them is the whole lifecycle (spec §6.3):
 *
 *  - `version_mismatch` → `stale`. The settings moved. Offer **Refresh plan**.
 *  - `contract_changed` → `rejected`. The CODE moved, not the settings; the
 *    plan must be regenerated, not retried.
 *  - `unauthorized` / `account_offboarding` → `rejected`. The actor lost the
 *    right between preparation and the click.
 *  - `location_not_found` → `rejected`. The location was archived.
 *  - `write_failed` → `failed`. The executor DETERMINISTICALLY refused. A
 *    THROWN executor is not this: the transaction rolls back and the row stays
 *    `pending` (plan decision D12).
 *
 * An owner decline stores NO reason — `decided_by_user_id` alone says who, and
 * a reason column filled with `owner_declined` would make "the owner said no"
 * look like a failure in every read that counts non-NULL reasons (D5).
 */
export const PROPOSAL_FAILURE_REASON = {
  VERSION_MISMATCH: 'version_mismatch',
  CONTRACT_CHANGED: 'contract_changed',
  UNAUTHORIZED: 'unauthorized',
  ACCOUNT_OFFBOARDING: 'account_offboarding',
  LOCATION_NOT_FOUND: 'location_not_found',
  WRITE_FAILED: 'write_failed',
} as const;
export type ProposalFailureReason =
  (typeof PROPOSAL_FAILURE_REASON)[keyof typeof PROPOSAL_FAILURE_REASON];
```

And add at the END of `src/lib/agents/operator/schema.ts` (after `parseReplySegments`, which closes at `:243`):

```ts
// ── The Receipt ───────────────────────────────────────────────────────────
//
// Server-written, in the SAME transaction as the mutation. The client supplies
// no field of it. `.strict()` for the same reason the model schema is strict:
// a Receipt is the owner's record that something changed, and an unknown key
// in it is a writer this codebase does not have.

/**
 * The five `VoiceConfig` fields, as a value rather than an interface, so the
 * Receipt's `before`/`after` can be VALIDATED and not merely asserted. It
 * mirrors `VoiceConfig` (src/lib/responses/voice-settings.ts:10-22) field for
 * field. This is the shape the **Receipt** CARRIES.
 */
export const VoiceStateSchema = z.object({
  tone: z.string().nullable(),
  productsServices: z.string().nullable(),
  avoidFacts: z.array(z.string()),
  highlightFacts: z.array(z.string()),
  sampleResponses: z.array(z.string()),
}).strict();
export type VoiceState = z.infer<typeof VoiceStateSchema>;

/**
 * What Run A actually STORED in `agent_proposals.before` / `.after` — the five
 * fields PLUS `updatedAt`, and that extra key is not an accident to be
 * tightened away.
 *
 * `AgentTurnWorker` reads the voice config with `readVoiceConfig`
 * (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`), whose return type is
 * `VoiceConfig & { updatedAt: string }`; `defineProposable`'s `preview` returns
 * that object as `before` and spreads it into `after`
 * (`src/lib/agents/operator/catalog.ts:96-98`); and `buildProposalRows` stores
 * both with `{ ...before }` / `{ ...after }`
 * (`src/lib/agents/operator/proposals.ts:77-78`). **Every Proposal Run A has
 * ever written therefore carries SIX keys.** A five-field `.strict()` parse
 * would reject all of them — crashing the card and rolling back Apply on real
 * data while every hand-typed fixture passed.
 *
 * So the parser ACCEPTS `updatedAt` and DROPS it: the `updatedAt` inside a
 * preview is the **Version token**'s own value at preparation time, which the
 * Receipt already records under `versionToken.before`. Carrying it a second
 * time inside `before`/`after` would put two copies of one fact in one
 * document. Any OTHER unknown key is still a hard rejection.
 */
const StoredVoiceStateSchema = VoiceStateSchema.extend({
  updatedAt: z.string().optional(),
}).strict();

/**
 * `agent_proposals.before` / `.after` → a `VoiceState`.
 *
 * NOT a JSONB parse site: `mapStored` already ran `parseJsonbObject` over the
 * column, so this narrows an in-memory object. It throws rather than defaulting
 * because a Proposal whose stored preview cannot be read is one whose Receipt
 * would be a guess.
 */
export function parseVoiceState(value: unknown, column: string): VoiceState {
  const validated = StoredVoiceStateSchema.safeParse(value);
  if (!validated.success) {
    throw new Error(`agents/operator: ${column} holds a voice state no writer produces`);
  }
  // Drop the stored `updatedAt`; the Receipt records it once, under
  // `versionToken`, and nowhere else.
  const { updatedAt: _preparedAt, ...state } = validated.data;
  return state;
}

export const ReceiptSchema = z.object({
  /** Bumped only when a stored Receipt's SHAPE changes. Run B writes 1. */
  version: z.literal(1),
  operation: z.string().min(1),
  scope: z.object({ accountId: z.uuid(), locationId: z.uuid() }).strict(),
  /** The state the card SHOWED the owner when they clicked (plan decision P6). */
  before: VoiceStateSchema,
  /** The state that actually committed, read back under the lock. */
  after: VoiceStateSchema,
  /**
   * True when the committed `after` is not the previewed `after` — a seeded
   * column or a concurrent trigger. The Apply still succeeds (spec §6.5); this
   * flag is how the card says the result is not what was previewed.
   */
  differsFromPreview: z.boolean(),
  /** Voice changes take effect at once. A literal, not a boolean: no Run B operation is scheduled. */
  effectiveNow: z.literal(true),
  /** Spec §8.4, the tone/facts row: future drafts only. */
  affects: z.literal('future_drafts'),
  /** Readiness reasons still blocking something. Always `[]` for voice (P7). */
  remainingBlocked: z.array(z.string()),
  appliedAt: z.string().min(1),
  actorUserId: z.uuid(),
  /** The VERBATIM `owner_text` of the turn that produced the Proposal (§6.5). */
  ownerText: z.string(),
  /** The turn id, as the correlation id (§6.5). */
  turnId: z.uuid(),
  versionToken: z.object({
    before: VoiceVersionTokenSchema,
    after: VoiceVersionTokenSchema,
  }).strict(),
}).strict();
export type Receipt = z.infer<typeof ReceiptSchema>;

/**
 * `agent_proposals.receipt` → a **Receipt**. A PgBouncer JSONB parse site
 * (lab-notes/postgres.md allowlist): guard `typeof x === 'string'`, narrow,
 * throw. `null` is a legitimate value — every Proposal that has not been
 * applied has one — and returns `null` rather than throwing.
 */
export function parseReceipt(value: unknown): Receipt | null {
  if (value == null) return null;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const validated = ReceiptSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error('agents/operator: agent_proposals.receipt holds a shape no writer produces');
  }
  return validated.data;
}
```

Add the import at the top of `src/lib/agents/operator/schema.ts`, immediately after the existing `import { z } from 'zod';` (`src/lib/agents/operator/schema.ts:4`):

```ts
import { VoiceVersionTokenSchema } from './version-token';
```

`version-token.ts` imports nothing from `schema.ts`, so there is no cycle.

- [ ] **Step 6: Add `writerFields` to the catalog**

In `src/lib/agents/operator/catalog.ts`, add to the `ProposableOperation` interface after `preview` (`src/lib/agents/operator/catalog.ts:67`):

```ts
  /**
   * The fields this operation — and ONLY this operation — writes, ready for
   * `updateVoiceConfig`'s `fields` bag.
   *
   * NOT `preview().after`. `after` is the FULL effective state, so passing it
   * to the writer would write the four fields the owner did not agree to
   * change, silently reverting a concurrent settings edit to a different
   * field. The **Version token** proves the ROW did not move; once that holds,
   * writing more than was proposed is a widening nobody approved (D10).
   */
  writerFields(input: unknown): Partial<VoiceConfig>;
```

In `defineProposable`'s spec parameter (`src/lib/agents/operator/catalog.ts:72-79`), add after `apply`:

```ts
  writerFields: (input: T) => Partial<VoiceConfig>;
```

and in its returned object, after `preview` (`src/lib/agents/operator/catalog.ts:96-98`):

```ts
    // Same `as T` erasure undoing as `describe`: unreachable without a
    // successful `parseInput`, which every caller runs first.
    writerFields(input) {
      return spec.writerFields(input as T);
    },
```

Then add one `writerFields` line to each of the four proposables:

```ts
  set_tone: defineProposable({
    id: 'set_tone',
    labelKind: 'fact',
    summary: 'Set the reply tone',
    inputSchema: ToneInput,
    describe: (input) => `Set the reply tone to "${input.tone}"`,
    apply: (voice, input) => ({ ...voice, tone: input.tone }),
    writerFields: (input) => ({ tone: input.tone }),
  }),
  set_products_services: defineProposable({
    id: 'set_products_services',
    labelKind: 'fact',
    summary: 'Update the products and services the replies may mention',
    inputSchema: ProductsServicesInput,
    describe: (input) => input.productsServices === null
      ? 'Clear the products and services the replies may mention'
      : 'Update the products and services the replies may mention',
    apply: (voice, input) => ({ ...voice, productsServices: input.productsServices }),
    writerFields: (input) => ({ productsServices: input.productsServices }),
  }),
  set_avoid_facts: defineProposable({
    id: 'set_avoid_facts',
    labelKind: 'fact',
    summary: 'Set what to keep out of every reply',
    inputSchema: AvoidFactsInput,
    describe: (input) => `Keep ${input.avoidFacts.length} thing(s) out of every reply`,
    apply: (voice, input) => ({ ...voice, avoidFacts: input.avoidFacts }),
    writerFields: (input) => ({ avoidFacts: input.avoidFacts }),
  }),
  set_highlight_facts: defineProposable({
    id: 'set_highlight_facts',
    labelKind: 'fact',
    summary: 'Set what to highlight when a reply fits',
    inputSchema: HighlightFactsInput,
    describe: (input) => `Highlight ${input.highlightFacts.length} thing(s) when a reply fits`,
    apply: (voice, input) => ({ ...voice, highlightFacts: input.highlightFacts }),
    writerFields: (input) => ({ highlightFacts: input.highlightFacts }),
  }),
```

`ProductsServicesInput` admits `null` (`src/lib/agents/operator/catalog.ts:111-113`), and `updateVoiceConfig` skips only `undefined` (`src/lib/responses/voice-settings.ts:132`), so a deliberate clear-to-null reaches the column and is not mistaken for "field absent".

- [ ] **Step 7: Convert title 29 and extend `ProposalView`**

Replace the `describe('proposal view', …)` todo block in `src/lib/agents/operator/__tests__/proposals.test.ts` with a real case. Add these imports to the file's existing import list:

```ts
import { listProposalsForTurn } from '../proposals';
import { mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';
```

`sqlReturnQueue` must be destructured from the hoisted harness alongside `mockSql` — change the hoisted block at `src/lib/agents/operator/__tests__/proposals.test.ts:4-7` to also return `sqlReturnQueue`:

```ts
const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});
```

Then the case:

```ts
describe('proposal view', () => {
  it('proposal view carries receipt, prepared version token, applied_at and failure_reason', async () => {
    const receipt = {
      version: 1,
      operation: 'set_tone',
      scope: { accountId: ACCOUNT, locationId: LOCATION },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      differsFromPreview: false,
      effectiveNow: true,
      affects: 'future_drafts',
      remainingBlocked: [],
      appliedAt: '2026-09-12T10:00:00.000Z',
      actorUserId: ACTOR,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
      versionToken: {
        before: { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' },
        after: { businessId: LOCATION, updatedAt: '2026-09-12 10:00:00.222222+00' },
      },
    };

    sqlReturnQueue.push(mkTaggedResult([{
      turn_id: TURN,
      id: '66666666-6666-4666-8666-666666666666',
      operation: 'set_tone',
      contract_version: 1,
      label_kind: 'fact',
      location_id: LOCATION,
      status: 'applied',
      rationale: 'You asked for shorter replies.',
      input: { tone: 'warm and brief' },
      before: receipt.before,
      after: receipt.after,
      // The PgBouncer STRING form on purpose: these two columns are the new
      // parse sites, and a string is what the pooler can hand back.
      prepared_version_token: JSON.stringify(receipt.versionToken.before),
      receipt: JSON.stringify(receipt),
      applied_at: new Date('2026-09-12T10:00:00.000Z'),
      failure_reason: null,
    }]));

    const [view] = await listProposalsForTurn(mockSql, { turnId: TURN, accountId: ACCOUNT });

    expect(view!.turnId).toBe(TURN);
    expect(view!.preparedVersionToken).toEqual({
      businessId: LOCATION,
      updatedAt: '2026-09-12 09:00:00.111111+00',
    });
    expect(view!.receipt).toEqual(receipt);
    expect(view!.appliedAt).toBe('2026-09-12T10:00:00.000Z');
    expect(view!.failureReason).toBeNull();

    // The projection has to ASK for the four columns, or the view above would
    // be built from undefineds that happen to satisfy a loose assertion.
    const [call] = sqlCalls;
    for (const column of ['prepared_version_token', 'receipt', 'applied_at', 'failure_reason', 'turn_id']) {
      expect(call!.text).toContain(column);
    }
    expect(call!.text).toContain('account_id = ?');
  });
});
```

- [ ] **Step 8: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/proposals.test.ts -t "proposal view carries receipt"`
Expected: FAIL — `view.turnId` is `undefined` and the projection does not contain `receipt`.

- [ ] **Step 9: Extend `StoredRow`, `ProposalView`, `mapStored` and the three readers**

In `src/lib/agents/operator/proposals.ts`, replace the two row types at `:161-167`:

```ts
type StoredRow = {
  turn_id: string;
  id: string; operation: string; contract_version: number; label_kind: LabelKind;
  location_id: string | null; status: string; rationale: string;
  input: unknown; before: unknown; after: unknown;
  // Run B. `prepared_version_token` was written in Run A and read by nobody;
  // Apply is its first reader.
  prepared_version_token: unknown;
  receipt: unknown;
  applied_at: Date | string | null;
  failure_reason: string | null;
};
```

and DELETE `type StoredRowWithTurn = StoredRow & { turn_id: string };` — `turn_id` is now on the base row, so the intersection is a second name for one shape (P4).

Replace `ProposalView` (`:170-183`) with:

```ts
/** One **Proposal** as the owner reads it. The named public shape of the card. */
export interface ProposalView {
  id: string;
  /** The turn that prepared it. The Receipt's correlation id, and the card's. */
  turnId: string;
  operation: string;
  contractVersion: number;
  labelKind: LabelKind;
  locationId: string | null;
  status: ProposalStatus;
  rationale: string;
  input: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The card's words, recomputed from the catalog on read. */
  describe: string;
  /** The **Version token** recorded at preparation. Apply compares against it. */
  preparedVersionToken: VoiceVersionToken;
  /** Server-written, `null` until applied. Never supplied by the client. */
  receipt: Receipt | null;
  /** ISO-8601, or `null`. */
  appliedAt: string | null;
  failureReason: string | null;
}
```

Replace `mapStored` (`:185-207`) with:

```ts
function mapStored(row: StoredRow): ProposalView {
  const input = parseJsonbObject(row.input, 'agent_proposals.input');
  const operation = proposableOperation(row.operation);
  const parsed = operation?.parseInput(input);
  return {
    id: row.id,
    turnId: row.turn_id,
    operation: row.operation,
    contractVersion: row.contract_version,
    labelKind: row.label_kind,
    locationId: row.location_id,
    status: asProposalStatus(row.status),
    rationale: row.rationale,
    input,
    before: parseJsonbObject(row.before, 'agent_proposals.before'),
    after: parseJsonbObject(row.after, 'agent_proposals.after'),
    // The card's words come from the CATALOG at read time, never from a stored
    // string, so a copy edit ships without a data migration. A row whose
    // operation left the catalog (or whose stored input no longer parses under
    // a bumped contract) falls back to its rationale rather than throwing — the
    // card is still readable and Apply is what refuses it.
    describe: operation && parsed?.ok ? operation.describe(parsed.input) : row.rationale,
    preparedVersionToken: parseVersionToken(row.prepared_version_token),
    receipt: parseReceipt(row.receipt),
    // ISO, not the raw driver value: `applied_at` crosses as a JS `Date` and a
    // Date does not survive `JSON.stringify` in a route body as anything the
    // card can format. Unlike the **Version token** this value is never
    // COMPARED, so the millisecond truncation is cosmetic here.
    appliedAt: row.applied_at == null ? null : new Date(row.applied_at).toISOString(),
    failureReason: row.failure_reason,
  };
}
```

Add to the imports at the top of `src/lib/agents/operator/proposals.ts` (beside the existing `./schema` import at `:8-13`):

```ts
import { parseReceipt, type Receipt } from './schema';
import { parseVersionToken, type VoiceVersionToken } from './version-token';
```

(fold `parseReceipt`/`Receipt` into the existing `./schema` import list rather than adding a second statement).

Extend all three list projections. In `listProposalsForTurn` (`:213-220`), `listProposalsForTurns` (`:239-246`) and `listPendingProposals` (`:259-267`) the SELECT list becomes, identically in all three:

```sql
    SELECT turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after, prepared_version_token, receipt, applied_at, failure_reason
```

and `listProposalsForTurns`' row type parameter changes from `StoredRowWithTurn[]` to `StoredRow[]`.

- [ ] **Step 10: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/proposals.test.ts`
Expected: PASS — the existing `insertProposals` cases plus title 29.

- [ ] **Step 11: Add the two proposal readers and the sibling sweep to `proposals.ts`**

Append to `src/lib/agents/operator/proposals.ts` (after `listUnsupportedForTurn`, which closes at `:313`):

```ts
/**
 * One **Proposal**, account-scoped, WITHOUT a lock. The pre-transaction read
 * Apply uses for the **Contract version** check (spec §6.4, "before the
 * transaction"), and the read both POST routes use to render a result.
 *
 * A row of another account returns null, which both routes render as 404 —
 * indistinguishable from one that does not exist, so the read cannot be used
 * to probe for other tenants' ids.
 */
export async function readProposalForAccount(
  db: Db,
  input: { proposalId: string; accountId: string },
): Promise<ProposalView | null> {
  const [row] = await db<StoredRow[]>`
    SELECT turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after, prepared_version_token, receipt, applied_at, failure_reason
    FROM agent_proposals
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  return row ? mapStored(row) : null;
}

/**
 * The same read WITH `FOR UPDATE`. Callers must be inside `sql.begin()` for the
 * lock to hold — outside a transaction PgBouncer drops the row lock the instant
 * the SELECT returns (CLAUDE.md, `SELECT … FOR UPDATE` gotcha), and the status
 * branch this feeds would then race a concurrent Apply.
 */
export async function lockProposalForAccount(
  tx: Tx,
  input: { proposalId: string; accountId: string },
): Promise<ProposalView | null> {
  const [row] = await tx<StoredRow[]>`
    SELECT turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
           input, before, after, prepared_version_token, receipt, applied_at, failure_reason
    FROM agent_proposals
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
    FOR UPDATE
  `;
  return row ? mapStored(row) : null;
}

/**
 * Spec §8.3: after one Apply, every OTHER pending **Proposal** on the same
 * location is stale, because the write it just committed moved
 * `businesses.updated_at` and therefore every sibling's **Version token**.
 *
 * Runs in the SAME transaction as the mutation (D11), so there is no window in
 * which the owner can click a card whose token the previous click already
 * invalidated.
 *
 * `location_id = ${locationId}` rather than `IS NOT DISTINCT FROM`: this sweep
 * is voice-scope only and a voice Proposal always names a location (P8), so a
 * NULL-matching predicate here could only ever reach an account-default
 * Proposal that this write did NOT invalidate.
 *
 * No `conversation_id` predicate, deliberately: a sibling prepared in ANOTHER
 * conversation is just as stale, and scoping the sweep to one conversation
 * would leave it pending with a token that can never match again.
 */
export async function markSiblingProposalsStale(
  tx: Tx,
  input: { accountId: string; locationId: string; excludeProposalId: string },
): Promise<void> {
  await tx`
    UPDATE agent_proposals
    SET status = ${PROPOSAL_STATUS.STALE},
        failure_reason = ${PROPOSAL_FAILURE_REASON.VERSION_MISMATCH},
        updated_at = NOW()
    WHERE account_id = ${input.accountId}::uuid
      AND location_id = ${input.locationId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
      AND id <> ${input.excludeProposalId}::uuid
  `;
}
```

Add `PROPOSAL_FAILURE_REASON` to the existing `./schema` import list in the same file.

Also append the batched **Requested capability** reader the transcript needs
(RB-07). `listUnsupportedForTurn` already exists for the polled turn, but a
transcript of fifty turns must not issue fifty queries:

```ts
/**
 * Every turn's **Requested capability** rows in ONE `turn_id = ANY(...)` read,
 * keyed by turn — the same shape, and the same reason, as
 * `listProposalsForTurns`.
 *
 * The TRANSCRIPT needs these, not only the polled turn. An unsupported row is
 * durable (`agent_unsupported_requests`), so a screen that rendered it only
 * from the in-flight poll lost the card on the next reload or the next send
 * while the row sat in the table. An empty id list issues no statement at all.
 */
export async function listUnsupportedForTurns(
  db: Db,
  input: { turnIds: readonly string[]; accountId: string },
): Promise<Map<string, UnsupportedView[]>> {
  const byTurn = new Map<string, UnsupportedView[]>();
  if (input.turnIds.length === 0) return byTurn;

  const rows = await db<(UnsupportedView & { turn_id: string })[]>`
    SELECT turn_id, id, request, context
    FROM agent_unsupported_requests
    WHERE turn_id = ANY(${input.turnIds as string[]}::uuid[])
      AND account_id = ${input.accountId}::uuid
    ORDER BY created_at ASC
  `;
  for (const row of rows) {
    const existing = byTurn.get(row.turn_id);
    const view: UnsupportedView = { id: row.id, request: row.request, context: row.context };
    if (existing) existing.push(view);
    else byTurn.set(row.turn_id, [view]);
  }
  return byTurn;
}
```

- [ ] **Step 12: Convert the `apply.test.ts` todos into failing tests (titles 3, 5–12, 19)**

Replace `src/lib/agents/operator/__tests__/apply.test.ts` with:

```ts
// Unit seams for src/lib/agents/operator/apply.ts, against the recording
// mock-sql double (worker/__tests__/helpers/mock-sql.ts). These prove
// ORDERING, BRANCHING and WHAT IS BOUND.
//
// Two collaborators are mocked because they are not this module's subject:
// `assertWritableSubscriptionForAccount` (its own suite owns the posture
// matrix) and the two voice-writer functions. The voice mock uses
// `importOriginal` so `VOICE_FIELD_LIMITS` stays REAL — `catalog.ts` builds its
// zod input schemas from it (src/lib/agents/operator/catalog.ts:108-121), and a
// blanket factory mock would make every `parseInput` throw at import time.
//
// The rollback, the row lock, the sibling sweep and the read-back are live-DB
// properties and live in apply.integration.test.ts.
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const { mockWritable, mockReadVoice, mockUpdateVoice } = vi.hoisted(() => ({
  mockWritable: vi.fn(),
  mockReadVoice: vi.fn(),
  mockUpdateVoice: vi.fn(),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));

vi.mock('@/lib/responses/voice-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/responses/voice-settings')>();
  return {
    ...actual,
    readVoiceConfig: (...a: unknown[]) => mockReadVoice(...a),
    updateVoiceConfig: (...a: unknown[]) => mockUpdateVoice(...a),
  };
});

import { mkTaggedResult } from '../../../../../worker/__tests__/helpers/mock-sql';
import { applyProposal } from '../apply';
import { PROPOSAL_FAILURE_REASON, PROPOSAL_STATUS } from '../schema';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const TURN = '55555555-5555-4555-8555-555555555555';
const PROPOSAL = '66666666-6666-4666-8666-666666666666';
const SIBLING = '77777777-7777-4777-8777-777777777777';

const PREPARED_AT = '2026-09-12 09:00:00.111111+00';
const WRITTEN_AT = '2026-09-12 10:00:00.222222+00';

const VOICE_BEFORE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
};
const VOICE_AFTER = { ...VOICE_BEFORE, tone: 'warm and brief' };

/** A stored `agent_proposals` row as the readers project it. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: TURN,
    id: PROPOSAL,
    operation: 'set_tone',
    contract_version: 1,
    label_kind: 'fact',
    location_id: LOCATION,
    status: PROPOSAL_STATUS.PENDING,
    rationale: 'You asked for shorter replies.',
    input: { tone: 'warm and brief' },
    before: VOICE_BEFORE,
    after: VOICE_AFTER,
    prepared_version_token: { businessId: LOCATION, updatedAt: PREPARED_AT },
    receipt: null,
    applied_at: null,
    failure_reason: null,
    ...overrides,
  };
}

const EXPECTED_TOKEN = { businessId: LOCATION, updatedAt: PREPARED_AT };

/**
 * An UPDATE result carrying a row COUNT. `mkTaggedResult([])` reports
 * `count: 0`, and `recordTerminal` reads that count to decide whether its
 * `status = 'pending'` predicate matched — so priming a successful terminal
 * write with an empty array would make the module think it lost a race.
 */
const updated = (count = 1) => Object.assign([] as unknown[], { count });

/**
 * The statements that WRITE. `text.includes('UPDATE')` is WRONG here: both lock
 * SELECTs end in `FOR UPDATE`, and mock-sql preserves that text
 * (`worker/__tests__/helpers/mock-sql.ts:115-134`), so an `includes` check
 * reports a write on every locking read and can never fail. Anchored to the
 * start of a line instead.
 */
const writes = () => sqlCalls.filter((call) => /^\s*UPDATE\s/m.test(call.text));

function input(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL,
    accountId: ACCOUNT,
    actorUserId: ACTOR,
    expectedVersionToken: EXPECTED_TOKEN,
    ...overrides,
  };
}

/**
 * Primes the queue for a FULL happy path. The order is the module's statement
 * order and is the thing under test in title 3, so it is spelled out rather
 * than hidden behind a helper that could drift from the module:
 *
 *   0 pre-tx  readProposalForAccount
 *   1 tx      businesses … FOR UPDATE      → { updated_at }
 *   2 tx      agent_proposals … FOR UPDATE → the locked row
 *   3 tx      users … role = 'owner'       → the actor
 *   4 tx      accounts … subscription_tier
 *   5 tx      agent_turns … owner_text
 *   6 tx      UPDATE agent_proposals (applied)
 *   7 tx      readProposalForAccount (the applied view)
 *   8 tx      UPDATE agent_proposals (sibling sweep)
 *
 * `assertWritableSubscriptionForAccount` issues no statement here — it is
 * mocked — so there is no queue entry between 3 and 4.
 */
function primeHappyPath(options: { currentUpdatedAt?: string; storedOverrides?: Record<string, unknown> } = {}) {
  const locked = storedRow(options.storedOverrides);
  sqlReturnQueue.push(
    mkTaggedResult([locked]),
    mkTaggedResult([{ updated_at: options.currentUpdatedAt ?? PREPARED_AT }]),
    mkTaggedResult([locked]),
    mkTaggedResult([{ id: ACTOR }]),
    mkTaggedResult([{ subscription_tier: 'copilot' }]),
    mkTaggedResult([{ owner_text: 'Make my replies warmer.' }]),
    mkTaggedResult([]),
    mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.APPLIED, ...options.storedOverrides })]),
    mkTaggedResult([]),
  );
}

describe('applyProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockWritable.mockResolvedValue({ ok: true });
    mockUpdateVoice.mockResolvedValue({ ok: true, updatedAt: WRITTEN_AT });
    mockReadVoice.mockResolvedValue({ ...VOICE_AFTER, updatedAt: WRITTEN_AT });
  });

  it("applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig", async () => {
    primeHappyPath();

    const result = await applyProposal(mockSql, input());
    expect(result.kind).toBe('applied');

    // Statement 0 is the pre-transaction contract read and takes no lock.
    expect(sqlCalls[0]!.inTransaction).toBe(false);
    expect(sqlCalls[0]!.text).toContain('FROM agent_proposals');
    expect(sqlCalls[0]!.text).not.toContain('FOR UPDATE');

    // THE ORDERING THIS TEST EXISTS FOR: businesses first, proposal second.
    // Reversed, a concurrent settings PUT can move `updated_at` between the
    // proposal lock and the freshness read, and Apply commits against a row it
    // never actually held.
    expect(sqlCalls[1]!.inTransaction).toBe(true);
    expect(sqlCalls[1]!.text).toContain('FROM businesses');
    expect(sqlCalls[1]!.text).toContain('FOR UPDATE');
    expect(sqlCalls[1]!.text).toContain('archived_at IS NULL');
    expect(sqlCalls[1]!.text).toContain('updated_at::text');

    expect(sqlCalls[2]!.inTransaction).toBe(true);
    expect(sqlCalls[2]!.text).toContain('FROM agent_proposals');
    expect(sqlCalls[2]!.text).toContain('FOR UPDATE');

    // ONLY the operation's own field reaches the writer (D10). `after` carries
    // all five; passing it would revert a concurrent edit to another field.
    expect(mockUpdateVoice).toHaveBeenCalledTimes(1);
    const writerInput = mockUpdateVoice.mock.calls[0]![1] as { fields: Record<string, unknown> };
    expect(Object.keys(writerInput.fields)).toEqual(['tone']);
    expect(writerInput.fields).toEqual({ tone: 'warm and brief' });
  });

  it('applyProposal on an applied proposal returns the stored receipt and executes nothing', async () => {
    const receipt = {
      version: 1,
      operation: 'set_tone',
      scope: { accountId: ACCOUNT, locationId: LOCATION },
      before: VOICE_BEFORE,
      after: VOICE_AFTER,
      differsFromPreview: false,
      effectiveNow: true,
      affects: 'future_drafts',
      remainingBlocked: [],
      appliedAt: '2026-09-12T10:00:00.000Z',
      actorUserId: ACTOR,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
      versionToken: {
        before: { businessId: LOCATION, updatedAt: PREPARED_AT },
        after: { businessId: LOCATION, updatedAt: WRITTEN_AT },
      },
    };
    const applied = storedRow({ status: PROPOSAL_STATUS.APPLIED, receipt, applied_at: new Date('2026-09-12T10:00:00.000Z') });
    sqlReturnQueue.push(
      mkTaggedResult([applied]),                                  // pre-tx read
      mkTaggedResult([{ updated_at: WRITTEN_AT }]),               // businesses lock
      mkTaggedResult([applied]),                                  // proposal lock
    );

    const result = await applyProposal(mockSql, input());

    expect(result).toEqual({
      kind: 'applied',
      repeated: true,
      proposal: expect.objectContaining({ id: PROPOSAL, status: PROPOSAL_STATUS.APPLIED, receipt }),
    });
    // Nothing executed and nothing was written: three statements, no writer.
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(3);
    expect(writes()).toHaveLength(0);
  });

  it('applyProposal marks the proposal stale without mutation when the current token differs from the prepared token', async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      // The settings form wrote between preparation and this click.
      mkTaggedResult([{ updated_at: WRITTEN_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      mkTaggedResult([{ subscription_tier: 'copilot' }]),
      updated(1),                                                  // the stale UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.STALE, failure_reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH })]),
    );

    const result = await applyProposal(mockSql, input());

    expect(result.kind).toBe('stale');
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    const staleWrite = writes()[0];
    expect(staleWrite!.text).toContain('account_id = ?');
    expect(staleWrite!.values).toContain(PROPOSAL_FAILURE_REASON.VERSION_MISMATCH);
    // The STATE CHANGE commits even though nothing was applied (spec §6.4
    // step 3) — the card must come back saying why, not saying nothing.
    expect(staleWrite!.inTransaction).toBe(true);
  });

  it("applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token", async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      // The ROW has not moved — current equals prepared.
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      mkTaggedResult([{ subscription_tier: 'copilot' }]),
      updated(1),
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.STALE, failure_reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH })]),
    );

    // …but the CLIENT sent a token that is not the stored one. Spec §6.4
    // step 3 requires all three to agree, so this is a miss even though the
    // row is unchanged: the browser is describing a plan this row is not.
    const result = await applyProposal(mockSql, input({
      expectedVersionToken: { businessId: LOCATION, updatedAt: WRITTEN_AT },
    }));

    expect(result.kind).toBe('stale');
    expect(mockUpdateVoice).not.toHaveBeenCalled();
  });

  it("applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock", async () => {
    sqlReturnQueue.push(
      mkTaggedResult([storedRow({ contract_version: 2 })]),
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ contract_version: 2, status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED })]),
    );

    const result = await applyProposal(mockSql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    // BEFORE ANY LOCK: no transaction was opened and nothing was locked.
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls.every((call) => !call.text.includes('FOR UPDATE'))).toBe(true);
    expect(sqlCalls.every((call) => !call.inTransaction)).toBe(true);

    // …AND THE WRITE IS GUARDED ON `pending`. The status was read without a
    // lock, so a concurrent Apply can commit between that read and this UPDATE;
    // without the predicate the write would stamp `rejected` over an `applied`
    // row and destroy a committed Receipt.
    const update = writes()[0]!;
    expect(update.text).toContain('AND status = ?');
    expect(update.values).toContain(PROPOSAL_STATUS.PENDING);

    // And when it LOSES that race the zero-row UPDATE is not swallowed: the
    // re-read row is what the caller gets back.
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([storedRow({ contract_version: 2 })]),
      updated(0),                                                  // the predicate matched nothing
      mkTaggedResult([storedRow({ contract_version: 2, status: PROPOSAL_STATUS.APPLIED })]),
    );
    const lost = await applyProposal(mockSql, input());
    expect(lost).toMatchObject({ kind: 'applied', repeated: true });
  });

  it('applyProposal returns proposal_not_found for a proposal of another account', async () => {
    // The account predicate matched nothing. Same answer an unknown id gets.
    sqlReturnQueue.push(mkTaggedResult([]));

    const result = await applyProposal(mockSql, input());

    expect(result).toEqual({ kind: 'not_found' });
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.values).toContain(ACCOUNT);
  });

  it('applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal', async () => {
    for (const status of [
      PROPOSAL_STATUS.STALE,
      PROPOSAL_STATUS.REJECTED,
      PROPOSAL_STATUS.SUPERSEDED,
      PROPOSAL_STATUS.FAILED,
    ]) {
      resetMockSql();
      vi.clearAllMocks();
      mockWritable.mockResolvedValue({ ok: true });
      const locked = storedRow({ status });
      sqlReturnQueue.push(
        mkTaggedResult([locked]),
        mkTaggedResult([{ updated_at: PREPARED_AT }]),
        mkTaggedResult([locked]),
      );

      const result = await applyProposal(mockSql, input());

      expect(result).toEqual({
        kind: 'not_pending',
        status,
        proposal: expect.objectContaining({ status }),
      });
      expect(mockUpdateVoice).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    }
  });

  it('applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner', async () => {
    const locked = storedRow();
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([]),                                          // no owner row: role changed
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED })]),
    );

    const result = await applyProposal(mockSql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.UNAUTHORIZED,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    expect(mockUpdateVoice).not.toHaveBeenCalled();

    // The offboarding arm answers its own reason, not `unauthorized`.
    resetMockSql();
    vi.clearAllMocks();
    mockWritable.mockResolvedValue({ ok: false, status: 403, error: 'account_offboarding_blocked' });
    sqlReturnQueue.push(
      mkTaggedResult([locked]),
      mkTaggedResult([{ updated_at: PREPARED_AT }]),
      mkTaggedResult([locked]),
      mkTaggedResult([{ id: ACTOR }]),
      updated(1),
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING })]),
    );

    const offboarding = await applyProposal(mockSql, input());
    expect(offboarding).toMatchObject({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING,
    });
  });

  it('applyProposal rejects the proposal location_not_found when the location was archived after preparation', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([storedRow()]),
      // `archived_at IS NULL` in the lock's own predicate matched nothing.
      mkTaggedResult([]),
      // The proposal row is STILL locked and read: the status branch runs
      // before the location refusal (RB-10), so an already-applied row on an
      // archived location gets its Receipt back instead of a 409.
      mkTaggedResult([storedRow()]),
      updated(1),                                                  // the rejecting UPDATE
      mkTaggedResult([storedRow({ status: PROPOSAL_STATUS.REJECTED, failure_reason: PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND })]),
    );

    const result = await applyProposal(mockSql, input());

    expect(result).toEqual({
      kind: 'rejected',
      reason: PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND,
      proposal: expect.objectContaining({ status: PROPOSAL_STATUS.REJECTED }),
    });
    expect(mockUpdateVoice).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
});

describe('applyProposal invariants', () => {
  it('invariants: from any non-pending status applyProposal never writes businesses', async () => {
    const nonPending = fc.constantFrom(
      PROPOSAL_STATUS.APPLIED,
      PROPOSAL_STATUS.STALE,
      PROPOSAL_STATUS.REJECTED,
      PROPOSAL_STATUS.FAILED,
      PROPOSAL_STATUS.SUPERSEDED,
    );
    // Any current row timestamp, matching or not: the status branch runs BEFORE
    // the token comparison, so freshness cannot make a terminal row writable.
    const currentUpdatedAt = fc.constantFrom(PREPARED_AT, WRITTEN_AT, '2026-01-01 00:00:00+00');

    await fc.assert(
      fc.asyncProperty(nonPending, currentUpdatedAt, async (status, updatedAt) => {
        resetMockSql();
        vi.clearAllMocks();
        mockWritable.mockResolvedValue({ ok: true });
        mockUpdateVoice.mockResolvedValue({ ok: true, updatedAt: WRITTEN_AT });
        mockReadVoice.mockResolvedValue({ ...VOICE_AFTER, updatedAt: WRITTEN_AT });

        const locked = storedRow({ status });
        sqlReturnQueue.push(
          mkTaggedResult([locked]),
          mkTaggedResult([{ updated_at: updatedAt }]),
          mkTaggedResult([locked]),
        );

        const result = await applyProposal(mockSql, input());

        expect(['applied', 'not_pending']).toContain(result.kind);
        expect(mockUpdateVoice).not.toHaveBeenCalled();
        expect(writes()).toHaveLength(0);
      }),
      { numRuns: 40 },
    );
  });
});
```

- [ ] **Step 13: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/apply.test.ts`
Expected: FAIL at collection — `Failed to resolve import "../apply"`.

- [ ] **Step 14: Write `apply.ts`**

Create `src/lib/agents/operator/apply.ts`:

```ts
// The Apply protocol (spec §6.4): one call, one transaction, one **Receipt**.
//
// LOCK BEFORE CHECK is the whole design. Every freshness read, every
// revalidation and the write itself happen with the `businesses` row and the
// `agent_proposals` row already locked, so no writer can slip between the check
// and the write. The reverse order — read, then lock — is the classic
// time-of-check/time-of-use hole, and the **Version token** exists precisely to
// close it.
//
// Invariant #15: `sql`/`tx` arrive as parameters; this module never imports
// @/lib/db/server. Invariant #9: every statement carries an `account_id`
// predicate. Invariant #3: the only thing that changes is a location's voice
// columns, through the shared writer.
import type postgres from 'postgres';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { readVoiceConfig, updateVoiceConfig, type VoiceConfig } from '@/lib/responses/voice-settings';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import { proposableOperation } from './catalog';
import {
  lockProposalForAccount,
  markSiblingProposalsStale,
  readProposalForAccount,
  type ProposalView,
} from './proposals';
import {
  PROPOSAL_FAILURE_REASON,
  PROPOSAL_STATUS,
  parseVoiceState,
  type ProposalFailureReason,
  type ProposalStatus,
  type Receipt,
  type VoiceState,
} from './schema';
import {
  computeVoiceVersionToken,
  versionTokensEqual,
  type VoiceVersionToken,
} from './version-token';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export interface ApplyProposalInput {
  proposalId: string;
  accountId: string;
  actorUserId: string;
  /** The token the CARD was rendered from. All three must agree (D9). */
  expectedVersionToken: VoiceVersionToken;
}

/**
 * Six outcomes, and every non-`not_found` one carries the row, so the card
 * re-renders from what the server actually stored rather than from the
 * browser's interpretation of a status code.
 */
export type ApplyResult =
  | { kind: 'applied'; proposal: ProposalView; repeated: boolean }
  | { kind: 'stale'; proposal: ProposalView }
  | { kind: 'rejected'; proposal: ProposalView; reason: ProposalFailureReason }
  | { kind: 'failed'; proposal: ProposalView }
  | { kind: 'not_pending'; proposal: ProposalView; status: ProposalStatus }
  | { kind: 'not_found' };

export async function applyProposal(sql: Sql, input: ApplyProposalInput): Promise<ApplyResult> {
  // ── Before the transaction (spec §6.4) ──────────────────────────────────
  const loaded = await readProposalForAccount(sql, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!loaded) return { kind: 'not_found' };

  const operation = proposableOperation(loaded.operation);
  const contractCurrent = operation !== null && operation.contractVersion === loaded.contractVersion;

  // The **Contract version** check runs before any lock — but it REWRITES the
  // row only while that row is still pending (plan decision P5). Taken
  // literally on an `applied` row, an unguarded rewrite would overwrite a
  // terminal status with `rejected` and destroy the stored Receipt. A
  // non-pending row falls through to the transaction, whose status branch
  // answers `not_pending`.
  if (!contractCurrent && loaded.status === PROPOSAL_STATUS.PENDING) {
    const outcome = await recordTerminal(sql, {
      proposalId: input.proposalId,
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      status: PROPOSAL_STATUS.REJECTED,
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
    });
    // `loaded.status` was read WITHOUT a lock, so it is already stale by the
    // time the UPDATE runs: a concurrent Apply can commit in between, and an
    // unguarded write would stamp `rejected` over an `applied` row and destroy
    // its **Receipt**. `recordTerminal`'s `status = 'pending'` predicate is
    // what stops that, and a zero-row result is how this branch learns it lost
    // the race. The row is re-read either way, so the answer is the state that
    // actually exists rather than the one this branch intended.
    if (!outcome.written) {
      return outcome.proposal.status === PROPOSAL_STATUS.APPLIED
        ? { kind: 'applied', proposal: outcome.proposal, repeated: true }
        : { kind: 'not_pending', proposal: outcome.proposal, status: outcome.proposal.status };
    }
    return {
      kind: 'rejected',
      proposal: outcome.proposal,
      reason: PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED,
    };
  }

  // ── The transaction ─────────────────────────────────────────────────────
  return sql.begin(async (tx): Promise<ApplyResult> => {
    // A voice **Proposal** always names a location — `scopeRule` is `'location'`
    // on every proposable — so a NULL one is a row no writer this run produces
    // (P8). There is nothing to lock, so this is answered first.
    const locationId = loaded.locationId;
    if (locationId === null) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
    }

    // 1a. The `businesses` row, FIRST and account-scoped and active-only. Its
    //     `updated_at::text` IS the current **Version token** (D9) — the same
    //     spelling `readVoiceConfig` and `updateVoiceConfig` both return, so
    //     the three tokens are comparable as text.
    const [locked] = await tx<{ updated_at: string }[]>`
      SELECT updated_at::text AS updated_at
      FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND archived_at IS NULL
      FOR UPDATE
    `;
    // 1b. The proposal row, SECOND — and SECOND EVEN WHEN 1a FOUND NOTHING.
    //     Archiving a location is a supported owner action
    //     (`src/lib/locations/archive-location-tx.ts`), and migration 120 keeps
    //     the Proposal and its **Receipt** when it happens. Rejecting on the
    //     missing business before reading the proposal's status turns a repeat
    //     Apply on an ALREADY-APPLIED row into a 409 `location_not_found`, and
    //     the owner loses the Receipt that records what did happen. So the
    //     status branch runs first and the location refusal is reserved for a
    //     Proposal that is still `pending`. The business-before-proposal ORDER
    //     is unchanged wherever the business exists — which is the ordering the
    //     freshness check depends on.
    const proposal = await lockProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!proposal) return { kind: 'not_found' };

    if (!locked) {
      if (proposal.status === PROPOSAL_STATUS.APPLIED) {
        return { kind: 'applied', proposal, repeated: true };
      }
      if (proposal.status !== PROPOSAL_STATUS.PENDING) {
        return { kind: 'not_pending', proposal, status: proposal.status };
      }
      // Still pending, and the location it names is gone: this one genuinely
      // cannot be applied.
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
    }

    // 2. Ownership and state. A repeat Apply on an `applied` proposal returns
    //    the STORED Receipt and executes nothing (spec §6.4 step 2) — that is
    //    the whole idempotency story, and it is why the read happens under the
    //    lock rather than before it.
    if (proposal.status === PROPOSAL_STATUS.APPLIED) {
      return { kind: 'applied', proposal, repeated: true };
    }
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { kind: 'not_pending', proposal, status: proposal.status };
    }
    // Reachable only for a non-pending row that fell through the pre-transaction
    // guard; a pending row with a stale contract was already answered above.
    if (!contractCurrent || operation === null) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);
    }

    // 3. Revalidate WITH THE LOCKS HELD. The POST-time gate is not reusable
    //    here: minutes may have passed, the owner may be revoked, and the
    //    account may have entered offboarding. Same three checks
    //    `reauthorizeTurn` makes (src/lib/agents/operator/authorize.ts:21-58),
    //    run against `tx` so they see the locked state.
    const [actor] = await tx<{ id: string }[]>`
      SELECT id
      FROM users
      WHERE id = ${input.actorUserId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND role = 'owner'
    `;
    if (!actor) return rejected(tx, input, PROPOSAL_FAILURE_REASON.UNAUTHORIZED);

    const writable = await assertWritableSubscriptionForAccount(input.accountId, tx);
    if (!writable.ok) {
      return rejected(
        tx,
        input,
        writable.error === 'account_offboarding_blocked'
          ? PROPOSAL_FAILURE_REASON.ACCOUNT_OFFBOARDING
          : PROPOSAL_FAILURE_REASON.UNAUTHORIZED,
      );
    }

    const [account] = await tx<{ subscription_tier: string }[]>`
      SELECT subscription_tier
      FROM accounts
      WHERE id = ${input.accountId}::uuid
    `;
    if (!account || !isSubscriptionTier(account.subscription_tier)) {
      return rejected(tx, input, PROPOSAL_FAILURE_REASON.UNAUTHORIZED);
    }

    // 3b. The three tokens, TEXT TO TEXT (D9). `current` comes from the row we
    //     are holding, `prepared` from the proposal, `expected` from the client.
    //     All three must agree. The client's copy is checked too because a
    //     browser that is one render behind is describing a plan this row is
    //     not, even when the row itself has not moved (spec §6.4 step 3).
    const current = computeVoiceVersionToken({ businessId: locationId, updatedAt: locked.updated_at });
    const prepared = proposal.preparedVersionToken;
    if (
      !versionTokensEqual(current, prepared) ||
      !versionTokensEqual(prepared, input.expectedVersionToken)
    ) {
      const stale = await recordTerminal(tx, {
        proposalId: input.proposalId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        status: PROPOSAL_STATUS.STALE,
        reason: PROPOSAL_FAILURE_REASON.VERSION_MISMATCH,
      });
      // `written` is necessarily true here — the row is locked and was read as
      // `pending` three statements ago — so the flag is not branched on. The
      // state change COMMITS; the mutation never happened.
      return { kind: 'stale', proposal: stale.proposal };
    }

    // 4. Confirmation — not in this run. No Run B operation widens autonomy
    //    (`requires_confirmation` is false on every row Run A writes), so the
    //    asymmetric-friction branch is slice 2's and is deliberately absent
    //    rather than stubbed.

    // 5. Execute, through the operation's own fields only (D10). `parseInput`
    //    re-runs because the stored input crossed JSONB; a row whose input no
    //    longer parses under the deployed schema is a contract problem, not a
    //    freshness one.
    const parsedInput = operation.parseInput(proposal.input);
    if (!parsedInput.ok) return rejected(tx, input, PROPOSAL_FAILURE_REASON.CONTRACT_CHANGED);

    const fields: Partial<VoiceConfig> = operation.writerFields(parsedInput.input);
    // A THROW here propagates: postgres.js rolls the whole transaction back,
    // mutation and Receipt together, and the route answers 500 `apply_failed`
    // with the proposal still `pending` (D12). A deterministic REFUSAL is a
    // different thing and is handled below.
    const write = await updateVoiceConfig(tx, {
      accountId: input.accountId,
      locationId,
      fields,
    });
    if (!write.ok) {
      if (write.reason === 'location_not_found') {
        // Unreachable while the lock above holds, but a branch rather than a
        // non-null assertion: the writer owns that reason, not this module.
        return rejected(tx, input, PROPOSAL_FAILURE_REASON.LOCATION_NOT_FOUND);
      }
      const failed = await recordTerminal(tx, {
        proposalId: input.proposalId,
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        status: PROPOSAL_STATUS.FAILED,
        reason: PROPOSAL_FAILURE_REASON.WRITE_FAILED,
      });
      return { kind: 'failed', proposal: failed.proposal };
    }

    // 6. The Receipt. Read the committed-to-be state back from the locked row.
    const committed = await readVoiceConfig(tx, { accountId: input.accountId, locationId });
    if (!committed) {
      // The row is locked and was just updated, so this is impossible; throwing
      // rolls everything back rather than writing a Receipt built on a guess.
      throw new Error('agents/operator: voice row vanished inside the Apply transaction');
    }

    const [turn] = await tx<{ owner_text: string }[]>`
      SELECT owner_text
      FROM agent_turns
      WHERE id = ${proposal.turnId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    const afterActual = toVoiceState(committed);
    const afterPreviewed = parseVoiceState(proposal.after, 'agent_proposals.after');
    // ONE clock for both the column and the Receipt field (P3).
    const appliedAt = new Date().toISOString();

    const receipt: Receipt = {
      version: 1,
      operation: proposal.operation,
      scope: { accountId: input.accountId, locationId },
      // The state the card SHOWED when the owner clicked (P6).
      before: parseVoiceState(proposal.before, 'agent_proposals.before'),
      after: afterActual,
      differsFromPreview: !voiceStatesEqual(afterActual, afterPreviewed),
      effectiveNow: true,
      affects: 'future_drafts',
      // No readiness gate applies to a fact change (P7).
      remainingBlocked: [],
      appliedAt,
      actorUserId: input.actorUserId,
      // VERBATIM. A missing turn row cannot happen (the FK is NOT NULL), but an
      // empty string is a safer fallback than a throw that would roll back a
      // committed-to-be voice write over a cosmetic field.
      ownerText: turn?.owner_text ?? '',
      turnId: proposal.turnId,
      versionToken: {
        before: prepared,
        after: computeVoiceVersionToken({ businessId: locationId, updatedAt: write.updatedAt }),
      },
    };

    await tx`
      UPDATE agent_proposals
      SET status = ${PROPOSAL_STATUS.APPLIED},
          receipt = ${tx.json(receipt as never)},
          applied_at = ${appliedAt}::timestamptz,
          decided_by_user_id = ${input.actorUserId}::uuid,
          failure_reason = NULL,
          updated_at = NOW()
      WHERE id = ${input.proposalId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    const applied = await readProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!applied) {
      throw new Error('agents/operator: applied proposal vanished inside its own transaction');
    }

    // Spec §8.3, in the SAME transaction (D11).
    await markSiblingProposalsStale(tx, {
      accountId: input.accountId,
      locationId,
      excludeProposalId: input.proposalId,
    });

    return { kind: 'applied', proposal: applied, repeated: false };
  });
}

/**
 * One terminal transition plus the re-read that gives the caller the row.
 *
 * `AND status = 'pending'` IS LOAD-BEARING on the pre-transaction path and is
 * kept inside the transaction for symmetry. Before the transaction the status
 * was read WITHOUT a lock, so a concurrent Apply can commit between that read
 * and this UPDATE; without the predicate the write would stamp `rejected` over
 * an `applied` row and destroy a committed **Receipt** — the one thing the
 * Receipt invariant forbids. `written` reports whether the UPDATE matched, so
 * a caller that lost the race can answer with the state that exists rather
 * than the one it intended. Inside `sql.begin` the row is already locked and
 * `written` is always true, but a predicate that is free and correct in both
 * places is better than one that is correct in only one.
 *
 * The re-read rather than a `RETURNING` projection so `mapStored` stays the ONE
 * place a row becomes a `ProposalView` — a second hand-written mapping here is
 * how the card's `describe` and its status start disagreeing. It also returns
 * the CURRENT row on a lost race, which is exactly what the caller needs.
 */
async function recordTerminal(
  db: Sql | Tx,
  input: {
    proposalId: string;
    accountId: string;
    actorUserId: string;
    status: ProposalStatus;
    reason: ProposalFailureReason;
  },
): Promise<{ written: boolean; proposal: ProposalView }> {
  const result = await db`
    UPDATE agent_proposals
    SET status = ${input.status},
        failure_reason = ${input.reason},
        decided_by_user_id = ${input.actorUserId}::uuid,
        updated_at = NOW()
    WHERE id = ${input.proposalId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status = ${PROPOSAL_STATUS.PENDING}
  `;
  const row = await readProposalForAccount(db, {
    proposalId: input.proposalId,
    accountId: input.accountId,
  });
  if (!row) throw new Error('agents/operator: proposal vanished while recording its outcome');
  return { written: result.count > 0, proposal: row };
}

async function rejected(
  tx: Tx,
  input: ApplyProposalInput,
  reason: ProposalFailureReason,
): Promise<ApplyResult> {
  // Every caller of this helper holds the proposal's row lock and has already
  // seen it `pending`, so the UPDATE always matches and `written` is not
  // branched on here.
  const { proposal } = await recordTerminal(tx, {
    proposalId: input.proposalId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    status: PROPOSAL_STATUS.REJECTED,
    reason,
  });
  return { kind: 'rejected', proposal, reason };
}

/** `VoiceConfig & { updatedAt }` → the Receipt's five-field state. */
function toVoiceState(voice: VoiceConfig): VoiceState {
  return {
    tone: voice.tone,
    productsServices: voice.productsServices,
    avoidFacts: voice.avoidFacts,
    highlightFacts: voice.highlightFacts,
    sampleResponses: voice.sampleResponses,
  };
}

/**
 * Field-by-field, arrays by order. `JSON.stringify` comparison would make key
 * ORDER significant, and the two sides are built by different code paths.
 */
function voiceStatesEqual(a: VoiceState, b: VoiceState): boolean {
  return a.tone === b.tone
    && a.productsServices === b.productsServices
    && sameStrings(a.avoidFacts, b.avoidFacts)
    && sameStrings(a.highlightFacts, b.highlightFacts)
    && sameStrings(a.sampleResponses, b.sampleResponses);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
```

- [ ] **Step 15: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/apply.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 16: Write the live-DB proofs (titles 4, 13–16)**

Replace `src/lib/agents/operator/__tests__/apply.integration.test.ts` with:

```ts
// Live-DB proofs for src/lib/agents/operator/apply.ts.
//
// Nothing is mocked. The five cases here are the ones a double cannot answer:
// that the Receipt and the voice write share ONE transaction; that the sibling
// sweep touches this location and no other; that the Receipt's `after` is the
// committed state; that a throwing executor leaves nothing behind; and that two
// concurrent Applies serialize on the `businesses` row lock.
//
// Named *.integration.test.ts so vitest's serialized `integration` project
// picks it up (vitest.config.ts:26), and it executes NO DDL at run time — the
// schema is ASSERTED, never applied (.claude/rules/live-db-tests.md).
//
// SILENT SKIP WARNING: without TEST_DATABASE_POOL_URL this whole suite is
// skipped and the run still reports green. A skipped live proof looks exactly
// like a passing one in the summary line. Export TEST_DATABASE_POOL_URL AND
// DATABASE_POOL_URL before trusting a local run.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  assertSchemaReady,
  MIGRATION_120_OWNER_OPERATOR,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { applyProposal } from '../apply';
import { proposableOperation } from '../catalog';
import {
  buildProposalRows,
  insertProposals,
  readProposalForAccount,
  type ProposalRow,
} from '../proposals';
import { PROPOSAL_FAILURE_REASON, PROPOSAL_STATUS, parseVoiceState } from '../schema';
import { createTurn, type CreateTurnResult } from '../turns';

const testDatabaseUrl = resolveTestDatabaseUrl();
let db: postgres.Sql;
let lock: LiveDbLock | undefined;

let tenant: TenantSeed;
let locationId: string;
/** A SECOND location in the same account — the sibling sweep's negative case. */
let secondLocationId: string;

function createdOrThrow(result: CreateTurnResult): { conversationId: string; turnId: string } {
  if (result.kind !== 'created') throw new Error(`expected a created turn, got ${result.kind}`);
  return { conversationId: result.conversationId, turnId: result.turnId };
}

async function seedTurn(targetLocationId: string, text: string) {
  return createdOrThrow(await createTurn(db, {
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    conversationId: randomUUID(),
    clientTurnKey: randomUUID(),
    locationId: targetLocationId,
    text,
  }));
}

/** The location's current `updated_at::text` — the live **Version token** half. */
async function currentUpdatedAt(id: string): Promise<string> {
  const [row] = await db<{ updated_at: string }[]>`
    SELECT updated_at::text AS updated_at
    FROM businesses
    WHERE id = ${id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  if (!row) throw new Error('fixture location vanished');
  return row.updated_at;
}

/**
 * One pending `set_tone` **Proposal** written through the production writer,
 * with its **Version token** taken from the row as it stands NOW.
 *
 * ONE ROW PER TRANSACTION, following src/lib/agents/operator/__tests__/reads.integration.test.ts:84-90:
 * `created_at` defaults to the TRANSACTION's start time, so a batch written
 * inside one `begin` shares a timestamp and `ORDER BY created_at ASC` is free
 * to return them in either order.
 */
async function seedProposal(input: {
  conversationId: string;
  turnId: string;
  targetLocationId: string;
  tone: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}): Promise<{ proposalId: string; token: { businessId: string; updatedAt: string } }> {
  const updatedAt = await currentUpdatedAt(input.targetLocationId);
  const emptyVoice = {
    tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
  };
  const row: ProposalRow = {
    id: randomUUID(),
    conversationId: input.conversationId,
    turnId: input.turnId,
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    locationId: input.targetLocationId,
    operation: 'set_tone',
    contractVersion: 1,
    input: { tone: input.tone },
    before: input.before ?? emptyVoice,
    after: input.after ?? { ...emptyVoice, tone: input.tone },
    rationale: 'You asked for warmer replies.',
    labelKind: 'fact',
    preparedVersionToken: { businessId: input.targetLocationId, updatedAt },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
  };
  await db.begin(async (tx) => { await insertProposals(tx, [row]); });
  return { proposalId: row.id, token: { businessId: input.targetLocationId, updatedAt } };
}

/**
 * A Proposal inserted at a given terminal status, for the archived-location
 * cases. `seedProposal` cannot be reused there: it reads `updated_at` from a
 * row that is archived by the time it runs, and `readVoiceConfig`-shaped reads
 * exclude archived rows by design.
 */
async function seedProposalOnArchived(input: {
  conversationId: string;
  turnId: string;
  targetLocationId: string;
  status: (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];
}): Promise<string> {
  const emptyVoice = {
    tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
  };
  const row: ProposalRow = {
    id: randomUUID(),
    conversationId: input.conversationId,
    turnId: input.turnId,
    accountId: tenant.accountId,
    actorUserId: tenant.userId,
    locationId: input.targetLocationId,
    operation: 'set_tone',
    contractVersion: 1,
    input: { tone: 'formal' },
    before: emptyVoice,
    after: { ...emptyVoice, tone: 'formal' },
    rationale: 'A superseded plan.',
    labelKind: 'fact',
    preparedVersionToken: { businessId: input.targetLocationId, updatedAt: '2026-01-01 00:00:00+00' },
    requiresConfirmation: false,
    status: PROPOSAL_STATUS.PENDING,
  };
  await db.begin(async (tx) => { await insertProposals(tx, [row]); });
  await db`
    UPDATE agent_proposals SET status = ${input.status}
    WHERE id = ${row.id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  return row.id;
}

async function readTone(id: string): Promise<string | null> {
  const [row] = await db<{ tone: string | null }[]>`
    SELECT tone FROM businesses
    WHERE id = ${id}::uuid AND account_id = ${tenant.accountId}::uuid
  `;
  return row?.tone ?? null;
}

async function deleteOperatorRows(accountId: string): Promise<void> {
  await db`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await db`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
}

describeWithDb(
  'applyProposal (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      lock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_120_OWNER_OPERATOR]);

      tenant = await seedTenantAccount(db, {
        userName: 'Operator Apply Owner',
        accountDisplayName: 'Operator Apply Account',
      });
      locationId = (await seedLocation(db, tenant.accountId, { name: 'Salon' })).businessId;
      secondLocationId = (await seedLocation(db, tenant.accountId, {
        name: 'Cafe', isPrimary: false,
      })).businessId;
      process.env.OWNER_OPERATOR_ENABLED = 'true';
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await deleteOperatorRows(tenant.accountId);
      await db`DELETE FROM job_outbox WHERE topic = 'agent_turn'`;
      // Reset the voice columns so each case starts from a known state and its
      // own **Version token** read is meaningful.
      await db`
        UPDATE businesses
        SET tone = NULL, products_services = NULL, avoid_facts = NULL,
            highlight_facts = NULL, sample_responses = NULL
        WHERE account_id = ${tenant.accountId}::uuid
      `;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          await db`DELETE FROM businesses WHERE account_id = ${tenant.accountId}::uuid`;
          await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await lock?.release();
          lock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');
      expect(result.repeated).toBe(false);

      // The COMMITTED row, read back on a fresh statement.
      const [row] = await db<{
        status: string; decided_by_user_id: string | null; applied_at: Date | null;
        receipt: unknown; failure_reason: string | null;
      }[]>`
        SELECT status, decided_by_user_id, applied_at, receipt, failure_reason
        FROM agent_proposals
        WHERE id = ${proposalId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;
      expect(row!.status).toBe(PROPOSAL_STATUS.APPLIED);
      expect(row!.decided_by_user_id).toBe(tenant.userId);
      expect(row!.applied_at).not.toBeNull();
      expect(row!.failure_reason).toBeNull();

      // And the voice write committed with it. One transaction, or neither.
      expect(await readTone(locationId)).toBe('warm and brief');

      const receipt = result.proposal.receipt;
      expect(receipt).not.toBeNull();
      expect(receipt!.version).toBe(1);
      expect(receipt!.operation).toBe('set_tone');
      expect(receipt!.scope).toEqual({ accountId: tenant.accountId, locationId });
      expect(receipt!.after.tone).toBe('warm and brief');
      expect(receipt!.effectiveNow).toBe(true);
      expect(receipt!.affects).toBe('future_drafts');
      expect(receipt!.remainingBlocked).toEqual([]);
      expect(receipt!.actorUserId).toBe(tenant.userId);
      expect(receipt!.turnId).toBe(turn.turnId);
      // VERBATIM owner text (spec §6.5), read from the turn, not from the card.
      expect(receipt!.ownerText).toBe('Make my replies warmer.');
      // The token moved, and the Receipt records both ends of the move.
      expect(receipt!.versionToken.before).toEqual(token);
      expect(receipt!.versionToken.after.updatedAt).not.toBe(token.updatedAt);
      expect(receipt!.versionToken.after.updatedAt).toBe(await currentUpdatedAt(locationId));
      // ONE clock for the column and the field (plan decision P3).
      expect(new Date(receipt!.appliedAt).getTime()).toBe(row!.applied_at!.getTime());
    });

    it('applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const first = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });
      const sibling = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'formal',
      });
      // A pending proposal on ANOTHER location, and its own turn. This write
      // does not move that location's `updated_at`, so its token still matches.
      const otherTurn = await seedTurn(secondLocationId, 'And for the cafe.');
      const otherLocation = await seedProposal({
        conversationId: otherTurn.conversationId,
        turnId: otherTurn.turnId,
        targetLocationId: secondLocationId,
        tone: 'playful',
      });

      const result = await applyProposal(db, {
        proposalId: first.proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: first.token,
      });
      expect(result.kind).toBe('applied');

      const siblingRow = await readProposalForAccount(db, {
        proposalId: sibling.proposalId,
        accountId: tenant.accountId,
      });
      expect(siblingRow!.status).toBe(PROPOSAL_STATUS.STALE);
      expect(siblingRow!.failureReason).toBe(PROPOSAL_FAILURE_REASON.VERSION_MISMATCH);

      const otherRow = await readProposalForAccount(db, {
        proposalId: otherLocation.proposalId,
        accountId: tenant.accountId,
      });
      expect(otherRow!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(otherRow!.failureReason).toBeNull();

      // The applied one is not swept by its own sweep.
      const appliedRow = await readProposalForAccount(db, {
        proposalId: first.proposalId,
        accountId: tenant.accountId,
      });
      expect(appliedRow!.status).toBe(PROPOSAL_STATUS.APPLIED);
    });

    it('applyProposal receipt after equals the committed voice state and flags a difference from the stored after', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      // The stored preview claims a state that is NOT what this operation
      // writes — a seeded column, or a preview built against a different row.
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
        after: {
          tone: 'warm and brief',
          productsServices: 'haircuts and colour',
          avoidFacts: [],
          highlightFacts: [],
          sampleResponses: [],
        },
      });

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');

      const receipt = result.proposal.receipt!;
      // The Receipt shows the ACTUAL state (spec §6.5): only `tone` was written,
      // because only `tone` is this operation's own field (D10).
      expect(receipt.after).toEqual({
        tone: 'warm and brief',
        productsServices: null,
        avoidFacts: [],
        highlightFacts: [],
        sampleResponses: [],
      });
      expect(receipt.differsFromPreview).toBe(true);
      // …and the status is still applied. A difference is reported, not refused.
      expect(result.proposal.status).toBe(PROPOSAL_STATUS.APPLIED);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('applyProposal rolls back the receipt when the voice write throws', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      // THE FAILURE ORIGINATES IN POSTGRES, not in JS: a plain JS throw does not
      // poison a Postgres transaction, so a test built on one proves nothing
      // about the aborted state the real hazard produces
      // (src/lib/shared/__tests__/helpers/abort-injection.ts:15-18). `SELECT 1/0` raises 22012.
      const poisoned = abortingExecutor(db, (tx) => tx`SELECT 1 / 0`);

      await expect(applyProposal(poisoned, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      })).rejects.toThrow();

      // NOTHING committed: no Receipt, no status change, no voice write. That
      // is the invariant — there is no committed mutation without a Receipt and
      // no Receipt without a committed mutation.
      const row = await readProposalForAccount(db, { proposalId, accountId: tenant.accountId });
      expect(row!.status).toBe(PROPOSAL_STATUS.PENDING);
      expect(row!.receipt).toBeNull();
      expect(row!.appliedAt).toBeNull();
      expect(await readTone(locationId)).toBeNull();

      // And a retry finds it still applicable (intake edge case).
      const retry = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(retry.kind).toBe('applied');
    });

    it('two concurrent applies on one proposal produce one voice write and both return the same receipt', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const call = () => applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      // Two independent connections from the same pool. Both queue on the
      // `businesses` row lock; the loser finds the row `applied` and returns
      // the winner's stored Receipt without executing.
      const [a, b] = await Promise.all([call(), call()]);

      expect(a.kind).toBe('applied');
      expect(b.kind).toBe('applied');
      if (a.kind !== 'applied' || b.kind !== 'applied') throw new Error('unreachable');
      expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
      // ONE Receipt, byte for byte, whichever call won.
      expect(a.proposal.receipt).toEqual(b.proposal.receipt);
      expect(a.proposal.receipt).not.toBeNull();

      // ONE voice write: the second Apply did not re-stamp `updated_at`.
      expect(await currentUpdatedAt(locationId))
        .toBe(a.proposal.receipt!.versionToken.after.updatedAt);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('worker-produced proposals render and apply successfully', async () => {
      // THE FIXTURE IS THE PRODUCTION PATH, and that is the whole case.
      // `AgentTurnWorker` builds a Proposal from `readVoiceConfig`'s result
      // (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`), whose type is
      // `VoiceConfig & { updatedAt }`; `preview` returns that object as
      // `before` and spreads it into `after`
      // (`src/lib/agents/operator/catalog.ts:96-98`); `buildProposalRows`
      // stores both (`src/lib/agents/operator/proposals.ts:77-78`). Every real
      // row therefore carries SIX keys, and a hand-typed five-key fixture
      // cannot see a parser that rejects them.
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const voice = await readVoiceConfig(db, { accountId: tenant.accountId, locationId });
      if (!voice) throw new Error('fixture voice row missing');
      expect(voice).toHaveProperty('updatedAt');

      const operation = proposableOperation('set_tone');
      if (!operation) throw new Error('set_tone left the catalog');
      const parsed = operation.parseInput({ tone: 'warm and brief' });
      if (!parsed.ok) throw new Error('set_tone rejected its own input');

      const rows = buildProposalRows(
        {
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          locationId,
        },
        [{ operation, input: parsed.input, scope: { accountId: tenant.accountId, locationId }, rationale: 'You asked for warmer replies.' }],
        voice,
      );
      await db.begin(async (tx) => { await insertProposals(tx, rows); });

      const proposalId = rows[0]!.id;
      // The stored preview really does carry the extra key.
      expect(Object.keys(rows[0]!.before)).toContain('updatedAt');

      // READ IT BACK through the production mapper: `mapStored` →
      // `parseVoiceState` is what the card calls, and it must not throw.
      const view = await readProposalForAccount(db, { proposalId, accountId: tenant.accountId });
      expect(view).not.toBeNull();
      expect(() => parseVoiceState(view!.before, 'agent_proposals.before')).not.toThrow();
      expect(parseVoiceState(view!.after, 'agent_proposals.after')).not.toHaveProperty('updatedAt');

      const result = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: { businessId: locationId, updatedAt: voice.updatedAt },
      });

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('unreachable');
      // The Receipt's five-field state, with the stored `updatedAt` DROPPED —
      // it is recorded once, under `versionToken.before`, and nowhere else.
      expect(result.proposal.receipt!.before).not.toHaveProperty('updatedAt');
      expect(result.proposal.receipt!.after).not.toHaveProperty('updatedAt');
      expect(result.proposal.receipt!.versionToken.before.updatedAt).toBe(voice.updatedAt);
      expect(await readTone(locationId)).toBe('warm and brief');
    });

    it('repeat Apply after location archival returns the original receipt without writes', async () => {
      const turn = await seedTurn(locationId, 'Make my replies warmer.');
      const { proposalId, token } = await seedProposal({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        targetLocationId: locationId,
        tone: 'warm and brief',
      });

      const first = await applyProposal(db, {
        proposalId,
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        expectedVersionToken: token,
      });
      expect(first.kind).toBe('applied');
      if (first.kind !== 'applied') throw new Error('unreachable');

      // The owner archives the location afterwards. This is a supported
      // action, and migration 120 keeps the Proposal and its Receipt.
      await db`
        UPDATE businesses SET archived_at = NOW()
        WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;

      try {
        const repeat = await applyProposal(db, {
          proposalId,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          expectedVersionToken: token,
        });

        // THE STORED RECEIPT, not a 409 `location_not_found`. The business
        // lock finds nothing, but the proposal's status is read first, so the
        // owner keeps the record of what did happen (RB-10).
        expect(repeat).toMatchObject({ kind: 'applied', repeated: true });
        if (repeat.kind !== 'applied') throw new Error('unreachable');
        expect(repeat.proposal.receipt).toEqual(first.proposal.receipt);
        expect(repeat.proposal.status).toBe(PROPOSAL_STATUS.APPLIED);
        expect(repeat.proposal.failureReason).toBeNull();

        // A NON-APPLIED terminal status under the same condition answers
        // `not_pending`, not `location_not_found`.
        const second = await seedProposalOnArchived({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          targetLocationId: locationId,
          status: PROPOSAL_STATUS.SUPERSEDED,
        });
        const superseded = await applyProposal(db, {
          proposalId: second,
          accountId: tenant.accountId,
          actorUserId: tenant.userId,
          expectedVersionToken: token,
        });
        expect(superseded).toMatchObject({ kind: 'not_pending', status: PROPOSAL_STATUS.SUPERSEDED });
      } finally {
        await db`
          UPDATE businesses SET archived_at = NULL
          WHERE id = ${locationId}::uuid AND account_id = ${tenant.accountId}::uuid
        `;
      }
    });
  },
);
```

**`Promise.all` note for `ci:pool-fanout`:** the gate fails a `Promise` combinator over ≥2 DB-issuing elements **in `src/lib/{admin,dashboard,locations}`** only. This file is under `src/lib/agents/operator/__tests__/`, and the combinator IS the subject of the test (two concurrent Applies), so it is both out of the gate's scope and deliberate. Every production read added in this run is awaited in sequence.

- [ ] **Step 17: Run the live-DB suite**

Run:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
export TEST_DATABASE_POOL_URL="$(grep -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)"
export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
pnpm exec vitest run --project integration src/lib/agents/operator/__tests__/apply.integration.test.ts
```

Expected: PASS — 7 tests. **If the summary says "skipped", the env is not set and the proof did not run.** `assertSchemaReady` needs migration 120 in the local container; if it fails, run `pnpm test:db:setup` first.

- [ ] **Step 18: Run the whole operator surface and the DB audits**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator && pnpm typecheck && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:db-imports && pnpm ci:pool-fanout`
Expected: all PASS. `ci:db-imports` in particular: `apply.ts` and `version-token.ts` take `sql`/`tx` as parameters and import no singleton (invariant #15).

- [ ] **Step 19: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add src/lib/agents/operator/version-token.ts \
        src/lib/agents/operator/apply.ts \
        src/lib/agents/operator/schema.ts \
        src/lib/agents/operator/catalog.ts \
        src/lib/agents/operator/proposals.ts \
        src/lib/agents/operator/__tests__/version-token.test.ts \
        src/lib/agents/operator/__tests__/apply.test.ts \
        src/lib/agents/operator/__tests__/apply.integration.test.ts \
        src/lib/agents/operator/__tests__/proposals.test.ts
git commit -m "feat(operator): applyProposal — the Version token, the Apply transaction and the server-written Receipt"
```

---

### Task T2: `declineProposal`, the two POST routes, `?locationId=`, the impersonation helper and the MFA allowlist

Runs in PARALLEL with T3. Their file sets are disjoint: T2 owns `src/lib/agents/operator/{proposals,reads}.ts`, `src/lib/{admin/impersonation/cookie,shared/protected-routes}.ts`, everything under `src/app/api/`, and the API test files. T3 owns everything under `src/app/(authenticated)/` and `src/components/`.

**Blocking edges:** T0, T1 (it imports `applyProposal`, `readProposalForAccount`, `lockProposalForAccount` and the extended `ProposalView`). **Lease:** the files listed below; T3 must not touch any of them.

**Turns green (verbatim):**
17. `declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent`
18. `declineProposal answers proposal_not_pending for an applied proposal`
21. `isProtectedOwnerApiRoute returns true for /api/operator, /api/operator/turns, /api/operator/conversation and both proposal routes`
22. `POST apply returns 404 operator_disabled before auth when the flag is off`
23. `POST apply rejects a missing or mismatched Origin before any read`
24. `POST apply rejects an impersonated session with 409 impersonation_not_allowed`
25. `POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409`
26. `POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin`
27. `POST decline returns 200 with the rejected proposal and 404 for another account's proposal`
28. `GET conversation scopes the summary to ?locationId= when the conversation has no turns`
R9. `first-time owner receives a scoped summary and connection CTA before sending`

**Files:**
- Create: `src/app/api/operator/proposals/[id]/apply/route.ts`
- Create: `src/app/api/operator/proposals/[id]/decline/route.ts`
- Modify: `src/lib/agents/operator/proposals.ts` (append `declineProposal`)
- Modify: `src/lib/agents/operator/reads.ts:105-120` (`OwnerConversationTurn`), `:122-130` (`OwnerConversationSummary`), `:156-274` (`getConversationForOwner`)
- Modify: `src/lib/admin/impersonation/cookie.ts:38` (export `hasImpersonationCookie` beside the name)
- Modify: `src/app/api/operator/turns/route.ts:8` (import), `:97-99` (delete the private copy)
- Modify: `src/app/api/settings/auto-approval/route.ts:2` (import), `:116-118` (delete the private copy)
- Modify: `src/lib/shared/protected-routes.ts:47-59` (one allowlist arm)
- Modify: `src/app/api/operator/conversation/route.ts:18-51` (`?locationId=`)
- Test: `src/lib/agents/operator/__tests__/proposals.test.ts` (titles 17, 18)
- Test: `src/lib/shared/__tests__/protected-routes.test.ts` (title 21)
- Test: `src/app/api/operator/__tests__/apply-route.test.ts` (titles 22–25)
- Test: `src/app/api/operator/__tests__/decline-route.test.ts` (titles 26, 27)
- Test: `src/app/api/operator/__tests__/conversation-route.test.ts` (title 28)
- Test: `src/lib/agents/operator/__tests__/reads.integration.test.ts` (title R9, live DB)

**Precedent paths:** `src/app/api/operator/turns/route.ts:32-101` (flag → same-origin → writable owner → impersonation → parse → one module call → switch) · `src/app/api/operator/turns/[id]/route.ts:28-31` (uuid-or-404) · `src/app/api/operator/__tests__/turns-route.test.ts:1-64` (the mock shim, including the `NEXT_PUBLIC_APP_URL` line `withSameOrigin` needs) · `src/app/api/settings/auto-approval/route.ts:43-51` (the impersonation 409 this one mirrors) · `src/lib/shared/__tests__/protected-routes.test.ts:151-172` (the role-matrix block) · architecture pass H1-A and H1-B.

**Completion evidence:** `pnpm exec vitest run src/app/api/operator src/lib/shared/__tests__/protected-routes.test.ts src/lib/agents/operator` green; `rg -c 'function hasImpersonationCookie' src/` returns exactly `1`; `pnpm typecheck`, `pnpm lint`, `pnpm ci:tenant-scope`, `pnpm ci:static-policy` green.

- [ ] **Step 1: Convert the decline todos into failing tests (titles 17, 18)**

Replace the `describe('declineProposal', …)` todo block in `src/lib/agents/operator/__tests__/proposals.test.ts` with:

```ts
describe('declineProposal', () => {
  const PENDING_ROW = {
    turn_id: TURN,
    id: '66666666-6666-4666-8666-666666666666',
    operation: 'set_tone',
    contract_version: 1,
    label_kind: 'fact',
    location_id: LOCATION,
    status: 'pending',
    rationale: 'You asked for shorter replies.',
    input: { tone: 'warm and brief' },
    before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
    after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
    prepared_version_token: { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' },
    receipt: null,
    applied_at: null,
    failure_reason: null,
  };

  it('declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent', async () => {
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([PENDING_ROW]),                                        // lock
      mkTaggedResult([]),                                                   // UPDATE
      mkTaggedResult([{ ...PENDING_ROW, status: 'rejected' }]),             // re-read
    );

    const first = await declineProposal(mockSql, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });

    expect(first).toEqual({
      kind: 'rejected',
      repeated: false,
      proposal: expect.objectContaining({ status: 'rejected', failureReason: null }),
    });

    // `includes('UPDATE')` would also match the lock SELECT's trailing `FOR
    // UPDATE`, so the write is found with a line-anchored match.
    const update = sqlCalls.find((call) => /^\s*UPDATE\s/m.test(call.text))!;
    expect(update.text).toContain('account_id = ?');
    expect(update.values).toContain(ACTOR);
    // NO REASON (D5). `owner_declined` in `failure_reason` would make "the
    // owner said no" indistinguishable from a server refusal in every read
    // that counts non-NULL reasons.
    expect(update.text).toContain('failure_reason = NULL');

    // Idempotent: a second click on the same card, or a retried POST, finds an
    // owner-declined row (rejected, no reason) and returns it unchanged.
    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([{ ...PENDING_ROW, status: 'rejected' }]),             // lock
    );
    const second = await declineProposal(mockSql, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });
    expect(second).toEqual({
      kind: 'rejected',
      repeated: true,
      proposal: expect.objectContaining({ status: 'rejected' }),
    });
    expect(sqlCalls.some((call) => /^\s*UPDATE\s/m.test(call.text))).toBe(false);
  });

  it('declineProposal answers proposal_not_pending for an applied proposal', async () => {
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([{ ...PENDING_ROW, status: 'applied' }]));

    const result = await declineProposal(mockSql, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });

    expect(result).toEqual({
      kind: 'not_pending',
      status: 'applied',
      proposal: expect.objectContaining({ status: 'applied' }),
    });
    expect(sqlCalls.some((call) => /^\s*UPDATE\s/m.test(call.text))).toBe(false);

    // A row REJECTED BY THE SERVER is not an owner decline: it carries a
    // reason, so declining it again is `not_pending`, not a silent success.
    resetMockSql();
    sqlReturnQueue.push(mkTaggedResult([{
      ...PENDING_ROW, status: 'rejected', failure_reason: 'contract_changed',
    }]));
    const refused = await declineProposal(mockSql, {
      proposalId: PENDING_ROW.id,
      accountId: ACCOUNT,
      actorUserId: ACTOR,
    });
    expect(refused).toMatchObject({ kind: 'not_pending', status: 'rejected' });
  });
});
```

Add `declineProposal` to the `../proposals` import list in that file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/proposals.test.ts -t declineProposal`
Expected: FAIL at collection — `"declineProposal" is not exported by src/lib/agents/operator/proposals.ts`.

- [ ] **Step 3: Write `declineProposal`**

Append to `src/lib/agents/operator/proposals.ts`, after `markSiblingProposalsStale`:

```ts
export type DeclineResult =
  | { kind: 'rejected'; proposal: ProposalView; repeated: boolean }
  | { kind: 'not_pending'; proposal: ProposalView; status: ProposalStatus }
  | { kind: 'not_found' };

/**
 * "Not now" (spec §6.3): the owner declined. THE ACTOR IS THE WHOLE RECORD —
 * `status='rejected'` and `decided_by_user_id`, with `failure_reason` left
 * NULL (D5). There is deliberately no reason field on the button: a stored
 * `owner_declined` token would make a human decision indistinguishable from a
 * server refusal in every read that counts non-NULL reasons, and the intake
 * puts a Decline reason out of scope.
 *
 * IDEMPOTENT. A second click, a double-submit or a retried POST finds a row
 * that is already `rejected` WITH NO REASON — the signature of an owner
 * decline — and returns it unchanged with `repeated: true`. A row rejected by
 * the SERVER carries a reason and is therefore not this; it answers
 * `not_pending`, so the card says "the plan was refused" rather than "you
 * declined it".
 *
 * Inside `sql.begin` with the row locked, so the status read and the write
 * cannot be separated by a concurrent Apply. No `businesses` lock: nothing
 * outside `agent_proposals` changes.
 */
export async function declineProposal(
  sql: postgres.Sql,
  input: { proposalId: string; accountId: string; actorUserId: string },
): Promise<DeclineResult> {
  return sql.begin(async (tx): Promise<DeclineResult> => {
    const [row] = await tx<StoredRow[]>`
      SELECT turn_id, id, operation, contract_version, label_kind, location_id, status, rationale,
             input, before, after, prepared_version_token, receipt, applied_at, failure_reason
      FROM agent_proposals
      WHERE id = ${input.proposalId}::uuid
        AND account_id = ${input.accountId}::uuid
      FOR UPDATE
    `;
    if (!row) return { kind: 'not_found' };
    const proposal = mapStored(row);

    if (
      proposal.status === PROPOSAL_STATUS.REJECTED &&
      proposal.failureReason === null
    ) {
      return { kind: 'rejected', proposal, repeated: true };
    }
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { kind: 'not_pending', proposal, status: proposal.status };
    }

    await tx`
      UPDATE agent_proposals
      SET status = ${PROPOSAL_STATUS.REJECTED},
          decided_by_user_id = ${input.actorUserId}::uuid,
          failure_reason = NULL,
          updated_at = NOW()
      WHERE id = ${input.proposalId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    const declined = await readProposalForAccount(tx, {
      proposalId: input.proposalId,
      accountId: input.accountId,
    });
    if (!declined) throw new Error('agents/operator: declined proposal vanished in its own transaction');
    return { kind: 'rejected', proposal: declined, repeated: false };
  });
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/agents/operator/__tests__/proposals.test.ts`
Expected: PASS — titles 17, 18 and 29 plus the existing `insertProposals` cases.

- [ ] **Step 5: Convert title 21 and widen the allowlist**

Replace the `it.todo('isProtectedOwnerApiRoute returns true for /api/operator …')` line in `src/lib/shared/__tests__/protected-routes.test.ts` (inside the `describe('protected API route roles', …)` block, whose last existing case closes at `src/lib/shared/__tests__/protected-routes.test.ts:171`) with:

```ts
  it('isProtectedOwnerApiRoute returns true for /api/operator, /api/operator/turns, /api/operator/conversation and both proposal routes', () => {
    // Architecture pass 2026-09-12, H1-A. Proxy branch 6 (src/proxy.ts:349-364)
    // is the only place getAalGate() runs for an API route, and it keys off
    // THIS predicate. Without the arm, an owner under MFA enforcement answers a
    // 403 on /api/settings and a 200 on /api/operator — while both change the
    // same `businesses` voice columns. ONE allowlist entry, no fourth branch.
    expect(isProtectedOwnerApiRoute('/api/operator')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/turns')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/turns/0199a0f0-0000-7000-8000-000000000001')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/conversation')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/proposals/0199a0f0-0000-7000-8000-000000000002/apply')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/proposals/0199a0f0-0000-7000-8000-000000000002/decline')).toBe(true);
    // Normalization still applies — the gate must not be casing-bypassable.
    expect(isProtectedOwnerApiRoute('/API/Operator/Turns')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/')).toBe(true);
    // And it must not swallow a neighbouring prefix.
    expect(isProtectedOwnerApiRoute('/api/operators')).toBe(false);
    // isProtectedRoute picks it up through isProtectedAppApiRoute, which is
    // what actually admits the request to the branch chain.
    expect(isProtectedRoute('/api/operator/turns')).toBe(true);
  });
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/shared/__tests__/protected-routes.test.ts -t "isProtectedOwnerApiRoute returns true for /api/operator"`
Expected: FAIL — `expected false to be true`.

- [ ] **Step 7: Add the allowlist arm**

In `src/lib/shared/protected-routes.ts`, inside `isProtectedOwnerApiRoute` (`src/lib/shared/protected-routes.ts:47-59`), add one arm after the `/api/settings` line (`:52`):

```ts
    // The Owner Operator API (architecture pass 2026-09-12, H1-A). ONE arm, not
    // a fourth proxy branch: branch 6 already applies getAalGate() to every
    // path this predicate admits, and a second gate would be a second place for
    // the MFA posture to drift. Nothing is needed here for the PAGE: it lives
    // at /dashboard/operator, which the `/dashboard/` prefix below already
    // admits and which proxy branch 7 already gates.
    normalized === '/api/operator' || normalized.startsWith('/api/operator/') ||
```

- [ ] **Step 8: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/lib/shared/__tests__/protected-routes.test.ts`
Expected: PASS — the whole suite, including the existing public-path matrix (which must stay false for `/api/operators`).

- [ ] **Step 9: Extract `hasImpersonationCookie` and migrate both call sites**

In `src/lib/admin/impersonation/cookie.ts`, add a type-only import at the top (after `import { getServerConfig } from '@/lib/config/server';`, `src/lib/admin/impersonation/cookie.ts:2`):

```ts
import type { NextRequest } from 'next/server';
```

and add before the final re-export (`src/lib/admin/impersonation/cookie.ts:38`):

```ts
/**
 * Is this request carrying an impersonation session? The ONE definition
 * (architecture pass 2026-09-12, H1-B) — there were two byte-identical private
 * copies, in `api/operator/turns/route.ts` and `api/settings/auto-approval/
 * route.ts`, and Run B's apply and decline routes would have made four.
 *
 * PRESENCE, not validity: the routes that call this REFUSE on presence, so an
 * unverifiable cookie must refuse too. Verifying here would mean a forged
 * cookie fails `verifyImpersonationSession`, reads as "not impersonating", and
 * the write goes through — the opposite of the intent. `verifyImpersonationSession`
 * above stays the gate for anything that ACTS on the session.
 *
 * `import type { NextRequest }`: only the shape is needed, so no runtime
 * `next/server` import enters a module the worker can reach.
 */
export function hasImpersonationCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get(COOKIE_NAME)?.value);
}
```

In `src/app/api/operator/turns/route.ts`, change the import at `:8` to:

```ts
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
```

and DELETE the private function at `:97-99`. `IMPERSONATION_COOKIE_NAME` is no longer referenced in that file.

In `src/app/api/settings/auto-approval/route.ts`, change the import at `:2` to:

```ts
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
```

and DELETE the private function at `:116-118`.

Verify: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && rg -c 'function hasImpersonationCookie' src/` → `1`.

- [ ] **Step 10: Run the existing suites that cover both migrated routes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/app/api/operator/__tests__/turns-route.test.ts src/app/api/settings/__tests__ && pnpm typecheck`
Expected: PASS, unchanged — the extraction is behaviour-preserving and both suites already assert the 409.

- [ ] **Step 11: Write the failing apply-route tests (titles 22–25)**

Replace `src/app/api/operator/__tests__/apply-route.test.ts` with:

```ts
// Orchestration seams for POST /api/operator/proposals/:id/apply.
//
// `applyProposal` is MOCKED: the module's own behaviour is T1's subject and is
// proven against a live database there. What is under test here is the gate
// ORDER (flag → same-origin → writable owner → impersonation → parse) and the
// result-kind → status-code map, which is the only thing the route owns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockApply } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockWritable: vi.fn(),
  mockApply: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...a: unknown[]) => mockRequireRole(...a), AuthError };
});
vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...a: unknown[]) => mockSqlQuery(...a), {
    begin: (...a: unknown[]) => mockSqlBegin(...a),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));
vi.mock('@/lib/agents/operator/apply', () => ({
  applyProposal: (...a: unknown[]) => mockApply(...a),
}));

import { POST } from '../proposals/[id]/apply/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const PROPOSAL = '00000000-0000-7000-8000-0000000000p1'.replace('p', '0');
const ORIGIN = 'https://app.repworth.test';

const TOKEN = { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' };
const PROPOSAL_VIEW = { id: PROPOSAL, status: 'applied', receipt: { version: 1 } };

function request(
  body: unknown = { expectedVersionToken: TOKEN },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/apply`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: PROPOSAL }) };

describe('POST /api/operator/proposals/[id]/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // withSameOrigin() compares Origin against NEXT_PUBLIC_APP_URL, which
    // vitest.setup.ts defaults to http://localhost:3000 — without this every
    // request above would 403 on the app URL rather than on the case at hand.
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockApply.mockResolvedValue({ kind: 'applied', proposal: PROPOSAL_VIEW, repeated: false });
  });

  it('POST apply returns 404 operator_disabled before auth when the flag is off', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';

    const response = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'operator_disabled' });
    // BEFORE auth and before any read: off means the surface does not exist.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply rejects a missing or mismatched Origin before any read', async () => {
    const missing = new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/apply`, {
      method: 'POST',
      headers: { host: 'app.repworth.test', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersionToken: TOKEN }),
    });
    const missingResponse = await POST(missing, { params: Promise.resolve({ id: PROPOSAL }) });
    expect(missingResponse.status).toBe(403);
    expect(await missingResponse.json()).toEqual({ error: 'forbidden' });

    const mismatched = await POST(
      request(undefined, { origin: 'https://evil.example' }),
      { params: Promise.resolve({ id: PROPOSAL }) },
    );
    expect(mismatched.status).toBe(403);

    // BEFORE ANY READ: the wrapper runs outside the handler, so neither the
    // flag read nor the auth gate nor the module was reached.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply rejects an impersonated session with 409 impersonation_not_allowed', async () => {
    const response = await POST(
      request(undefined, { cookie: 'rw_impersonation=session-1.deadbeef' }),
      { params: Promise.resolve({ id: PROPOSAL }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'impersonation_not_allowed' });
    // An admin impersonating an owner may LOOK, never act — the same rule and
    // the same token PATCH /api/settings/auto-approval enforces. It runs before
    // the body parse, so a malformed body from an impersonated session still
    // answers 409 and not 400.
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409', async () => {
    const applied = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ proposal: PROPOSAL_VIEW });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0]![1]).toEqual({
      proposalId: PROPOSAL,
      accountId: ACCOUNT,
      actorUserId: 'user-1',
      expectedVersionToken: TOKEN,
    });

    mockApply.mockResolvedValue({ kind: 'stale', proposal: { id: PROPOSAL, status: 'stale' } });
    const stale = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(stale.status).toBe(409);
    // EVERY non-404 body carries the row, so the card re-renders from what the
    // server stored rather than from the browser's reading of a status code.
    expect(await stale.json()).toEqual({
      error: 'proposal_stale',
      proposal: { id: PROPOSAL, status: 'stale' },
    });

    mockApply.mockResolvedValue({
      kind: 'rejected',
      reason: 'contract_changed',
      proposal: { id: PROPOSAL, status: 'rejected' },
    });
    const rejected = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: 'contract_changed',
      proposal: { id: PROPOSAL, status: 'rejected' },
    });

    mockApply.mockResolvedValue({ kind: 'not_found' });
    const notFound = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'proposal_not_found' });

    mockApply.mockResolvedValue({
      kind: 'not_pending',
      status: 'superseded',
      proposal: { id: PROPOSAL, status: 'superseded' },
    });
    const notPending = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(notPending.status).toBe(409);
    expect(await notPending.json()).toEqual({
      error: 'proposal_not_pending',
      proposal: { id: PROPOSAL, status: 'superseded' },
    });

    mockApply.mockResolvedValue({ kind: 'failed', proposal: { id: PROPOSAL, status: 'failed' } });
    const failed = await POST(request(), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: 'apply_failed',
      proposal: { id: PROPOSAL, status: 'failed' },
    });

    // A malformed id is a 404, not a 400: the same answer another account's
    // proposal gets, so the shape of the id tells the caller nothing.
    const malformed = await POST(request(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'proposal_not_found' });

    // A body with no token, or one carrying slice 2's `confirmationLevel`, is
    // 400: the schema is `.strict()` and no Run B operation takes confirmation.
    const noToken = await POST(request({}), { params: Promise.resolve({ id: PROPOSAL }) });
    expect(noToken.status).toBe(400);
    const extra = await POST(
      request({ expectedVersionToken: TOKEN, confirmationLevel: '5 star only' }),
      { params: Promise.resolve({ id: PROPOSAL }) },
    );
    expect(extra.status).toBe(400);
  });
});

void context;
```

Delete the trailing `void context;` and the unused `context` constant if the implementer prefers; they exist only so the shared `context` shape is visible in one place while every case builds its own (a `Promise` in `params` is consumed once).

- [ ] **Step 12: Write the failing decline-route tests (titles 26, 27)**

Replace `src/app/api/operator/__tests__/decline-route.test.ts` with:

```ts
// Orchestration seams for POST /api/operator/proposals/:id/decline. Same shim
// as the apply route's suite; `declineProposal` is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockDecline } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockWritable: vi.fn(),
  mockDecline: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...a: unknown[]) => mockRequireRole(...a), AuthError };
});
vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...a: unknown[]) => mockSqlQuery(...a), {
    begin: (...a: unknown[]) => mockSqlBegin(...a),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));
vi.mock('@/lib/agents/operator/proposals', () => ({
  declineProposal: (...a: unknown[]) => mockDecline(...a),
}));

import { POST } from '../proposals/[id]/decline/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const PROPOSAL = '00000000-0000-7000-8000-000000000021';
const ORIGIN = 'https://app.repworth.test';
const DECLINED = { id: PROPOSAL, status: 'rejected', failureReason: null };

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/decline`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', ...headers },
  });
}

const params = () => ({ params: Promise.resolve({ id: PROPOSAL }) });

describe('POST /api/operator/proposals/[id]/decline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockDecline.mockResolvedValue({ kind: 'rejected', proposal: DECLINED, repeated: false });
  });

  it('POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    const disabled = await POST(request(), params());
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: 'operator_disabled' });
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();

    process.env.OWNER_OPERATOR_ENABLED = 'true';
    const mismatched = await POST(request({ origin: 'https://evil.example' }), params());
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toEqual({ error: 'forbidden' });
    // The wrapper runs outside the handler, so nothing downstream was reached.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();

    // Impersonation is refused here too: an admin may look, never act.
    const impersonated = await POST(
      request({ cookie: 'rw_impersonation=session-1.deadbeef' }),
      params(),
    );
    expect(impersonated.status).toBe(409);
    expect(await impersonated.json()).toEqual({ error: 'impersonation_not_allowed' });
  });

  it("POST decline returns 200 with the rejected proposal and 404 for another account's proposal", async () => {
    const ok = await POST(request(), params());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ proposal: DECLINED });
    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockDecline.mock.calls[0]![1]).toEqual({
      proposalId: PROPOSAL,
      accountId: ACCOUNT,
      actorUserId: 'user-1',
    });

    // A repeat decline is the same 200 with the same row (D5, idempotent).
    mockDecline.mockResolvedValue({ kind: 'rejected', proposal: DECLINED, repeated: true });
    const again = await POST(request(), params());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ proposal: DECLINED });

    // Another account's proposal: the module's account predicate matched
    // nothing, and the route answers exactly what an unknown id answers.
    mockDecline.mockResolvedValue({ kind: 'not_found' });
    const foreign = await POST(request(), params());
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'proposal_not_found' });

    // A malformed id is the same 404, decided before the module is called.
    mockDecline.mockClear();
    const malformed = await POST(request(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(malformed.status).toBe(404);
    expect(mockDecline).not.toHaveBeenCalled();

    mockDecline.mockResolvedValue({
      kind: 'not_pending',
      status: 'applied',
      proposal: { id: PROPOSAL, status: 'applied' },
    });
    const applied = await POST(request(), params());
    expect(applied.status).toBe(409);
    expect(await applied.json()).toEqual({
      error: 'proposal_not_pending',
      proposal: { id: PROPOSAL, status: 'applied' },
    });
  });
});
```

- [ ] **Step 13: Run both route suites to make sure they fail**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/app/api/operator/__tests__/apply-route.test.ts src/app/api/operator/__tests__/decline-route.test.ts`
Expected: FAIL at collection — `Failed to resolve import "../proposals/[id]/apply/route"` and the decline equivalent.

- [ ] **Step 14: Write the apply route**

Create `src/app/api/operator/proposals/[id]/apply/route.ts`:

```ts
// POST /api/operator/proposals/:id/apply — composition root. Parse, call one
// module function, map the result. Invariant #1: this file never imports the
// LLM seam, the cost guard or the worker queue registry. Invariant #15: it
// imports the `sql` singleton and passes it down; the module never does.
//
// Gate ORDER matters and is the same as POST /api/operator/turns:
//   withSameOrigin (the wrapper, outside the handler)
//     → flag         — off means the surface does not exist
//     → writable owner
//     → impersonation — an admin may LOOK, never act
//     → id + body parse
//     → one module call
// Every check is revalidated INSIDE `applyProposal`'s transaction with the
// rows locked; these are the cheap refusals, not the authority.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyProposal } from '@/lib/agents/operator/apply';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { VoiceVersionTokenSchema } from '@/lib/agents/operator/version-token';
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
import { errorResponse, jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

/**
 * `.strict()` and no `confirmationLevel`. Spec §5.1 lists an optional
 * `confirmationLevel` for the auto-approval expansion cards — those operations
 * are slice 2 and are not registered in the catalog, so accepting the field now
 * would mean silently ignoring a confirmation the caller believes was checked.
 * A 400 is the honest answer until an operation exists that reads it.
 */
const ApplyBodySchema = z.object({
  expectedVersionToken: VoiceVersionTokenSchema,
}).strict();

async function postApply(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);

  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;

  if (hasImpersonationCookie(request)) {
    return errorResponse('impersonation_not_allowed', 409);
  }

  const { id } = await context.params;
  // A malformed id is a 404, not a 400: it is the same answer another
  // account's proposal gets, so the shape of the id tells the caller nothing.
  if (!z.uuid().safeParse(id).success) return errorResponse('proposal_not_found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_body', 400);
  }
  const parsed = ApplyBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.issues[0]?.message ?? 'invalid_body' }, 400);
  }

  try {
    const result = await applyProposal(sql, {
      proposalId: id,
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      expectedVersionToken: parsed.data.expectedVersionToken,
    });

    // Every non-404 body carries `proposal`, so the card re-renders from the
    // row the server actually stored rather than from the browser's reading of
    // a status code.
    switch (result.kind) {
      case 'applied':
        return jsonResponse({ proposal: result.proposal });
      case 'stale':
        return jsonResponse({ error: 'proposal_stale', proposal: result.proposal }, 409);
      case 'rejected':
        return jsonResponse({ error: result.reason, proposal: result.proposal }, 409);
      case 'not_pending':
        return jsonResponse({ error: 'proposal_not_pending', proposal: result.proposal }, 409);
      case 'failed':
        // The executor refused DETERMINISTICALLY and the refusal committed
        // (D12). 500 rather than 409: nothing the owner can change makes this
        // succeed, and the stored row says `write_failed`.
        return jsonResponse({ error: 'apply_failed', proposal: result.proposal }, 500);
      case 'not_found':
        return errorResponse('proposal_not_found', 404);
      default: {
        // Exhaustiveness guard: a new ApplyResult kind fails typecheck here
        // instead of falling out of the switch with no return.
        const _never: never = result;
        return errorResponse('apply_failed', 500);
      }
    }
  } catch (error) {
    // Ids only — never the Receipt, the owner text or the proposal body
    // (invariant 11). A THROWN executor lands here: the transaction already
    // rolled back and the proposal is still pending (D12).
    reportCaughtError('api/operator/proposals/[id]/apply POST', error, { proposalId: id });
    return errorResponse('apply_failed', 500);
  }
}

export const POST = withSameOrigin()(postApply);
```

- [ ] **Step 15: Write the decline route**

Create `src/app/api/operator/proposals/[id]/decline/route.ts`:

```ts
// POST /api/operator/proposals/:id/decline — composition root. Same gates and
// the same order as the apply route; "Not now" is a write, so it earns the
// same same-origin, writable-owner and impersonation refusals.
//
// NO BODY. A Decline records the actor and nothing else (plan decision D5), so
// there is nothing to parse and nothing a caller could send that this route
// would honour.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { declineProposal } from '@/lib/agents/operator/proposals';
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
import { errorResponse, jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

async function postDecline(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);

  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;

  if (hasImpersonationCookie(request)) {
    return errorResponse('impersonation_not_allowed', 409);
  }

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return errorResponse('proposal_not_found', 404);

  try {
    const result = await declineProposal(sql, {
      proposalId: id,
      accountId: owner.accountId,
      actorUserId: owner.user.id,
    });

    switch (result.kind) {
      case 'rejected':
        // `repeated` is not surfaced: a second "Not now" produced the same row
        // and the owner has no decision to make about which call won.
        return jsonResponse({ proposal: result.proposal });
      case 'not_pending':
        return jsonResponse({ error: 'proposal_not_pending', proposal: result.proposal }, 409);
      case 'not_found':
        return errorResponse('proposal_not_found', 404);
      default: {
        const _never: never = result;
        return errorResponse('decline_failed', 500);
      }
    }
  } catch (error) {
    reportCaughtError('api/operator/proposals/[id]/decline POST', error, { proposalId: id });
    return errorResponse('decline_failed', 500);
  }
}

export const POST = withSameOrigin()(postDecline);
```

- [ ] **Step 16: Run both route suites to make sure they pass**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/app/api/operator`
Expected: PASS — the two new suites plus the three Run A route suites, unchanged.

- [ ] **Step 17: Convert title 28 into a failing test**

Replace the `describe('GET /api/operator/conversation — location scoping', …)` todo block in `src/app/api/operator/__tests__/conversation-route.test.ts` with a real case, reusing that file's existing shim, which already mocks `@/lib/db/auth` (`src/app/api/operator/__tests__/conversation-route.test.ts:9-17`), `@/lib/db/server` (`:18`) and `@/lib/agents/operator/reads` behind `mockGetConversationForOwner` (`:4-7`, `:19-21`) — nothing new to wire:

```ts
describe('GET /api/operator/conversation — location scoping', () => {
  const LOCATION = '00000000-0000-7000-8000-00000000b101';

  // ITS OWN SETUP. The file's existing `beforeEach` is scoped to the first
  // `describe` (src/app/api/operator/__tests__/conversation-route.test.ts:29-33),
  // so without this block `mockRequireRole` returns `undefined`, the route
  // answers 401, and every assertion below fails for the wrong reason.
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
  });

  it('GET conversation scopes the summary to ?locationId= when the conversation has no turns', async () => {
    mockGetConversationForOwner.mockResolvedValue({
      conversation: { id: '00000000-0000-7000-8000-00000000c001', lastTurnAt: null },
      turns: [],
      summary: {
        pending: { pendingCount: 2, draftsWaiting: 2 },
        recent: { posted7d: 9, reportingPeriodDays: 7 },
        rules: { threshold: null, vetoWindowMinutes: 15, dailyCap: 5, locationOverrideExists: false },
        facts: null,
        pendingProposals: [],
        connectionStatus: 'active',
        asOf: '2026-09-12T10:00:00.000Z',
      },
    });

    const response = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?locationId=${LOCATION}`,
    ));

    expect(response.status).toBe(200);
    expect(mockGetConversationForOwner).toHaveBeenCalledTimes(1);
    // The module gets the location; the ROUTE does not resolve it, decide what
    // it means, or fall back to one.
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toMatchObject({ locationId: LOCATION });

    // A malformed value is a 404, matching this route's own `?id` rule — never
    // a 400 that distinguishes "badly shaped" from "not yours".
    mockGetConversationForOwner.mockClear();
    const malformed = await GET(new NextRequest(
      'https://app.repworth.test/api/operator/conversation?locationId=not-a-uuid',
    ));
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'location_not_found' });
    expect(mockGetConversationForOwner).not.toHaveBeenCalled();

    // Absent: the module is called with no locationId at all, which is Run A's
    // behaviour unchanged (the summary is scoped to the latest turn, or null).
    mockGetConversationForOwner.mockClear();
    mockGetConversationForOwner.mockResolvedValue({
      conversation: { id: '00000000-0000-7000-8000-00000000c001', lastTurnAt: null },
      turns: [],
      summary: null,
    });
    const bare = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(bare.status).toBe(200);
    expect(mockGetConversationForOwner.mock.calls[0]![1].locationId).toBeUndefined();
  });
});
```

- [ ] **Step 18: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/app/api/operator/__tests__/conversation-route.test.ts -t "GET conversation scopes the summary"`
Expected: FAIL — the route passes no `locationId`, and `?locationId=not-a-uuid` returns 200.

- [ ] **Step 19: Deepen `reads.ts`**

In `src/lib/agents/operator/reads.ts`, add `locationId` to `OwnerConversationTurn` (after `failureReason`, `src/lib/agents/operator/reads.ts:109`):

```ts
  /**
   * The turn's STORED location. The card's target is rendered from THIS, never
   * from the browser's selector (spec §3.3), and the screen compares it against
   * the current scope to decide whether to show "Prepared for <location>" (D4).
   */
  locationId: string;
  /**
   * This turn's **Requested capability** rows. DURABLE, exactly like the
   * proposals beside them: rendering them only from the in-flight poll meant
   * the card vanished on the next reload or the next send while the row was
   * still in the table (RB-07). Read in ONE batched `listUnsupportedForTurns`.
   */
  unsupported: UnsupportedView[];
```

Add `listUnsupportedForTurns` and `type UnsupportedView` to the existing
`./proposals` import list (`src/lib/agents/operator/reads.ts:23-30`), read them
in sequence beside the proposals (`src/lib/agents/operator/reads.ts:199-202`):

```ts
  // Sequential, beside the proposals read — ci:pool-fanout forbids a Promise
  // combinator over DB-issuing elements.
  const unsupportedByTurn = await listUnsupportedForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });
```

and map both in the `turns` projection (`:204-217`), beside `failureReason`:

```ts
    locationId: turn.location_id,
    unsupported: unsupportedByTurn.get(turn.id) ?? [],
```

Add `connectionStatus` to `OwnerConversationSummary` (after `pendingProposals`, `:128`):

```ts
  /**
   * The location's Google connection, as the latest `zernio_connections` row
   * reports it — `'pending' | 'active' | 'disconnected'`, or `null` when the
   * location has never been connected. Account-scoped through `businesses`.
   *
   * The panel shows the existing connect call to action when this is not
   * `'active'` (spec §3.1). It does NOT gate the composer: a settings
   * conversation is not a posting action, and refusing to talk because Google
   * is disconnected would block the very conversation that explains it.
   */
  connectionStatus: 'pending' | 'active' | 'disconnected' | null;
```

Widen the input and the scoping in `getConversationForOwner` (`:156-159`):

```ts
export async function getConversationForOwner(
  sql: Sql,
  input: {
    accountId: string;
    actorUserId: string;
    conversationId?: string;
    /**
     * D2. Used ONLY when the conversation has no turns yet: the panel has no
     * turn to scope to, but the browser knows which location is selected. An
     * id that is not an active member of the account scopes nothing and the
     * summary stays `null` — additive to Run A's rule, never a replacement for
     * the latest-turn scoping, which still wins whenever a turn exists.
     */
    locationId?: string;
  },
): Promise<OwnerConversationView | null> {
```

Replace the `latest` block (`:192-225`) with:

```ts
  // The panel is scoped to the MOST RECENT turn's location: the selector may
  // have moved since, and the transcript's own target is what the owner is
  // looking at. With no turns yet there is nothing to scope to — unless the
  // caller named a location (D2), in which case the empty screen can still
  // show the panel for what the owner has selected.
  const latest = turnRows[turnRows.length - 1];
  const locations = await getLocationsForAccount(sql, input.accountId);
  // ONE `turn_id = ANY(...)` read for the whole transcript, not one per turn.
  // Both of these, and sequentially — ci:pool-fanout forbids a Promise
  // combinator over DB-issuing elements.
  const proposalsByTurn = await listProposalsForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });
  const unsupportedByTurn = await listUnsupportedForTurns(sql, {
    turnIds: turnRows.map((turn) => turn.id),
    accountId: input.accountId,
  });

  const turns: OwnerConversationTurn[] = turnRows.map((turn) => ({
    id: turn.id,
    sequence: turn.sequence,
    status: asTurnStatus(turn.status),
    failureReason: turn.failure_reason,
    locationId: turn.location_id,
    ownerText: turn.owner_text,
    // A pure mapping: no metrics and no index resolution, because every stored
    // `status` segment already carries its value and every stored `proposal`
    // segment already carries its id.
    segments: renderSegments(parseReplySegments(turn.reply), {
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
    }),
    proposals: proposalsByTurn.get(turn.id) ?? [],
    // RB-07: DURABLE, like the proposals beside them. The client maps this
    // unconditionally, so every `OwnerConversationTurn` this function builds
    // must carry it — a turn with none carries `[]`, never `undefined`.
    unsupported: unsupportedByTurn.get(turn.id) ?? [],
  }));

  // The turn's location is trusted (it was validated at POST). A CALLER-SUPPLIED
  // one is not, so it is checked for active membership before anything is
  // scoped to it — the alternative is a panel of account-scoped zeros for an
  // id that belongs to nobody, which reads as "nothing to report" rather than
  // "not your location".
  const summaryLocationId = latest
    ? latest.location_id
    : input.locationId === undefined
      ? null
      : await activeLocationId(sql, input.accountId, input.locationId);

  if (summaryLocationId === null) {
    return {
      conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
      turns,
      summary: null,
    };
  }
```

**And make `conversation` nullable, for the FIRST-TIME owner (RB-09).** In `OwnerConversationView` (`src/lib/agents/operator/reads.ts:132-144`):

```ts
export interface OwnerConversationView {
  /**
   * `null` for a first-time owner. `createTurn` makes the conversation row
   * TOGETHER with the first turn (`src/lib/agents/operator/turns.ts:120-180`)
   * and nothing creates an empty one, so "no row" is what every owner looks
   * like before they have said anything — the normal state, not an error. The
   * summary panel and the connect call to action are most useful at exactly
   * that moment, and a 404 would hide both.
   */
  conversation: { id: string; lastTurnAt: string | null } | null;
```

Then replace the early return at `src/lib/agents/operator/reads.ts:175`:

```ts
  if (!conversation) {
    // A caller that named a SPECIFIC conversation and missed still gets null,
    // which the route renders as 404. Unchanged.
    if (input.conversationId !== undefined) return null;
    // A caller that named a LOCATION and has no conversation yet gets the
    // empty view with a scoped summary.
    if (input.locationId === undefined) return null;
    const firstLocationId = await activeLocationId(sql, input.accountId, input.locationId);
    if (firstLocationId === null) return null;
    return {
      conversation: null,
      turns: [],
      summary: await readSummary(sql, {
        accountId: input.accountId,
        conversationId: null,
        locationId: firstLocationId,
      }),
    };
  }
```

To keep ONE summary builder rather than two that can drift, extract the block that builds `summary` (`src/lib/agents/operator/reads.ts:227-273`) into a private `readSummary(sql, { accountId, conversationId, locationId }): Promise<OwnerConversationSummary>` at the end of the file, and call it from BOTH paths. Its body is the existing sequence unchanged — `getPendingApprovalCountsForAccount`, `readPosted7d`, `getAutoApprovalSettings`, `readVoiceConfig`, `listPendingProposals`, `readConnectionStatus`, then `projectOperatingRules` — with `summaryLocationId` renamed to the parameter. `conversationId` is `string | null`; when it is `null` the `listPendingProposals` read is SKIPPED and `pendingProposals` is `[]`, because a conversation that does not exist has none.

Then, in the summary block below it, replace every `latest.location_id` with `summaryLocationId` (three sites: `readPosted7d`, `readVoiceConfig`, `projectOperatingRules`) and the `pendingByLocation.get(latest.location_id)` lookup, and add the connection read after `pendingProposals` (`:249-252`):

```ts
  const connectionStatus = await readConnectionStatus(sql, {
    accountId: input.accountId,
    locationId: summaryLocationId,
  });
```

and add `connectionStatus` to the returned `summary` object, after `pendingProposals`.

Finally add the two private helpers beside `nullableIso` at the end of the file (`:276-278`):

```ts
/**
 * Is this location an active member of the account? One statement, and the
 * only reason it exists is that `input.locationId` comes from a query string.
 */
async function activeLocationId(
  sql: Sql,
  accountId: string,
  locationId: string,
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;
  return row?.id ?? null;
}

/**
 * The location's latest `zernio_connections` row.
 *
 * Account-scoped THROUGH `businesses` — `zernio_connections` has no
 * `account_id` of its own, so the join is the tenant proof (`ci:tenant-scope`);
 * the same shape `src/lib/account-offboarding/snapshot.ts:113` uses.
 *
 * `ORDER BY created_at DESC LIMIT 1` rather than a status filter: disconnected
 * rows are kept for audit (migration 026's soft-delete model), so "the latest
 * row" is the only thing that means "the current state", and a location that
 * has never connected correctly returns `null` rather than `'disconnected'`.
 */
async function readConnectionStatus(
  sql: Sql,
  input: { accountId: string; locationId: string },
): Promise<'pending' | 'active' | 'disconnected' | null> {
  const [row] = await sql<{ status: string }[]>`
    SELECT zc.status
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    WHERE zc.business_id = ${input.locationId}::uuid
      AND b.account_id = ${input.accountId}::uuid
    ORDER BY zc.created_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  if (row.status === 'pending' || row.status === 'active' || row.status === 'disconnected') {
    return row.status;
  }
  // migration 026's CHECK admits exactly those three, so anything else is a
  // row this codebase did not write.
  throw new Error('agents/operator: zernio_connections.status holds a value no writer produces');
}
```

Both reads are awaited in SEQUENCE beside the existing ones — `ci:pool-fanout` forbids a `Promise` combinator over DB-issuing elements, and the sequential comment at `src/lib/agents/operator/reads.ts:234-235` explains why.

- [ ] **Step 20: Add `?locationId=` to the conversation route**

In `src/app/api/operator/conversation/route.ts`, after the existing `?id` validation (`src/app/api/operator/conversation/route.ts:30-33`):

```ts
  // D2. Optional and ADDITIVE: the module uses it only when the conversation
  // has no turns yet. A malformed value is the same 404 a foreign one gets, for
  // the same reason `?id` is — the shape of the id tells the caller nothing.
  const rawLocationId = request.nextUrl.searchParams.get('locationId');
  if (rawLocationId !== null && !z.uuid().safeParse(rawLocationId).success) {
    return errorResponse('location_not_found', 404);
  }
```

and pass it through, changing the module call (`:39-43`) to:

```ts
    const view: OwnerConversationView | null = await getConversationForOwner(sql, {
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      conversationId: rawId ?? undefined,
      locationId: rawLocationId ?? undefined,
    });
```

The existing `if (!view) return errorResponse('conversation_not_found', 404);` (`src/app/api/operator/conversation/route.ts:44`) stays EXACTLY as it is, and that is the point: RB-09 moved the first-time-owner case out of `null` and into a view whose `conversation` is `null`, so it now flows through the `jsonResponse(view)` on the next line and answers **200** with an empty transcript and a scoped summary. Only a `?id=` that matched nothing, or a `?locationId=` that is not an active location of the account, still reaches the 404. Add a one-line comment above the guard saying so, so the next reader does not "fix" it back.

- [ ] **Step 21: Prove the first-time-owner path against the live database (RB-09)**

The empty view is a DATABASE fact — "this account has no `agent_conversations`
row" — and a mocked read cannot answer it. Append to
`src/lib/agents/operator/__tests__/reads.integration.test.ts`, inside its
existing `describeWithDb` block (which already seeds two accounts, two
locations and cleans every operator row in `afterEach`, so "no conversations"
holds at the start of every case):

```ts
    it('first-time owner receives a scoped summary and connection CTA before sending', async () => {
      // NO conversation row exists — the normal state before the owner's first
      // message, because `createTurn` creates the conversation together with
      // the first turn (src/lib/agents/operator/turns.ts:120-180) and nothing creates an empty one.
      const [{ count: conversations }] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM agent_conversations
        WHERE account_id = ${tenant.accountId}::uuid
      `;
      expect(conversations).toBe(0);

      const view = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        locationId,
      });

      // 200-shaped, not null: the route renders this as a 200 with an empty
      // transcript, which is what puts the panel on screen before the owner
      // has said anything.
      expect(view).not.toBeNull();
      expect(view!.conversation).toBeNull();
      expect(view!.turns).toEqual([]);
      expect(view!.summary).not.toBeNull();

      const summary = view!.summary!;
      // The summary is scoped to the location the BROWSER selected, not to a
      // turn that does not exist.
      expect(summary.facts).not.toBeNull();
      expect(summary.recent.reportingPeriodDays).toBe(RECENT_COMPLETED_DAYS);
      expect(typeof summary.asOf).toBe('string');
      // A location that has never been connected reports `null`, and the panel
      // shows the connect call to action for anything that is not `active`.
      expect(summary.connectionStatus).toBeNull();
      // No conversation means no pending proposals, and no query for them.
      expect(summary.pendingProposals).toEqual([]);

      // A location that is NOT this account's is still null overall, which the
      // route renders as 404 — the empty view is not a way to probe.
      const foreign = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
        locationId: otherLocationId,
      });
      expect(foreign).toBeNull();

      // And WITHOUT a location there is nothing to scope to: still null.
      const bare = await getConversationForOwner(db, {
        accountId: tenant.accountId,
        actorUserId: tenant.userId,
      });
      expect(bare).toBeNull();
    });
```

Add `RECENT_COMPLETED_DAYS` to that file's `../context` import — no other import changes.

**And narrow the nullable `conversation` in the suite's EXISTING cases.** `OwnerConversationView.conversation` is now `{ … } | null`, so the three unguarded `.id` reads at `src/lib/agents/operator/__tests__/reads.integration.test.ts:319`, `:325` and `:335` stop typechecking. Add a one-line narrowing helper beside the file's other helpers and route those three reads (and any other `view.conversation.…` this run introduces) through it:

```ts
/**
 * `OwnerConversationView.conversation` became nullable in Run B: a first-time
 * owner with no conversation row gets `{ conversation: null, … }` rather than
 * a 404 (RB-09). These cases all assert on a conversation that EXISTS, so the
 * narrowing is an assertion, not a cast — a null here is a real failure and
 * should read as one.
 */
function conversationOrThrow(view: OwnerConversationView | null): { id: string; lastTurnAt: string | null } {
  expect(view).not.toBeNull();
  expect(view!.conversation).not.toBeNull();
  return view!.conversation!;
}
```

Then `expect(forFirst!.conversation.id)` becomes `expect(conversationOrThrow(forFirst).id)`, and the same at `:325` and `:335`. Add `type OwnerConversationView` to the file's existing `../reads` import.

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run --project integration src/lib/agents/operator/__tests__/reads.integration.test.ts`
Expected: PASS, including the Run A cases, which are unaffected — the empty-view branch is reachable only when NO conversation row exists, and every Run A case creates one.

- [ ] **Step 22: Run the whole T2 surface**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run src/app/api/operator src/app/api/settings src/lib/shared/__tests__/protected-routes.test.ts src/lib/agents/operator && pnpm typecheck && pnpm lint`
Expected: PASS. `src/lib/agents/operator/__tests__/reads.integration.test.ts` is in that glob and must stay green — the latest-turn scoping path is byte-identical, and `connectionStatus` is `null` for the unconnected fixture locations.

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:db-imports && pnpm ci:pool-fanout`
Expected: PASS. `ci:tenant-scope` in particular reads the `zernio_connections` join for its account proof.

- [ ] **Step 23: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add src/lib/agents/operator/proposals.ts \
        src/lib/agents/operator/reads.ts \
        src/lib/agents/operator/__tests__/reads.integration.test.ts \
        src/lib/admin/impersonation/cookie.ts \
        src/lib/shared/protected-routes.ts \
        src/app/api/operator/proposals \
        src/app/api/operator/conversation/route.ts \
        src/app/api/operator/turns/route.ts \
        src/app/api/settings/auto-approval/route.ts \
        src/lib/shared/__tests__/protected-routes.test.ts \
        src/lib/agents/operator/__tests__/proposals.test.ts \
        src/app/api/operator/__tests__/apply-route.test.ts \
        src/app/api/operator/__tests__/decline-route.test.ts \
        src/app/api/operator/__tests__/conversation-route.test.ts
git commit -m "feat(operator): apply and decline routes, ?locationId= summary scoping, one impersonation check, /api/operator on the owner-API AAL2 gate"
```

---

### Task T3: The Operator screen shell — page, nav, state machine, composer, polling and failure wording

Runs in PARALLEL with T2. Disjoint files: T3 owns everything under `src/app/(authenticated)/` and `src/components/dashboard/`; T2 owns `src/lib/**` and `src/app/api/**`.

**Blocking edges:** T0. It calls only routes that already exist in Run A (`POST /api/operator/turns`, `GET /api/operator/turns/:id`, `GET /api/operator/conversation`), so it does not wait on T2; the `?locationId=` parameter it sends is ignored by the pre-T2 route and honoured after, which is a widening, not a break.

**Lease:** `src/app/(authenticated)/dashboard/operator/*`, `src/app/(authenticated)/layout.tsx`, `src/components/dashboard/shell/{Sidebar,MobileTabBar,active-nav}.*`, `src/components/dashboard/__tests__/*`.

**Turns green (verbatim):**
30. `operator page calls notFound when the flag is off and the nav omits the entry`
31. `operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload`
32. `operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes`
33. `operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled`
34. `operator screen disables the composer under All locations and enables it once a location is chosen`
R2. `operator times out while a poll request remains unresolved`
R5. `retry after a lost POST response resumes the original turn`
R6. `operator renders every stored segment kind in order`
R7. `terminal failures and requested capabilities survive reload and subsequent turns`
R8. `loaded conversations retain identity and starting over stays empty`
R11. `a delayed conversation response never replaces a newly submitted turn`

**Files:**
- Create: `src/app/(authenticated)/dashboard/operator/page.tsx`
- Create: `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx`
- Create: `src/app/(authenticated)/dashboard/operator/wording.ts`
- Create: `src/app/(authenticated)/dashboard/operator/operator.css`
- Create: `src/app/(authenticated)/dashboard/operator/StarterActions.tsx`
- Create (placeholder — T4 fills it): `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx`
- Create (placeholder — T4 fills it): `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx`
- Create (placeholder — T4 fills it): `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx`
- Create (placeholder — T5 fills it): `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx`
- Modify: `src/app/(authenticated)/layout.tsx:179` (flag read), `:194-200` (both nav props)
- Modify: `src/components/dashboard/shell/active-nav.ts:14` (`NavSection`), `:28-34` (`deriveNavSection`)
- Modify: `src/components/dashboard/shell/Sidebar.tsx:14-20` (props), `:139` (signature), `:169-218` (the nav row)
- Modify: `src/components/dashboard/shell/MobileTabBar.tsx:9-14` (props), `:51` (signature), `:73-107` (the tab)
- Test: `src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx` (title 30)
- Test: `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` (titles 31–34)
- Test: `src/components/dashboard/__tests__/Sidebar.test.tsx`, `src/components/dashboard/__tests__/MobileTabBar.test.tsx` (modify — the prop is required, so every existing render call must pass it)
- Test: `src/components/dashboard/shell/__tests__/active-nav.test.ts` (modify — the two `'operator'` cases join the existing `deriveNavSection` suite)

**Precedent paths:** `src/app/(authenticated)/dashboard/requests/page.tsx:13-16` (server page, `notFound()` on the flag, one client island) · `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:510-587` (the `AbortController` + timer + deadline loop, deadline checked BEFORE the `inFlight` guard) · `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:618-638` (relative-path fetch, 404/401/other mapping, abort returns null) · `src/app/(authenticated)/dashboard/connect/page.tsx:37-50` (the `<Suspense>` boundary `useSearchParams` needs) · `src/contexts/LocationContext.tsx:38-51` (`useLocationScope`) · `src/components/dashboard/__tests__/MobileTabBar.test.tsx:1-22` (the jsdom + `next/navigation` + `next/link` shim) · `src/components/dashboard/__tests__/Sidebar.test.tsx:32-55` (`wrapWithProvider`) · `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` (Suspense) and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md` (call it in the render path).

**Console (Harbor) rules this task obeys** — every class and token from `docs/brand-asset-library/design-systems/console/DESIGN.md`:
- **Card:** `className="card"` + `<h2 className="card-h2">` (`src/app/(authenticated)/_styles/console.css:1219`, `:1226`). ONE surface — fill + hairline + shadow. Never a second border, ring or glow (DESIGN.md's One Card Rule).
- **Buttons:** only `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-tertiary` exist, at `src/app/(authenticated)/_styles/console.css:1735`, `:1752`, `:1754`, `:1756`. **`.btn-sage`, `.btn-ghost`, `.btn-quiet` and `.btn-icon` are named in DESIGN.md but exist in NO stylesheet, and `.btn-danger` exists only in `src/app/(authenticated)/_styles/settings.css:680`, which this route does not import** — never write them here. `.btn` is ~36px tall with no `:focus-visible` of its own, so every action also carries `.op-action` (44px min-height + a visible teal ring), the pattern `src/app/(authenticated)/dashboard/requests/requests.css:277-289` established.
- **Layout:** `<div className="content op-surface">` (`src/app/(authenticated)/_styles/console.css:607`).
- **Type:** a display role sets BOTH `font: var(--rw-app-h2)` and `font-family: var(--rw-font-display)` — the shorthand's `var()` resolves where it is DECLARED, and `--rw-font-display` is bound on `.rw-console` by the layout's `localFont` (`src/app/(authenticated)/layout.tsx:41-52`). The idiom is `src/app/(authenticated)/_styles/console.css:1226-1229`.
- **No literals.** Every colour is `var(--rw-*)`; no amber/orange/stone; no emoji or Unicode glyph as an icon — inline SVG through `Icon.tsx` only.
- **There is no `.panel` and no bare `.stat` class** anywhere in the Console stylesheets, so this screen defines `.op-panel` and `.op-kv` in its own file rather than borrowing a name that does not exist.
- **`operator.css` loads AFTER `console.css`** and therefore wins at equal specificity. Own every `.op-*` selector there and never put one in `console.css` (the `.rq-subnav` regression, `src/app/(authenticated)/dashboard/requests/requests.css:26-30`).

**Nav decision — the Operator gets a SIXTH mobile tab, and the arithmetic says it fits.** `.mobile-tabbar` is `display: flex`, no wrap, zero horizontal padding (`src/app/(authenticated)/_styles/console.css:2500`), and `.mtab` is `flex: 1` with `padding: 8px 4px` and an 11px Figtree label (`src/app/(authenticated)/_styles/console.css:2509`). At a 390px viewport six tabs give **65.0px** each and a **57.0px** content box. `Operator` is 8 characters at ≈5.7–6.0px/char ≈ **46–48px**, inside the same box the existing widest label `Analytics` (≈51–54px) already occupies. The 44px touch floor still holds vertically (`src/app/(authenticated)/_styles/console.css:3245`) and 65px clears it horizontally. **A label of 10+ characters would not fit** — `min-width: auto` blocks shrinking below min-content and the bar does not wrap, so it would overflow rather than truncate; a seventh tab (47.7px box) would overflow outright. `Operator` is therefore the label, and the existing five-wide test (`src/components/dashboard/__tests__/MobileTabBar.test.tsx:142-148`) is updated to assert five with the flag off and six with it on, carrying this arithmetic as its comment. Icon: **`sparkle`**, an existing `IconName` (`src/components/dashboard/shell/Icon.tsx:16`) — `Icon.tsx` is NOT in the edit surface, so no new glyph is added.

**Completion evidence:** `pnpm exec vitest run "src/app/(authenticated)" src/components/dashboard` green with titles 30–34 passing; `pnpm lint`, `pnpm typecheck`, `pnpm ci:static-policy` (no new `NEXT_PUBLIC_*`) and `pnpm build` green.

- [ ] **Step 1: Write `wording.ts` — every owner-facing string, in one place**

Create `src/app/(authenticated)/dashboard/operator/wording.ts`:

```ts
// Every owner-facing string on the Operator screen, in ONE module.
//
// No `'use client'`: the server page imports the title, and a directive here
// would pull the whole file across the client boundary for no reason.
// `src/components/dashboard/shell/active-nav.ts:1-13` is the in-repo precedent
// for a shared, directive-free module both sides import.
//
// The maps below are keyed by the vocabularies the SERVER writes
// (`TURN_FAILURE_REASON`, `PROPOSAL_FAILURE_REASON`, the route error codes) and
// each has an explicit fallback, so a reason this file has not met yet reads as
// a sentence rather than as a blank card.

export const OPERATOR_TITLE = 'Operator';
export const OPERATOR_SUBTITLE = 'Tell RepWorth what to change. Nothing happens until you approve it.';

export const PREPARING = 'Preparing your plan';
export const TIMEOUT_NOTICE =
  'This is taking longer than it should. Your message is safe — you can keep waiting, or start again.';
export const KEEP_WAITING = 'Keep waiting';
export const START_NEW_CONVERSATION = 'Start a new conversation';
export const NOT_AVAILABLE = 'The Operator is not available right now. Nothing was changed.';

export const ALL_LOCATIONS_HINT =
  'Pick one location to talk about. A plan always belongs to a single location.';
export const COMPOSER_PLACEHOLDER = 'Ask for a change, or ask what needs you.';
export const SEND = 'Send';
export const SENDING = 'Sending…';
/**
 * The retry after a lost response. Deliberately NOT "Send again": the same
 * payload and the same `clientTurnKey` go back, so the server returns the
 * original turn rather than creating a second one, and the label must not
 * suggest a new message (RB-05).
 */
export const RETRY_SEND = 'Try again';

/**
 * A `status` **Reply segment**'s metric, in words, with its reporting period.
 * Total over `STATUS_METRICS` so a new metric fails typecheck here rather than
 * rendering a bare number with no noun beside it.
 */
export function statusMetricLabel(metric: string, reportingPeriodDays: number): string {
  switch (metric) {
    case 'pending_count': return 'replies are waiting for you';
    case 'drafts_waiting': return 'drafts are waiting across your locations';
    case 'posted_7d': return `replies posted in the last ${reportingPeriodDays} days`;
    default: return 'recorded';
  }
}

/** The three fixed starter messages (spec §3.1). */
export const STARTER_ACTIONS = [
  { id: 'set_up_replies', label: 'Set up replies', message: 'Help me set up how my replies should sound.' },
  { id: 'change_my_tone', label: 'Change my tone', message: 'I want to change the tone of my replies.' },
  { id: 'show_what_needs_me', label: 'Show what needs me', message: 'Show me what needs my attention right now.' },
] as const;

/**
 * One sentence per `TURN_FAILURE_REASON` member (seven). Each key is a token
 * the worker wrote; none of these is ever a provider message or owner text.
 */
export const TURN_FAILURE_WORDING: Readonly<Record<string, string>> = {
  operator_disabled: NOT_AVAILABLE,
  unauthorized: 'Your account can no longer make changes here, so this message was not run. Nothing was changed.',
  account_offboarding: 'This account is closing, so the Operator has stopped. Nothing was changed.',
  predecessor_stalled: 'An earlier message in this conversation never finished, so this one was not run. Start a new conversation to carry on.',
  model_output_invalid: 'The answer came back in a form we could not use. Nothing was changed — try asking again in your own words.',
  budget_exceeded: 'This account has reached its daily limit for AI work. Nothing was changed — try again tomorrow.',
  exhausted: 'We tried several times and could not finish this message. Nothing was changed. Start a new conversation to try again.',
};

export const TURN_FAILURE_FALLBACK = 'That message did not finish. Nothing was changed — try again.';

/**
 * Which failures are worth offering a fresh conversation for. Both are
 * conversation-level dead ends: a stalled predecessor blocks every successor in
 * the SAME conversation, and an exhausted turn has already been retried.
 */
export const OFFERS_NEW_CONVERSATION: ReadonlySet<string> = new Set([
  'predecessor_stalled',
  'exhausted',
]);

export const PROPOSAL_STALE =
  'Your settings changed after this plan was prepared, so it was not applied.';
export const REFRESH_PLAN = 'Refresh plan';
export const PROPOSAL_DECLINED = 'Not applied';
export const PROPOSAL_SUPERSEDED = 'Replaced by a newer plan';
export const PROPOSAL_APPLIED = 'Applied';
export const APPLY = 'Apply';
export const NOT_NOW = 'Not now';
export const AFFECTS_FUTURE_DRAFTS =
  'Future drafts only. Existing drafts and pending approvals are not rewritten.';
export const CANNOT_DO_YET = 'RepWorth cannot do this yet. Nothing changed.';

export const PROPOSAL_FAILURE_WORDING: Readonly<Record<string, string>> = {
  version_mismatch: PROPOSAL_STALE,
  contract_changed: 'RepWorth changed since this plan was prepared, so it must be prepared again. Nothing was applied.',
  unauthorized: 'Your account can no longer make this change. Nothing was applied.',
  account_offboarding: 'This account is closing, so changes are not accepted. Nothing was applied.',
  location_not_found: 'That location is no longer active, so the plan cannot be applied.',
  write_failed: 'We could not save that change. Nothing was applied.',
};

/** The two failure reasons a fresh plan can actually fix. */
export const OFFERS_REFRESH_PLAN: ReadonlySet<string> = new Set([
  'version_mismatch',
  'contract_changed',
]);

/** Route error codes the card and the composer have to speak. */
export const ROUTE_ERROR_WORDING: Readonly<Record<string, string>> = {
  operator_disabled: NOT_AVAILABLE,
  impersonation_not_allowed: 'You are viewing this account as an admin, so you cannot apply changes.',
  proposal_not_found: 'That plan is no longer available.',
  proposal_not_pending: 'That plan has already been decided.',
  proposal_stale: PROPOSAL_STALE,
  contract_changed: 'RepWorth changed since this plan was prepared, so it must be prepared again. Nothing was applied.',
  apply_failed: 'Something went wrong and nothing was applied. Try again.',
  decline_failed: 'Something went wrong. Try again.',
  turn_create_failed: 'We could not send that message. Nothing was changed — try again.',
  turn_key_conflict: 'That message was already sent with different wording. Start a new conversation.',
  location_not_found: 'That location is no longer active.',
  conversation_not_found: 'That conversation is no longer available.',
  forbidden: 'We could not confirm that request came from this page. Reload and try again.',
  invalid_body: 'We could not send that. Reload the page and try again.',
};

export const ROUTE_ERROR_FALLBACK = 'Something went wrong. Nothing was changed — try again.';

export function routeErrorSentence(code: string | null): string {
  if (code === null) return ROUTE_ERROR_FALLBACK;
  return ROUTE_ERROR_WORDING[code] ?? ROUTE_ERROR_FALLBACK;
}

export function turnFailureSentence(reason: string | null): string {
  if (reason === null) return TURN_FAILURE_FALLBACK;
  return TURN_FAILURE_WORDING[reason] ?? TURN_FAILURE_FALLBACK;
}

export function proposalFailureSentence(reason: string | null): string {
  if (reason === null) return PROPOSAL_DECLINED;
  return PROPOSAL_FAILURE_WORDING[reason] ?? ROUTE_ERROR_FALLBACK;
}

/** D4, exactly this sentence. */
export function preparedForNote(locationLabel: string): string {
  return `Prepared for ${locationLabel}`;
}
```

- [ ] **Step 2: Write the placeholder card and panel modules**

T4 and T5 replace these bodies; T3 creates them so the client compiles and so the two later tracers touch only their own files.

Create `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx`:

```tsx
'use client';

import type { ProposalView } from '@/lib/agents/operator/proposals';
import './operator.css';

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The turn's STORED location — the card's target, never the selector (§3.3). */
  turnLocationId: string;
  /** How to name a location on screen. Supplied by the client, which owns the roster. */
  locationLabel: (locationId: string) => string;
  /** True when the browser's current scope is not the turn's location (D4). */
  scopeMoved: boolean;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  busy: boolean;
  error: string | null;
}

/** T4 owns the body. This placeholder renders the card's identity only. */
export function ProposalCard({ proposal }: ProposalCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{proposal.describe}</h2>
    </section>
  );
}
```

Create `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx`:

```tsx
'use client';

import type { Receipt } from '@/lib/agents/operator/schema';
import './operator.css';

export interface ReceiptViewProps {
  receipt: Receipt;
  locationLabel: (locationId: string) => string;
}

/** T4 owns the body. */
export function ReceiptView({ receipt }: ReceiptViewProps) {
  return <div className="op-receipt">{receipt.operation}</div>;
}
```

Create `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx`:

```tsx
'use client';

import './operator.css';

export interface RequestedCapabilityCardProps {
  request: string;
}

/** T4 owns the body. No button, ever — a **Requested capability** is not a Proposal. */
export function RequestedCapabilityCard({ request }: RequestedCapabilityCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{request}</h2>
    </section>
  );
}
```

Create `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx`:

```tsx
'use client';

import type { OwnerConversationSummary } from '@/lib/agents/operator/reads';
import './operator.css';

export interface SummaryPanelProps {
  summary: OwnerConversationSummary | null;
  /** Shown instead of the blocks when the scope is `all` and nothing is chosen. */
  hint: string | null;
}

/** T5 owns the body. */
export function SummaryPanel({ summary, hint }: SummaryPanelProps) {
  if (summary === null) return <aside className="op-panel">{hint}</aside>;
  return <aside className="op-panel" />;
}
```

- [ ] **Step 3: Write `StarterActions.tsx`**

Create `src/app/(authenticated)/dashboard/operator/StarterActions.tsx`:

```tsx
'use client';

import { STARTER_ACTIONS } from './wording';
import './operator.css';

export interface StarterActionsProps {
  onPick: (message: string) => void;
  disabled: boolean;
}

/**
 * The three fixed starter messages (spec §3.1). Each POSTS its message rather
 * than filling the composer: the value of a starter is that the owner does not
 * have to decide how to phrase it, and a pre-filled box hands the decision
 * straight back.
 */
export function StarterActions({ onPick, disabled }: StarterActionsProps) {
  return (
    <div className="op-starters">
      {STARTER_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn btn-secondary op-action"
          disabled={disabled}
          onClick={() => onPick(action.message)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write the failing client tests (titles 31–34)**

Replace `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` with:

```tsx
// @vitest-environment jsdom
// The conversation state machine, against a mocked fetch and fake timers.
//
// `next/navigation` is mocked the way the nav suites mock it
// (src/components/dashboard/__tests__/MobileTabBar.test.tsx:6-12), with
// `useSearchParams` added so URL resumption can be driven. `useLocationScope`
// is MOCKED rather than provided: the scope is an input to these cases, and the
// real provider changes it through a router refresh this suite has no server for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pathnameMock, router, replaceMock, searchParamsMock, scopeMock, setScopeMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    pathnameMock: vi.fn<() => string>(() => '/dashboard/operator'),
    // ONE object, hoisted. `useRouter: () => ({ … })` returns a NEW object on
    // every render, so `writeUrl`'s `[router]` dependency changes identity
    // each time, every effect that depends on it is torn down and re-run, and
    // a response that triggers a state update becomes an infinite read loop
    // (RB2-06). The real `useRouter` is stable; the mock must be too.
    router: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
    replaceMock,
    searchParamsMock: { value: new URLSearchParams() },
    scopeMock: { value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string },
    setScopeMock: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => router,
  useSearchParams: () => searchParamsMock.value,
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: scopeMock.value,
    locations: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Salon', displayLabel: null, isPrimary: true },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Cafe', displayLabel: null, isPrimary: false },
    ],
    isMultiLocation: true,
    selectedLabel: 'Salon',
    setLocationScope: setScopeMock,
    setLocations: vi.fn(),
  }),
}));

import { OperatorClient } from '../OperatorClient';
import {
  PREPARING,
  RETRY_SEND,
  START_NEW_CONVERSATION,
  TURN_FAILURE_WORDING,
} from '../wording';

const SALON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAFE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROPOSAL = '99999999-9999-4999-8999-999999999999';

/** A first-time owner: RB-09's empty view, so no identity is adopted. */
const EMPTY_CONVERSATION = { conversation: null, turns: [], summary: null };

function storedTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: TURN,
    sequence: 1,
    status: 'completed',
    failureReason: null,
    locationId: SALON,
    ownerText: 'Make my replies warmer.',
    segments: [],
    proposals: [],
    unsupported: [],
    ...overrides,
  };
}

const conversationWith = (turns: unknown[]) => ({
  conversation: { id: CONVERSATION, lastTurnAt: '2026-09-12T10:00:00.000Z' },
  turns,
  summary: null,
});

function turnBody(overrides: Record<string, unknown> = {}) {
  return {
    id: TURN, status: 'accepted', failureReason: null,
    segments: [], proposals: [], unsupported: [],
    ...overrides,
  };
}

/** A fetch double routed by `METHOD url`. An unrouted call fails loudly. */
function routeFetch(handlers: Array<[RegExp, () => { status: number; body: unknown }]>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    for (const [pattern, handler] of handlers) {
      if (pattern.test(`${init?.method ?? 'GET'} ${href}`)) {
        const { status, body } = handler();
        return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
      }
    }
    throw new Error(`unrouted fetch: ${init?.method ?? 'GET'} ${href}`);
  });
}

const pollCount = (mock: ReturnType<typeof routeFetch>) =>
  mock.mock.calls.filter(([url]) => String(url).includes(`/api/operator/turns/${TURN}`)).length;

/**
 * One tick past the client's four-minute poll ceiling. Spelled here rather
 * than imported so a change to the constant shows up as a red test rather
 * than as a test that silently follows it.
 */
const POLL_DEADLINE_TEST_MS = 4 * 60 * 1_000 + 1_000;

const postBodies = (mock: ReturnType<typeof routeFetch>) =>
  mock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  searchParamsMock.value = new URLSearchParams();
  scopeMock.value = SALON;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorClient', () => {
  it('operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload', async () => {
    let turnStatus = 'accepted';
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: turnStatus }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));
    const [body] = postBodies(fetchMock);
    expect(body.locationId).toBe(SALON);
    expect(body.text).toBe('Make my replies warmer.');
    expect(typeof body.conversationId).toBe('string');
    expect(typeof body.clientTurnKey).toBe('string');

    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    await waitFor(() => {
      const url = String(replaceMock.mock.calls.at(-1)![0]);
      expect(url).toContain(`conversationId=${CONVERSATION}`);
      expect(url).toContain(`turnId=${TURN}`);
    });

    // THE RELOAD: unmount, put the ids in the URL, mount again. No second POST.
    unmount();
    fetchMock.mockClear();
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });
    render(<OperatorClient />);

    expect(await screen.findByText(PREPARING)).toBeInTheDocument();
    await waitFor(() => expect(pollCount(fetchMock)).toBeGreaterThan(0));
    expect(postBodies(fetchMock)).toHaveLength(0);

    turnStatus = 'completed';
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await waitFor(() => expect(screen.queryByText(PREPARING)).not.toBeInTheDocument());
  });

  it('operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes', async () => {
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });

    render(<OperatorClient />);
    await screen.findByText(PREPARING);

    // 0–30 s at 2 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const fast = pollCount(fetchMock);
    expect(fast).toBeGreaterThanOrEqual(13);
    expect(fast).toBeLessThanOrEqual(18);

    // 30–90 s at 5 s: roughly 12 more, not roughly 30.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const slow = pollCount(fetchMock) - fast;
    expect(slow).toBeGreaterThanOrEqual(9);
    expect(slow).toBeLessThanOrEqual(15);

    await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep waiting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: START_NEW_CONVERSATION })).toBeInTheDocument();

    const atDeadline = pollCount(fetchMock);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pollCount(fetchMock)).toBe(atDeadline);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: /keep waiting/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(pollCount(fetchMock)).toBeGreaterThan(atDeadline);
  });

  it('operator times out while a poll request remains unresolved', async () => {
    // THE CASE A RESOLVING FETCH CANNOT REACH. If `fetch` never settles, the
    // in-loop clock check never runs again and no next tick is ever scheduled,
    // so a deadline that lives inside `poll()` can never fire. Only an
    // INDEPENDENT timer ends this, and only an abort frees the request.
    let aborted = false;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        return { ok: true, status: 200, json: async () => EMPTY_CONVERSATION } as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });

    render(<OperatorClient />);
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    // One poll is in flight and will NEVER resolve.
    await waitFor(() => expect(pollCount(fetchMock as never)).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(pollCount(fetchMock as never)).toBe(1);
    expect(screen.queryByText(/taking longer than it should/i)).not.toBeInTheDocument();

    // At four minutes the independent timer fires regardless.
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
    expect(aborted).toBe(true);
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();
    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();

    // And both recovery actions WORK, not merely render.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: START_NEW_CONVERSATION }));
    expect(String(replaceMock.mock.calls.at(-1)![0])).toBe('/dashboard/operator');
    expect(screen.queryByText(/taking longer than it should/i)).not.toBeInTheDocument();
  });

  it('operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled', async () => {
    for (const [reason, sentence] of Object.entries(TURN_FAILURE_WORDING)) {
      // The failure is read from the DURABLE transcript, which is where it
      // still is after a reload — not from the in-flight poll (RB-07).
      const fetchMock = routeFetch([
        [/^GET .*\/api\/operator\/conversation/, () => ({
          status: 200,
          body: conversationWith([storedTurn({ status: 'failed', failureReason: reason })]),
        })],
      ]);
      vi.stubGlobal('fetch', fetchMock);
      searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

      const { unmount } = render(<OperatorClient />);
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      const offers = reason === 'predecessor_stalled' || reason === 'exhausted';
      expect(screen.queryByRole('button', { name: START_NEW_CONVERSATION }) !== null).toBe(offers);
      unmount();
    }

    // A 404 `operator_disabled` from ANY route: the not-available notice, and
    // the loop stops rather than hammering a surface that does not exist (D3).
    const disabled = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 404, body: { error: 'operator_disabled' } })],
    ]);
    vi.stubGlobal('fetch', disabled);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });
    render(<OperatorClient />);

    expect(await screen.findByText(/not available right now/i)).toBeInTheDocument();
    const stopped = disabled.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(disabled.mock.calls.length).toBe(stopped);
    expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
  });

  it('operator screen disables the composer under All locations and enables it once a location is chosen', async () => {
    scopeMock.value = 'all';
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(<OperatorClient />);

    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    expect(screen.getByText(/pick one location/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('locationId='))).toBe(true);

    const chooser = screen.getByRole('group', { name: /choose a location/i });
    await user.click(within(chooser).getByRole('button', { name: 'Salon' }));
    expect(setScopeMock).toHaveBeenCalledWith(SALON);

    scopeMock.value = SALON;
    rerender(<OperatorClient />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /message/i })).toBeEnabled());
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`locationId=${SALON}`))).toBe(true);
    });
  });

  it('retry after a lost POST response resumes the original turn', async () => {
    // The server COMMITS and the response is lost. A retry that allocated a
    // new clientTurnKey would create a second turn, a second conversation and
    // a second model charge; the unique constraint deduplicates only on the
    // SAME key and payload (src/lib/agents/operator/turns.ts:47-54).
    let attempt = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        return { ok: true, status: 200, json: async () => EMPTY_CONVERSATION } as Response;
      }
      if (init?.method === 'POST') {
        attempt += 1;
        if (attempt === 1) throw new TypeError('network error');
        return { ok: true, status: 200, json: async () => ({ conversationId: CONVERSATION, turnId: TURN }) } as Response;
      }
      return { ok: true, status: 200, json: async () => turnBody() } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    const retryButton = await screen.findByRole('button', { name: RETRY_SEND });
    await user.click(retryButton);

    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(2));
    const [first, second] = postBodies(fetchMock as never);
    // IDENTICAL, field for field — including the key the server deduplicates on.
    expect(second).toEqual(first);
    expect(second.clientTurnKey).toBe(first.clientTurnKey);
    expect(second.conversationId).toBe(first.conversationId);

    // The successful retry clears the retry affordance and starts polling.
    await waitFor(() => expect(screen.queryByRole('button', { name: RETRY_SEND })).not.toBeInTheDocument());
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    // A NEW message allocates a new key.
    await user.clear(screen.getByRole('textbox', { name: /message/i }));
  });

  it('operator renders every stored segment kind in order', async () => {
    const proposal = {
      id: PROPOSAL, turnId: TURN, operation: 'set_tone', contractVersion: 1,
      labelKind: 'fact', locationId: SALON, status: 'pending',
      rationale: 'You asked for warmer replies.', input: { tone: 'warm and brief' },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      describe: 'Set the reply tone to "warm and brief"',
      preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
      receipt: null, appliedAt: null, failureReason: null,
    };
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: conversationWith([storedTurn({
          proposals: [proposal],
          segments: [
            { type: 'text', text: 'Here is where things stand.' },
            // FROZEN at completion — a value, a period and an instant.
            { type: 'status', metric: 'pending_count', value: 3, reportingPeriodDays: 7, asOf: '2026-09-12T10:00:00.000Z' },
            { type: 'notice', text: '[review text removed]' },
            { type: 'scope_check', locationId: CAFE, locationName: 'Cafe' },
            { type: 'proposal', proposalId: PROPOSAL },
            { type: 'question', text: 'Shall I keep 4 and 5 stars the same?' },
          ],
        })]),
      })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    expect(await screen.findByText('Here is where things stand.')).toBeInTheDocument();
    // The STORED count and the STORED instant, not a live read.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/replies are waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText(/as of/i).querySelector('time'))
      .toHaveAttribute('datetime', '2026-09-12T10:00:00.000Z');
    expect(screen.getByText('[review text removed]')).toBeInTheDocument();
    expect(screen.getByText('Shall I keep 4 and 5 stars the same?')).toBeInTheDocument();

    // The scope_check gives the owner a CHOOSER, not a sentence.
    const scopeGroup = screen.getByRole('group', { name: /which location/i });
    await user.click(within(scopeGroup).getByRole('button', { name: 'Cafe' }));
    expect(setScopeMock).toHaveBeenCalledWith(CAFE);

    // ORDER: the card sits where its `proposal` segment referenced it —
    // after the scope check and BEFORE the question.
    const article = screen.getByText('Make my replies warmer.').closest('article')!;
    const texts = Array.from(article.querySelectorAll('p, section'))
      .map((node) => node.textContent ?? '');
    const cardAt = texts.findIndex((t) => t.includes('Set the reply tone'));
    const questionAt = texts.findIndex((t) => t.includes('Shall I keep 4 and 5 stars'));
    expect(cardAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(questionAt);
  });

  it('terminal failures and requested capabilities survive reload and subsequent turns', async () => {
    // Both are DURABLE rows. A screen that rendered them from the in-flight
    // poll lost them the moment the URL's turnId was cleared (RB-07).
    const failed = storedTurn({
      id: TURN, sequence: 1, status: 'failed', failureReason: 'exhausted',
    });
    const withCapability = storedTurn({
      id: '11111111-1111-4111-8111-111111111111',
      sequence: 2,
      ownerText: 'Stop replying on weekends.',
      unsupported: [{ id: 'u1', request: 'Stop replying on weekends', context: '' }],
    });
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200, body: conversationWith([failed, withCapability]),
      })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: 'completed' }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    // NO turnId in the URL — this is the state after a reload.
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    expect(await screen.findByText(TURN_FAILURE_WORDING.exhausted)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: START_NEW_CONVERSATION })).toBeInTheDocument();
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
    expect(screen.getByText(/cannot do this yet/i)).toBeInTheDocument();

    // Send ANOTHER turn: the earlier cards stay.
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'And make them shorter.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(screen.getByText(TURN_FAILURE_WORDING.exhausted)).toBeInTheDocument();
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
  });

  it('loaded conversations retain identity and starting over stays empty', async () => {
    // The bare GET returns the actor's LATEST conversation (src/lib/agents/operator/reads.ts:149-175).
    // Without adopting its id, the screen shows that transcript while the next
    // send opens a different conversation (RB-08).
    const unfinished = storedTurn({ status: 'running', ownerText: 'Make my replies warmer.' });
    let conversationBody: unknown = conversationWith([unfinished]);
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: conversationBody })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: 'running' }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    // Identity adopted into state AND the URL…
    await waitFor(() => {
      expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`conversationId=${CONVERSATION}`);
    });
    // …and the unfinished turn is POLLED, not left hanging.
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();
    await waitFor(() => expect(pollCount(fetchMock)).toBeGreaterThan(0));

    // STARTING OVER. The button is an offer the screen only makes once it has
    // something to recover FROM — the four-minute timeout, or a failed turn —
    // so the deadline is driven first rather than assumed (RB2-05).
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DEADLINE_TEST_MS); });
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();

    // …and now the screen empties and STAYS empty: the bare GET must not
    // immediately re-adopt the conversation just left.
    await user.click(screen.getByRole('button', { name: START_NEW_CONVERSATION }));
    expect(String(replaceMock.mock.calls.at(-1)![0])).toBe('/dashboard/operator');
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.queryByText('Make my replies warmer.')).not.toBeInTheDocument();

    // And the next send opens a NEW conversation, not the old one.
    conversationBody = EMPTY_CONVERSATION;
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Start fresh, please.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(postBodies(fetchMock).length).toBeGreaterThan(0));
    expect(postBodies(fetchMock)[0].conversationId).not.toBe(CONVERSATION);
  });

  it('a delayed conversation response never replaces a newly submitted turn', async () => {
    // THE RACE. The conversation GET is issued on mount and is slow. The owner
    // sends turn B; the POST resolves first. When the GET finally answers it
    // carries the OLDER unfinished turn A, and a callback that read the
    // `turnId` captured by its own render still sees `null` — so it would
    // adopt A, rewrite the URL to A, and cancel B's polling. The owner waits
    // forever for a reply that is no longer being polled (RB3-01).
    const TURN_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const TURN_B = TURN;
    let releaseConversation: (() => void) | null = null;
    const conversationBody = conversationWith([
      storedTurn({ id: TURN_A, status: 'running', ownerText: 'An older question.' }),
    ]);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        // HELD. Resolved by hand, after the POST.
        await new Promise<void>((resolve) => { releaseConversation = resolve; });
        return { ok: true, status: 200, json: async () => conversationBody } as Response;
      }
      if (init?.method === 'POST') {
        return {
          ok: true, status: 200,
          json: async () => ({ conversationId: CONVERSATION, turnId: TURN_B }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => turnBody({ id: TURN_B, status: 'running' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);
    await waitFor(() => expect(releaseConversation).not.toBeNull());

    // Turn B is submitted and accepted while the read is still outstanding.
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'A newer question.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(1));
    await waitFor(() => {
      expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`turnId=${TURN_B}`);
    });
    const pollsForB = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes(`/api/operator/turns/${TURN_B}`)).length;
    await waitFor(() => expect(pollsForB()).toBeGreaterThan(0));
    const before = pollsForB();

    // NOW the stale answer arrives, naming the older unfinished turn A.
    releaseConversation!();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    // B still owns the URL, and A was never adopted.
    expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`turnId=${TURN_B}`);
    expect(String(replaceMock.mock.calls.at(-1)![0])).not.toContain(TURN_A);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes(`/api/operator/turns/${TURN_A}`)),
    ).toBe(false);

    // …and B is STILL being polled, not cancelled.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(pollsForB()).toBeGreaterThan(before);
    expect(screen.getByText(PREPARING)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx"`
Expected: FAIL at collection — `Failed to resolve import "../OperatorClient"`.

- [ ] **Step 6: Write `OperatorClient.tsx`**

Create `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { useLocationScope } from '@/contexts/LocationContext';
import type { OwnerConversationTurn, OwnerConversationView } from '@/lib/agents/operator/reads';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { RenderedSegment } from '@/lib/agents/operator/render';
import { ProposalCard } from './ProposalCard';
import { RequestedCapabilityCard } from './RequestedCapabilityCard';
import { StarterActions } from './StarterActions';
import { SummaryPanel } from './SummaryPanel';
import {
  ALL_LOCATIONS_HINT,
  COMPOSER_PLACEHOLDER,
  KEEP_WAITING,
  NOT_AVAILABLE,
  OFFERS_NEW_CONVERSATION,
  OPERATOR_SUBTITLE,
  OPERATOR_TITLE,
  PREPARING,
  RETRY_SEND,
  SEND,
  SENDING,
  START_NEW_CONVERSATION,
  TIMEOUT_NOTICE,
  routeErrorSentence,
  statusMetricLabel,
  turnFailureSentence,
} from './wording';
import './operator.css';

/**
 * Poll cadence (spec §3.2 step 4). 2 s while a reply is plausibly seconds
 * away, 5 s once it clearly is not, and a HARD STOP at 4 minutes.
 *
 * The ceiling exists because of spec §14's Run B open item CA1: five
 * `OutboxPoller` dispatch failures terminalize the `job_outbox` row while the
 * turn is still `accepted`, so that turn never reaches a terminal status and a
 * loop without a deadline spins forever.
 */
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 5_000;
const POLL_BACKOFF_AFTER_MS = 30_000;
const POLL_DEADLINE_MS = 4 * 60 * 1_000;

const TURNS_PATH = '/api/operator/turns';
const CONVERSATION_PATH = '/api/operator/conversation';

type TurnView = {
  id: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  failureReason: string | null;
  segments: RenderedSegment[];
  proposals: ProposalView[];
  unsupported: Array<{ id: string; request: string; context: string }>;
};

/**
 * A POST that has been SENT but whose outcome is not yet known. Retained until
 * the response is read, and reused verbatim on a retry.
 *
 * This is the lost-response case spec §3.2 step 6 and §8.2 require: the server
 * may have committed the turn and the response may still be lost. Generating a
 * fresh `clientTurnKey` on the retry would defeat
 * `agent_turns_account_client_key_uniq` — which deduplicates only on the SAME
 * key AND payload (`src/lib/agents/operator/turns.ts:47-54`) — and create a
 * second turn, a second conversation and a second model charge.
 */
interface PendingSubmission {
  conversationId: string;
  clientTurnKey: string;
  locationId: string;
  text: string;
}

type Fetched<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'disabled' }
  | { kind: 'error'; code: string | null }
  | { kind: 'aborted' };

/**
 * A relative path and `{ signal }` only — that is what makes it same-origin,
 * and it is the shape `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:625`
 * uses. A 404 `operator_disabled` is lifted out of the error union because it
 * ends the session on screen (D3).
 */
async function getJson<T>(url: string, signal: AbortSignal): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { signal });
    if (response.ok) return { kind: 'ok', value: (await response.json()) as T };
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : null;
    if (response.status === 404 && code === 'operator_disabled') return { kind: 'disabled' };
    return { kind: 'error', code };
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    // Ids only, and there are none in this message (invariant 11).
    console.error('[operator] read could not reach the server', error);
    return { kind: 'error', code: null };
  }
}

export function OperatorClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentScope, locations, setLocationScope } = useLocationScope();

  const [conversationId, setConversationId] = useState<string | null>(
    searchParams.get('conversationId'),
  );
  const [turnId, setTurnId] = useState<string | null>(searchParams.get('turnId'));
  /**
   * The CURRENT active turn, readable at response time. `turnId` inside an
   * async callback is the value captured by the render that ISSUED the
   * request, which is stale by the time a slow conversation GET comes back
   * (RB3-01). Every decision that asks "is a turn already running?" reads the
   * ref; only rendering reads the state.
   */
  const activeTurnIdRef = useRef<string | null>(turnId);
  useEffect(() => { activeTurnIdRef.current = turnId; }, [turnId]);
  /**
   * Bumped on every successful POST. A conversation response whose captured
   * epoch is older than this one describes the world BEFORE that submission
   * and is discarded.
   */
  const loadEpochRef = useRef(0);
  const [view, setView] = useState<OwnerConversationView | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  /**
   * True after "Start a new conversation": the owner asked for an EMPTY
   * screen, so the latest-conversation load is skipped until they send. Without
   * it the bare GET immediately re-adopts the transcript they just left (RB-08).
   */
  const [fresh, setFresh] = useState(false);
  /** Bumped to restart the poll loop with a fresh deadline ("Keep waiting"). */
  const [pollEpoch, setPollEpoch] = useState(0);
  /** Bumped after a terminal turn or a card write, to refetch the transcript. */
  const [reloadEpoch, setReloadEpoch] = useState(0);
  /** The conversation read in flight, so a submission can abort it. */
  const conversationLoadRef = useRef<AbortController | null>(null);
  /** The proposal id whose write is in flight, and the last refusal per card. */
  const [cardBusyId, setCardBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  const scopedLocationId = currentScope === 'all' ? null : currentScope;
  const composerBlocked = scopedLocationId === null;

  const locationLabel = useCallback(
    (id: string) => {
      const found = locations.find((location) => location.id === id);
      return found ? getDisplayLabel(found) : 'this location';
    },
    [locations],
  );

  /** URL state, so a refresh resumes the same turn (spec §3.2 step 6). */
  const writeUrl = useCallback(
    (nextConversationId: string | null, nextTurnId: string | null) => {
      const params = new URLSearchParams();
      if (nextConversationId !== null) params.set('conversationId', nextConversationId);
      if (nextTurnId !== null) params.set('turnId', nextTurnId);
      const query = params.toString();
      // `replace`, not `push`: a poll lifecycle is not browser history.
      // `scroll: false` keeps the transcript where the owner left it.
      router.replace(
        query === '' ? '/dashboard/operator' : `/dashboard/operator?${query}`,
        { scroll: false },
      );
    },
    [router],
  );

  useEffect(() => {
    if (disabled) return;
    // The owner asked to start over. Loading "the latest conversation" here
    // would hand them the one they just left (RB-08).
    if (fresh && conversationId === null) { setView(null); return; }

    const controller = new AbortController();
    // The epoch this request belongs to. A POST that lands while it is in
    // flight bumps the counter, and the stale answer is dropped below.
    const issuedAt = loadEpochRef.current;
    conversationLoadRef.current = controller;
    void (async () => {
      const params = new URLSearchParams();
      if (conversationId !== null) params.set('id', conversationId);
      // D2 / RB-09: with no conversation the read still returns a summary
      // scoped to this location, so the panel and the connect call to action
      // are on screen before the owner's first message.
      if (scopedLocationId !== null) params.set('locationId', scopedLocationId);
      const query = params.toString();
      const result = await getJson<OwnerConversationView>(
        query === '' ? CONVERSATION_PATH : `${CONVERSATION_PATH}?${query}`,
        controller.signal,
      );
      if (result.kind === 'disabled') { setDisabled(true); return; }
      if (result.kind !== 'ok') {
        // `conversation_not_found` is a legitimate empty screen, not an error.
        if (result.kind === 'error' && result.code !== 'conversation_not_found') {
          setNotice(routeErrorSentence(result.code));
        }
        return;
      }
      // STALE ANSWER. A turn was submitted while this read was outstanding, so
      // it describes the world before that submission — including, possibly,
      // an older unfinished turn. Committing it would overwrite the transcript
      // the POST just established (RB3-01).
      if (issuedAt !== loadEpochRef.current) return;
      setView(result.value);

      const loaded = result.value.conversation;
      if (loaded === null) return;

      // TWO SEPARATE FACTS, deliberately kept apart (RB2-04).
      //
      // (a) IDENTITY. Only the bare GET has an id to adopt — without this the
      //     route shows an existing transcript while the next send opens a
      //     DIFFERENT conversation, and the two disagree about what was said.
      const adopting = conversationId === null;

      // (b) AN UNFINISHED TURN, which is true of ANY load. Tying this to (a)
      //     meant a URL that carried `?conversationId=` but no `turnId` — the
      //     state left behind by a completed poll, a shared link, or a reload
      //     after the turn id was cleared — never resumed a reply that was
      //     still running, and the screen sat silent while the worker worked.
      //
      //     THE REF, NOT THE STATE. `turnId` here is the value captured by the
      //     render that issued this request. If the owner submitted turn B
      //     while it was outstanding, that capture still reads `null`, and
      //     adopting the response's older turn A would replace B in state AND
      //     in the URL and cancel B's polling — the reply the owner is waiting
      //     for would never arrive (RB3-01). The epoch guard above catches the
      //     same race; this is the second half of the same fix, and it holds
      //     even for a response that arrives inside the same epoch.
      const latest = result.value.turns[result.value.turns.length - 1];
      const unfinished = latest && (latest.status === 'accepted' || latest.status === 'running')
        ? latest.id
        : null;
      const activeTurnId = activeTurnIdRef.current;
      const resuming = unfinished !== null && activeTurnId === null;

      if (adopting) setConversationId(loaded.id);
      if (resuming) {
        setTurnId(unfinished);
        activeTurnIdRef.current = unfinished;
      }
      // One URL write for whichever of the two happened; none when neither did,
      // so a plain refetch does not churn the history entry.
      if (adopting || resuming) {
        writeUrl(loaded.id, resuming ? unfinished : activeTurnId);
      }
    })();
    return () => controller.abort();
    // `turnId` is READ above but deliberately NOT a dependency: this effect
    // reloads the transcript, and re-running it every time the poll loop sets
    // or clears the turn id would refetch on every terminal turn twice over.
    // `reloadEpoch` is the explicit "read it again" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, fresh, conversationId, scopedLocationId, reloadEpoch, writeUrl]);

  /**
   * The poll loop, with an INDEPENDENT DEADLINE TIMER.
   *
   * The deadline is its own `setTimeout`, armed once when the loop starts, and
   * it is the only thing that can end a stuck poll. Checking the clock at the
   * top of `poll()` is not enough: if `fetch` or `response.json()` never
   * settles, `poll()` never returns, no next tick is ever scheduled, and the
   * screen spins forever with no timer left to notice. The independent timer
   * aborts the controller, which rejects the in-flight request, and shows the
   * recovery actions (RB-02). Both timers are cleared on completion and on
   * unmount.
   */
  useEffect(() => {
    if (turnId === null || disabled) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    let tick: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      stopped = true;
      if (tick !== null) clearTimeout(tick);
      tick = null;
    };

    const deadline = setTimeout(() => {
      stop();
      controller.abort();
      setTimedOut(true);
    }, POLL_DEADLINE_MS);

    const schedule = () => {
      if (stopped) return;
      const elapsed = Date.now() - startedAt;
      tick = setTimeout(
        () => void poll(),
        elapsed > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS,
      );
    };

    const poll = async () => {
      if (stopped || inFlight) { if (!stopped) schedule(); return; }
      inFlight = true;
      try {
        const result = await getJson<TurnView>(`${TURNS_PATH}/${turnId}`, controller.signal);
        if (stopped || result.kind === 'aborted') return;
        if (result.kind === 'disabled') { stop(); setDisabled(true); return; }
        if (result.kind === 'error') { schedule(); return; }

        if (result.value.status === 'completed' || result.value.status === 'failed') {
          stop();
          setTurnId(null);
          activeTurnIdRef.current = null;
          writeUrl(conversationId, null);
          // ONE transcript refetch. Everything the terminal turn produced —
          // its segments, its cards, its failure reason — is durable, and the
          // transcript is where the screen reads it from (RB-07).
          setReloadEpoch((value) => value + 1);
          return;
        }
      } finally {
        inFlight = false;
      }
      schedule();
    };

    setTimedOut(false);
    void poll();
    return () => {
      stop();
      clearTimeout(deadline);
      controller.abort();
    };
  }, [turnId, disabled, pollEpoch, conversationId, writeUrl]);

  /**
   * POSTs one submission. `submission` is built ONCE by the caller and reused
   * verbatim on a retry, so a lost response cannot become a second turn
   * (RB-05).
   */
  const post = useCallback(
    async (submission: PendingSubmission) => {
      setSending(true);
      setNotice(null);
      setPending(submission);
      try {
        const response = await fetch(TURNS_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown; conversationId?: string; turnId?: string;
        };
        if (!response.ok) {
          const code = typeof body.error === 'string' ? body.error : null;
          if (response.status === 404 && code === 'operator_disabled') { setDisabled(true); return; }
          setNotice(routeErrorSentence(code));
          return;
        }
        // THE SUBMISSION WINS. Anything the conversation read was about to say
        // predates this turn, so the epoch moves and the outstanding request is
        // abandoned before its answer can overwrite what was just established
        // (RB3-01).
        loadEpochRef.current += 1;
        conversationLoadRef.current?.abort();
        setDraft('');
        setPending(null);
        setFresh(false);
        setConversationId(body.conversationId ?? submission.conversationId);
        setTurnId(body.turnId ?? null);
        activeTurnIdRef.current = body.turnId ?? null;
        writeUrl(body.conversationId ?? submission.conversationId, body.turnId ?? null);
      } catch (error) {
        // THE LOST RESPONSE. The submission stays in `pending`, so Try again
        // re-POSTs the identical payload and the unique constraint returns the
        // original ids instead of creating a second turn.
        console.error('[operator] send could not reach the server', error);
        setNotice(routeErrorSentence(null));
      } finally {
        setSending(false);
      }
    },
    [writeUrl],
  );

  /**
   * A NEW message. `locationId` is explicit, never read from the composer
   * scope inside here — **Refresh plan** posts with the ORIGINAL turn's stored
   * location, which may not be the one selected now (RB-03).
   */
  const send = useCallback(
    (text: string, locationId: string) => {
      if (text.trim() === '' || sending) return;
      void post({
        conversationId: conversationId ?? crypto.randomUUID(),
        clientTurnKey: crypto.randomUUID(),
        locationId,
        text,
      });
    },
    [conversationId, post, sending],
  );

  /** Re-POSTs the SAME payload. Only a new message allocates a new key. */
  const retry = useCallback(() => {
    if (pending === null || sending) return;
    void post(pending);
  }, [pending, post, sending]);

  /**
   * **Refresh plan**: a new **Operator turn** from the stale Proposal's
   * ORIGINAL `owner_text` AND its original location. Both come from the stored
   * turn, never from the composer: refreshing a Salon plan while the Cafe is
   * selected must not prepare the replacement for the Cafe, and under
   * `All locations` it must still work rather than silently doing nothing.
   */
  const refreshPlan = useCallback(
    (turn: OwnerConversationTurn) => { send(turn.ownerText, turn.locationId); },
    [send],
  );

  /**
   * One POST, one re-render from the ROW the server returned. Every non-404
   * body carries `proposal`, so a refusal repaints the card with the stored
   * state instead of leaving the browser to guess what a 409 meant.
   */
  const writeProposal = useCallback(
    async (proposal: ProposalView, action: 'apply' | 'decline') => {
      if (cardBusyId !== null) return;
      setCardBusyId(proposal.id);
      setCardErrors((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      try {
        const response = await fetch(`/api/operator/proposals/${proposal.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(action === 'apply'
            ? { body: JSON.stringify({ expectedVersionToken: proposal.preparedVersionToken }) }
            : {}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown; proposal?: ProposalView;
        };
        const code = typeof body.error === 'string' ? body.error : null;
        if (response.status === 404 && code === 'operator_disabled') { setDisabled(true); return; }
        if (body.proposal !== undefined) {
          const row = body.proposal;
          setView((current) => current === null ? current : {
            ...current,
            turns: current.turns.map((turn) => ({
              ...turn,
              proposals: turn.proposals.map((p) => (p.id === row.id ? row : p)),
            })),
          });
        }
        if (!response.ok) {
          setCardErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(code) }));
        } else {
          // An Apply moved `businesses.updated_at`, so every SIBLING card on
          // this location is now stale in the database (D11).
          setReloadEpoch((value) => value + 1);
        }
      } catch (error) {
        console.error('[operator] proposal write could not reach the server', error);
        setCardErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(null) }));
      } finally {
        setCardBusyId(null);
      }
    },
    [cardBusyId],
  );

  /**
   * A fresh conversation has NO PREDECESSOR, which is the point: spec §14's
   * stranded turn (CA1) blocks every successor in the SAME conversation with
   * `predecessor_stalled`. The id is allocated client-side so the next send
   * cannot silently rejoin the old thread, and `fresh` keeps the empty screen
   * empty until then (RB-08).
   */
  const startNewConversation = useCallback(() => {
    setFresh(true);
    loadEpochRef.current += 1;
    conversationLoadRef.current?.abort();
    setConversationId(null);
    setTurnId(null);
    activeTurnIdRef.current = null;
    setPending(null);
    setView(null);
    setTimedOut(false);
    setNotice(null);
    writeUrl(null, null);
  }, [writeUrl]);

  const keepWaiting = useCallback(() => {
    setTimedOut(false);
    setPollEpoch((value) => value + 1);
  }, []);

  const transcript = view?.turns ?? [];
  const isEmpty = transcript.length === 0;
  const preparing = turnId !== null && !timedOut && !disabled;

  if (disabled) {
    return (
      <div className="content op-surface">
        <div className="card op-card" role="status">
          <h2 className="card-h2">{OPERATOR_TITLE}</h2>
          <p className="op-body">{NOT_AVAILABLE}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="content op-surface">
      <header className="op-head">
        <h1 className="page-title">{OPERATOR_TITLE}</h1>
        <p className="page-sub">{OPERATOR_SUBTITLE}</p>
      </header>

      <div className="op-layout">
        <section className="op-conversation" aria-label="Conversation">
          {isEmpty && (
            <div className="card op-card">
              <h2 className="card-h2">What would you like to change?</h2>
              <p className="op-body">{COMPOSER_PLACEHOLDER}</p>
              <StarterActions
                onPick={(message) => {
                  if (scopedLocationId !== null) send(message, scopedLocationId);
                }}
                disabled={composerBlocked || sending}
              />
            </div>
          )}

          {/* THE TRANSCRIPT IS THE SOURCE (RB-07). Failure wording and
              requested-capability cards are read from the stored turn, not
              from an in-flight poll that is gone after a reload. */}
          {transcript.map((turn) => (
            <article key={turn.id} className="op-turn">
              <p className="op-owner-text">{turn.ownerText}</p>

              <TurnBody
                turn={turn}
                locationLabel={locationLabel}
                currentScope={currentScope}
                onChooseLocation={setLocationScope}
                onApply={(row) => void writeProposal(row, 'apply')}
                onDecline={(row) => void writeProposal(row, 'decline')}
                onRefreshPlan={() => refreshPlan(turn)}
                cardBusyId={cardBusyId}
                cardErrors={cardErrors}
              />

              {turn.status === 'failed' && (
                <div className="card op-card" role="alert">
                  <p className="op-body">{turnFailureSentence(turn.failureReason)}</p>
                  {turn.failureReason !== null
                    && OFFERS_NEW_CONVERSATION.has(turn.failureReason) && (
                    <div className="op-actions">
                      <button
                        type="button"
                        className="btn btn-primary op-action"
                        onClick={startNewConversation}
                      >
                        {START_NEW_CONVERSATION}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}

          {preparing && (
            <p className="op-preparing" role="status" aria-live="polite">{PREPARING}</p>
          )}

          {timedOut && (
            <div className="card op-card" role="alert">
              <p className="op-body">{TIMEOUT_NOTICE}</p>
              <div className="op-actions">
                <button type="button" className="btn btn-secondary op-action" onClick={keepWaiting}>
                  {KEEP_WAITING}
                </button>
                <button type="button" className="btn btn-primary op-action" onClick={startNewConversation}>
                  {START_NEW_CONVERSATION}
                </button>
              </div>
            </div>
          )}

          {notice !== null && (
            <div className="card op-card" role="alert">
              <p className="op-notice">{notice}</p>
              {pending !== null && (
                <div className="op-actions">
                  {/* The SAME payload, so a committed-but-lost first attempt
                      returns the original ids instead of a second turn. */}
                  <button
                    type="button"
                    className="btn btn-secondary op-action"
                    disabled={sending}
                    onClick={retry}
                  >
                    {RETRY_SEND}
                  </button>
                </div>
              )}
            </div>
          )}

          <form
            className="op-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (scopedLocationId !== null) send(draft, scopedLocationId);
            }}
          >
            <label className="op-label" htmlFor="op-message">Message</label>
            <textarea
              id="op-message"
              className="textarea"
              placeholder={COMPOSER_PLACEHOLDER}
              value={draft}
              disabled={composerBlocked || sending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary op-action"
              disabled={composerBlocked || sending || draft.trim() === ''}
            >
              {sending ? SENDING : SEND}
            </button>
          </form>

          {composerBlocked && (
            <div className="card op-card" role="group" aria-label="Choose a location">
              <p className="op-body">{ALL_LOCATIONS_HINT}</p>
              <div className="op-actions">
                {locations.map((location) => (
                  <button
                    key={location.id}
                    type="button"
                    className="btn btn-secondary op-action"
                    onClick={() => setLocationScope(location.id)}
                  >
                    {getDisplayLabel(location)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <SummaryPanel
          summary={view?.summary ?? null}
          hint={composerBlocked ? ALL_LOCATIONS_HINT : null}
        />
      </div>
    </div>
  );
}

/**
 * One turn's reply, rendered EXHAUSTIVELY over the `RenderedSegment` union
 * (`src/lib/agents/operator/render.ts:376-382`) and in STORED ORDER.
 *
 * The union has six members and only two of them carry `text`, so a renderer
 * that printed `segment.text` dropped four kinds on the floor: a `status`
 * answer — the frozen count, its reporting period and the instant it was read,
 * which is the whole reason the value is materialized at completion — the
 * scrub `notice`, the `scope_check` chooser, and the `proposal` reference
 * itself. A `proposal` segment names WHERE its card belongs, so the card is
 * rendered AT that position; any proposal no segment references is appended
 * after the segments rather than being lost (RB-06).
 */
function TurnBody({
  turn,
  locationLabel,
  currentScope,
  onChooseLocation,
  onApply,
  onDecline,
  onRefreshPlan,
  cardBusyId,
  cardErrors,
}: {
  turn: OwnerConversationTurn;
  locationLabel: (id: string) => string;
  currentScope: string;
  onChooseLocation: (id: string) => void;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  cardBusyId: string | null;
  cardErrors: Record<string, string>;
}) {
  const byId = new Map(turn.proposals.map((proposal) => [proposal.id, proposal]));
  const placed = new Set<string>();

  const card = (proposal: ProposalView) => {
    placed.add(proposal.id);
    return (
      <ProposalCard
        key={proposal.id}
        proposal={proposal}
        turnLocationId={turn.locationId}
        locationLabel={locationLabel}
        scopeMoved={currentScope !== turn.locationId}
        onApply={onApply}
        onDecline={onDecline}
        onRefreshPlan={onRefreshPlan}
        busy={cardBusyId === proposal.id}
        error={cardErrors[proposal.id] ?? null}
      />
    );
  };

  const rendered = turn.segments.map((segment, index) => {
    const key = `${turn.id}-${index}`;
    switch (segment.type) {
      case 'text':
        return <p key={key} className="op-body">{segment.text}</p>;
      case 'question':
        return <p key={key} className="op-body op-question">{segment.text}</p>;
      case 'notice':
        return <p key={key} className="op-note">{segment.text}</p>;
      case 'status':
        // FROZEN at completion: the value, its period and the instant it was
        // read. Nothing here re-reads a count.
        return (
          <p key={key} className="op-body">
            <span className="op-kv-value">{segment.value}</span>{' '}
            {statusMetricLabel(segment.metric, segment.reportingPeriodDays)}{' '}
            <span className="op-asof">
              (as of <time dateTime={segment.asOf}>{new Date(segment.asOf).toLocaleString()}</time>)
            </span>
          </p>
        );
      case 'scope_check':
        return (
          <div key={key} className="card op-card" role="group" aria-label="Which location?">
            <p className="op-body">
              Did you mean {segment.locationName}? Choose the location and ask again.
            </p>
            <div className="op-actions">
              <button
                type="button"
                className="btn btn-secondary op-action"
                onClick={() => onChooseLocation(segment.locationId)}
              >
                {segment.locationName}
              </button>
            </div>
          </div>
        );
      case 'proposal': {
        const proposal = byId.get(segment.proposalId);
        // A reference whose row is not in this turn's list is a transcript the
        // reader cannot act on; it is skipped rather than throwing, and the
        // card list below still shows anything that WAS returned.
        return proposal === undefined ? null : card(proposal);
      }
      default: {
        // Exhaustiveness guard: a new RenderedSegment member fails typecheck
        // here rather than disappearing from the screen.
        const _never: never = segment;
        return null;
      }
    }
  });

  return (
    <>
      {rendered}
      {turn.proposals.filter((proposal) => !placed.has(proposal.id)).map(card)}
      {turn.unsupported.map((row) => (
        <RequestedCapabilityCard key={row.id} request={row.request} />
      ))}
    </>
  );
}
```

- [ ] **Step 7: Write `operator.css`**

Create `src/app/(authenticated)/dashboard/operator/operator.css`:

```css
/* Operator screen, Console (Harbor). Loads AFTER console.css and therefore
   wins at equal specificity — every `.op-*` rule belongs HERE and never in
   console.css, which loads first and loses (the `.rq-subnav` regression,
   src/app/(authenticated)/dashboard/requests/requests.css:26-30).

   Tokens only. No literal colour, no shadow that is not a token, no second
   border on a card. `.panel` and a bare `.stat` do not exist in the Console
   stylesheets, which is why this file defines `.op-panel` and `.op-kv`. */

.op-head { display: flex; flex-direction: column; gap: 6px; }

.op-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--rw-sp-6);
  align-items: start;
}

.op-conversation { display: flex; flex-direction: column; gap: var(--rw-sp-4); min-width: 0; }

.op-panel {
  display: flex;
  flex-direction: column;
  gap: var(--rw-sp-3);
  padding: 20px 22px;
  background: var(--rw-card);
  border: 1px solid var(--rw-hair);
  border-radius: var(--rw-radius-card);
  box-shadow: var(--rw-shadow-sm);
  position: sticky;
  top: var(--rw-sp-4);
}

.op-card { display: flex; flex-direction: column; gap: var(--rw-sp-3); }

.op-turn { display: flex; flex-direction: column; gap: var(--rw-sp-3); }

.op-owner-text {
  margin: 0;
  align-self: flex-end;
  max-width: 34rem;
  padding: 10px 14px;
  border-radius: var(--rw-radius-core);
  background: var(--rw-accent-100);
  color: var(--rw-accent-800);
  font: var(--rw-app-body);
  white-space: pre-wrap;
}

.op-body { margin: 0; font: var(--rw-app-body); color: var(--rw-app-text); max-width: 70ch; }
.op-label { font: var(--rw-app-label); color: var(--rw-app-text-muted); }
.op-preparing { margin: 0; font: var(--rw-app-body); color: var(--rw-app-text-muted); }

.op-notice {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--rw-radius-md);
  background: var(--rw-danger-soft);
  color: var(--rw-danger);
  font: var(--rw-app-body);
}

.op-composer { display: flex; flex-direction: column; gap: var(--rw-sp-2); }
.op-actions { display: flex; flex-wrap: wrap; gap: var(--rw-sp-3); align-items: center; }
.op-starters { display: flex; flex-wrap: wrap; gap: var(--rw-sp-2); }

/* console.css's .btn is ~36px tall and carries no focus-visible rule of its
   own, so every action on this surface opts into the 44px target and a visible
   ring rather than inheriting a gap (src/app/(authenticated)/dashboard/requests/requests.css:277-289). */
.op-action { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; }
.op-action:focus-visible { outline: 2px solid var(--rw-sage-deep); outline-offset: 3px; }

.op-kv { display: flex; flex-direction: column; gap: 2px; }
.op-kv-label {
  font: var(--rw-app-micro);
  color: var(--rw-app-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.op-kv-value {
  font: var(--rw-app-h3);
  font-family: var(--rw-font-display);
  color: var(--rw-app-text);
}
.op-asof { font: var(--rw-app-micro); color: var(--rw-app-text-soft); }

.op-receipt {
  display: flex;
  flex-direction: column;
  gap: var(--rw-sp-2);
  padding: 14px 16px;
  border-radius: var(--rw-radius-core);
  background: var(--rw-recess);
}

.op-state-line { margin: 0; font: var(--rw-app-body); color: var(--rw-app-text-muted); }
.op-note { margin: 0; font: var(--rw-app-micro); color: var(--rw-app-text-soft); }

.op-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--rw-sp-3); }
.op-diff-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.op-diff-value { font: var(--rw-app-body); color: var(--rw-app-text); overflow-wrap: anywhere; }
.op-diff-list { margin: 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 2px; }
/* An item that is not on the other side. Weight + a token colour, never colour
   alone — the change has to survive a colour-blind reader and a grey print. */
.op-changed { font-weight: 700; color: var(--rw-accent-800); }
.op-question { font-style: italic; }

@media (max-width: 1024px) {
  .op-layout { grid-template-columns: minmax(0, 1fr); }
  .op-panel { position: static; order: -1; }
}

@media (max-width: 560px) {
  .op-diff { grid-template-columns: minmax(0, 1fr); }
  .op-owner-text { max-width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .op-surface .section-enter { animation: none; }
}
```

- [ ] **Step 8: Write the server page**

Create `src/app/(authenticated)/dashboard/operator/page.tsx`:

```tsx
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { OperatorClient } from './OperatorClient';
import { OPERATOR_TITLE, PREPARING } from './wording';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/operator — the Owner Operator screen. Server component so the flag gate
 * stays server-authoritative (invariant #13, mirroring
 * `src/app/(authenticated)/dashboard/requests/page.tsx:13-16`): with the flag off this surface does not
 * exist, and the browser is told nothing.
 *
 * `notFound()` is called in the RENDER PATH, which is what makes it work — a
 * call left in an un-awaited promise throws where nothing catches it and no
 * not-found UI renders (Next 16, `04-functions/not-found.md`).
 *
 * The `<Suspense>` boundary is not decoration: `OperatorClient` calls
 * `useSearchParams`, and without a boundary the client tree up to the closest
 * one is client-rendered — for a page with no boundary at all, the whole route
 * (Next 16, `04-functions/use-search-params.md`; the same reason
 * `src/app/(authenticated)/dashboard/connect/page.tsx:37-50` has one).
 */
export default function OperatorPage() {
  if (!ownerOperatorEnabled()) notFound();
  return (
    <Suspense
      fallback={(
        <div className="content op-surface">
          <h1 className="page-title">{OPERATOR_TITLE}</h1>
          <p className="page-sub">{PREPARING}</p>
        </div>
      )}
    >
      <OperatorClient />
    </Suspense>
  );
}
```

- [ ] **Step 9: Add the nav section and both nav entries**

In `src/components/dashboard/shell/active-nav.ts`, widen the union (`src/components/dashboard/shell/active-nav.ts:14`):

```ts
export type NavSection = 'dashboard' | 'reviews' | 'requests' | 'analytics' | 'operator' | 'settings';
```

and add the rule to `deriveNavSection` (`src/components/dashboard/shell/active-nav.ts:28-34`):

```ts
export function deriveNavSection(pathname: string): NavSection | null {
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/dashboard/reviews')) return 'reviews';
  if (pathname.startsWith('/dashboard/requests')) return 'requests';
  if (pathname.startsWith('/dashboard/analytics')) return 'analytics';
  // ORDER-SENSITIVE: this arm MUST sit ABOVE the `/dashboard` catch-all on the
  // next line. Below it, `/dashboard/operator` folds into `dashboard` and the
  // Operator row never highlights — the same trap the module's own header
  // comment names for reviews, requests and analytics.
  if (pathname.startsWith('/dashboard/operator')) return 'operator';
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) return 'dashboard';
  return null;
}
```

In `src/components/dashboard/shell/Sidebar.tsx`, add to `Props` (`src/components/dashboard/shell/Sidebar.tsx:14-20`):

```ts
  /** Server-authoritative OWNER_OPERATOR_ENABLED, passed down from
   *  (authenticated)/layout.tsx. Invariant #13: the browser learns flag state
   *  only through this prop — there is no NEXT_PUBLIC companion. */
  operatorEnabled: boolean;
```

change the signature (`src/components/dashboard/shell/Sidebar.tsx:139`) to `export function Sidebar({ businessName, solicitationEnabled, operatorEnabled }: Props) {`, and add the row inside `nav-section` immediately after the Reviews children line (`src/components/dashboard/shell/Sidebar.tsx:182`), before the Requests block:

```tsx
        {operatorEnabled && (
          <NavItem href="/dashboard/operator" section="operator" activeNav={activeNav}>
            <Icon name="sparkle" /> Operator
          </NavItem>
        )}
```

`sparkle` is an existing `IconName` (`src/components/dashboard/shell/Icon.tsx:16`); `Icon.tsx` is outside this run's edit surface, so no new glyph is added. The row gets NO `NAV_CHILDREN` entry — the Operator is one screen, and a self-named child would give a screen reader two identical links to one href (the reason Requests has none, `src/components/dashboard/shell/Sidebar.tsx:63-69`).

In `src/components/dashboard/shell/MobileTabBar.tsx`, add the same prop to `Props` (`src/components/dashboard/shell/MobileTabBar.tsx:9-14`), change the signature (`:51`) to `export function MobileTabBar({ solicitationEnabled, operatorEnabled }: Props) {`, and add a sixth tab between Analytics and Settings (after `:99`):

```tsx
      {/* THE SIXTH TAB. At 390px the bar is flex, nowrap, zero horizontal
          padding (src/app/(authenticated)/_styles/console.css:2500) and each .mtab is `flex: 1` with 8px/4px
          padding and an 11px Figtree label (src/app/(authenticated)/_styles/console.css:2509): 390 / 6 =
          65.0px per tab, a 57.0px content box. "Operator" is 8 characters at
          ~5.7-6.0px/char = 46-48px, inside the box the existing widest label
          "Analytics" (~51-54px) already fits. A 10+ character label would NOT:
          `min-width: auto` blocks shrinking below min-content and the bar does
          not wrap, so it would overflow rather than truncate. The 44px touch
          floor still holds (src/app/(authenticated)/_styles/console.css:3245). */}
      {operatorEnabled && (
        <MobileTab
          href="/dashboard/operator"
          label="Operator"
          icon="sparkle"
          section="operator"
          activeNav={activeNav}
        />
      )}
```

In `src/app/(authenticated)/layout.tsx`, add `import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';` beside the other flag imports (`src/app/(authenticated)/layout.tsx:23-25`), read it beside `solicitationEnabled` (`:179`):

```ts
  const operatorEnabled = ownerOperatorEnabled();
```

and pass it to both navs (`src/app/(authenticated)/layout.tsx:194-200`):

```tsx
                <Sidebar
                  businessName={businessName}
                  solicitationEnabled={solicitationEnabled}
                  operatorEnabled={operatorEnabled}
                />
                <main className="main" id="main-content">{children}</main>
              </div>
              <MobileTabBar
                solicitationEnabled={solicitationEnabled}
                operatorEnabled={operatorEnabled}
              />
```

- [ ] **Step 10: Update the two nav suites and add the section test**

In `src/components/dashboard/__tests__/MobileTabBar.test.tsx`, add `operatorEnabled={false}` to every existing `render(<MobileTabBar … />)` call (the prop is required), replace the five-wide case at `src/components/dashboard/__tests__/MobileTabBar.test.tsx:142-148`, and append the two new cases:

```tsx
  it('stays five tabs wide either way with the Operator off', () => {
    for (const enabled of [true, false]) {
      const { container, unmount } = render(
        <MobileTabBar solicitationEnabled={enabled} operatorEnabled={false} />,
      );
      expect(container.querySelectorAll('.mtab')).toHaveLength(5);
      unmount();
    }
  });

  it('adds a sixth Operator tab when the server says the flag is on', () => {
    // 390 / 6 = 65.0px per tab, a 57.0px content box after the 8px horizontal
    // padding. "Operator" is 8 characters of 11px Figtree (~5.7-6.0px/char) =
    // 46-48px, inside the box the existing widest label "Analytics" already
    // occupies. Seven would NOT fit: 390 / 7 = 55.7px, a 47.7px box, under
    // "Analytics" at ~51-54px, and the bar neither wraps nor truncates.
    const { container } = render(<MobileTabBar solicitationEnabled operatorEnabled />);
    expect(container.querySelectorAll('.mtab')).toHaveLength(6);
    expect(screen.getByRole('link', { name: /^Operator$/i })).toHaveAttribute('href', '/dashboard/operator');
  });

  it('marks Operator active on /dashboard/operator without lighting up Home', () => {
    pathnameMock.mockReturnValue('/dashboard/operator');
    render(<MobileTabBar solicitationEnabled operatorEnabled />);
    const operator = screen.getByRole('link', { name: /^Operator$/i });
    expect(operator).toHaveClass('active');
    expect(operator).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /home/i })).not.toHaveClass('active');
  });
```

In `src/components/dashboard/__tests__/Sidebar.test.tsx`, add `operatorEnabled={false}` to every existing `<Sidebar … />` and append:

```tsx
  it('shows the Operator row only when the server-authoritative prop is true', () => {
    const { unmount } = render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} operatorEnabled={false} />,
      ),
    );
    expect(screen.queryByRole('link', { name: /^Operator$/i })).not.toBeInTheDocument();
    unmount();

    pathnameMock.mockReturnValue('/dashboard/operator');
    render(
      wrapWithProvider(
        <Sidebar businessName="Coffee Co" solicitationEnabled={false} operatorEnabled />,
      ),
    );
    const operator = screen.getByRole('link', { name: /^Operator$/i });
    expect(operator).toHaveAttribute('href', '/dashboard/operator');
    // The real `Link` composes the class string, so this suite asserts with
    // `.className` rather than `toHaveClass` (the file's own idiom).
    expect(operator.className).toContain('active');
    expect(operator).toHaveAttribute('aria-current', 'page');
  });
```

Append two cases to the EXISTING suite `src/components/dashboard/shell/__tests__/active-nav.test.ts`, inside its `describe('deriveNavSection', …)` block (`src/components/dashboard/shell/__tests__/active-nav.test.ts:4`):

```ts
  it('folds /dashboard/operator into the operator section', () => {
    expect(deriveNavSection('/dashboard/operator')).toBe('operator');
    expect(deriveNavSection('/dashboard/operator/')).toBe('operator');
    // `usePathname()` never carries a query string, but a stray one must still
    // resolve rather than silently dropping the nav highlight.
    expect(deriveNavSection('/dashboard/operator?conversationId=x')).toBe('operator');
  });

  it('keeps the operator arm above the /dashboard catch-all', () => {
    // THE ORDERING THIS CASE EXISTS FOR. `/dashboard/operator` also matches the
    // `startsWith('/dashboard/')` catch-all, so an arm placed BELOW it returns
    // `'dashboard'` and the Operator row never highlights. A reordering that
    // breaks it fails here, not in a screenshot.
    expect(deriveNavSection('/dashboard/operator')).not.toBe('dashboard');
    // Every other section is unmoved.
    expect(deriveNavSection('/dashboard')).toBe('dashboard');
    expect(deriveNavSection('/dashboard/reviews/history')).toBe('reviews');
    expect(deriveNavSection('/dashboard/requests/contacts')).toBe('requests');
    expect(deriveNavSection('/dashboard/analytics')).toBe('analytics');
    expect(deriveNavSection('/settings/voice')).toBe('settings');
    // The old TOP-LEVEL path is not a section: the page lives under /dashboard.
    expect(deriveNavSection('/operator')).toBeNull();
    expect(deriveNavSection('/help/contact')).toBeNull();
  });
```

- [ ] **Step 11: Write the page + nav gate test (title 30)**

Replace `src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx` with:

```tsx
// @vitest-environment jsdom
// The Operator screen's flag gate, both halves in one title: the server page
// throws Next's not-found when OWNER_OPERATOR_ENABLED is off, and neither nav
// renders an entry when the server-authoritative prop is false. They are ONE
// fact — "with the flag off the surface does not exist" — so they are asserted
// together rather than in two files that can drift.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

class NotFoundSignal extends Error {}
// `vi.hoisted` runs before the class declaration is evaluated, so the factory
// closes over a box rather than the binding (the layout-role-gate idiom,
// src/app/(authenticated)/__tests__/layout-role-gate.test.ts:22-33).
const NotFoundSignalRef = { value: NotFoundSignal };

const { notFoundMock, pathnameMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => { throw new NotFoundSignalRef.value(); }),
  pathnameMock: vi.fn<() => string>(() => '/dashboard/operator'),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
  usePathname: () => pathnameMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/contexts/PendingCountContext', () => ({ usePendingCount: () => 0 }));

import OperatorPage from '../page';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';

describe('operator page and nav flag gate', () => {
  it('operator page calls notFound when the flag is off and the nav omits the entry', () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    expect(() => OperatorPage()).toThrow(NotFoundSignal);
    expect(notFoundMock).toHaveBeenCalledTimes(1);

    // The nav learns the same fact from the server-authoritative prop, never
    // from a NEXT_PUBLIC companion (invariant #13).
    render(<MobileTabBar solicitationEnabled={false} operatorEnabled={false} />);
    expect(screen.queryByRole('link', { name: /^Operator$/i })).not.toBeInTheDocument();

    // …and with the flag on, the page renders instead of throwing.
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    notFoundMock.mockClear();
    expect(() => OperatorPage()).not.toThrow();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 12: Run the whole T3 surface**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)" src/components/dashboard`
Expected: PASS — titles 30–34 plus the updated nav suites and the untouched `layout-role-gate` and `error` suites.

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm lint && pnpm typecheck && pnpm ci:static-policy && pnpm build`
Expected: PASS. `ci:static-policy` matters here: no `NEXT_PUBLIC_OWNER_OPERATOR_*` may appear anywhere, and it fails CI on any new `NEXT_PUBLIC_*`.

- [ ] **Step 13: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add "src/app/(authenticated)/dashboard/operator" \
        "src/app/(authenticated)/layout.tsx" \
        src/components/dashboard/shell/active-nav.ts \
        src/components/dashboard/shell/Sidebar.tsx \
        src/components/dashboard/shell/MobileTabBar.tsx \
        src/components/dashboard/__tests__/Sidebar.test.tsx \
        src/components/dashboard/__tests__/MobileTabBar.test.tsx \
        src/components/dashboard/shell/__tests__/active-nav.test.ts
git commit -m "feat(operator): the Operator screen shell — server page, nav entry, conversation state machine, polling with back-off and failure wording"
```

---

### Task T4: The Proposal card, the Receipt, the stale state with Refresh plan, and the Requested-capability card

Runs in PARALLEL with T5. Disjoint files: T4 owns `ProposalCard.tsx`, `ReceiptView.tsx`, `RequestedCapabilityCard.tsx`, `OperatorClient.tsx` and `ProposalCard.test.tsx`; T5 owns `SummaryPanel.tsx` and `SummaryPanel.test.tsx`.

**Blocking edges:** T1 (the `Receipt` type and the extended `ProposalView`), T2 (the two POST routes it calls), T3 (the client and the placeholder files it replaces).

**Lease:** `src/app/(authenticated)/dashboard/operator/{ProposalCard,ReceiptView,RequestedCapabilityCard}.tsx` and the `ProposalCard.test.tsx` + `OperatorClient.test.tsx` suites. **`OperatorClient.tsx` itself is NOT in T4's lease** — T3 wrote the Apply / Not now / **Refresh plan** handlers there, and T4 only proves them.

**Turns green (verbatim):**
35. `proposal card renders the target from the stored location and shows Prepared for the location when the selector moved`
36. `proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch`
37. `requested capability card has no Apply button`
R3. `Refresh plan preserves the original instruction and location after scope changes`
R4. `proposal previews expose exact fact replacements before approval`

**Files:**
- Modify: `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx` (replace the T3 placeholder)
- Modify: `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx` (replace the T3 placeholder)
- Modify: `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx` (replace the T3 placeholder)
- Test: `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` (titles 35–37, R4)
- Test: `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` (title R3 — the Refresh-plan payload is a CLIENT assertion; T3 wrote the handler, T4 proves it)

**Precedent paths:** `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:724-732` (a Harbor `card` section with `aria-labelledby` and a `card-h2`) · `src/app/(authenticated)/dashboard/requests/ApprovalActions.tsx:66-82` (one action row, a `busy`/`unavailable` split, and a one-line reason with `aria-describedby`) · `src/app/(authenticated)/dashboard/requests/lane-writes.ts:210-256` (the same-origin POST and its three-outcome union) · `src/app/(authenticated)/dashboard/requests/requests.css:542-567` (the error slot and the action row) · spec §3.3 (the card contract), §6.5 (the Receipt), §8.3 (stale siblings), §8.4 (what it affects).

**Completion evidence:** `pnpm exec vitest run "src/app/(authenticated)/dashboard/operator"` green with titles 35–37 passing; `pnpm lint`, `pnpm typecheck`, `pnpm build` green.

- [ ] **Step 1: Write the failing card tests (titles 35–37)**

Replace `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` with:

```tsx
// @vitest-environment jsdom
// The card contracts (spec §3.3). Every assertion reads from a stored-row
// fixture, never from prose, and never from the browser's location selector.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposalCard } from '../ProposalCard';
import { RequestedCapabilityCard } from '../RequestedCapabilityCard';
import {
  AFFECTS_FUTURE_DRAFTS,
  APPLY,
  CANNOT_DO_YET,
  NOT_NOW,
  PROPOSAL_APPLIED,
  PROPOSAL_STALE,
  REFRESH_PLAN,
} from '../wording';

const SALON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAFE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACTOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PROPOSAL = '99999999-9999-4999-8999-999999999999';

const VOICE_BEFORE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
};
const VOICE_AFTER = { ...VOICE_BEFORE, tone: 'warm and brief' };

const labels: Record<string, string> = { [SALON]: 'Salon', [CAFE]: 'Cafe' };
const locationLabel = (id: string) => labels[id] ?? 'this location';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    turnId: TURN,
    operation: 'set_tone',
    contractVersion: 1,
    labelKind: 'fact' as const,
    locationId: SALON,
    status: 'pending' as const,
    rationale: 'You asked for warmer replies.',
    input: { tone: 'warm and brief' },
    before: VOICE_BEFORE,
    after: VOICE_AFTER,
    describe: 'Set the reply tone to "warm and brief"',
    preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
    receipt: null,
    appliedAt: null,
    failureReason: null,
    ...overrides,
  };
}

const RECEIPT = {
  version: 1 as const,
  operation: 'set_tone',
  scope: { accountId: ACCOUNT, locationId: SALON },
  before: VOICE_BEFORE,
  after: VOICE_AFTER,
  differsFromPreview: false,
  effectiveNow: true as const,
  affects: 'future_drafts' as const,
  remainingBlocked: [],
  appliedAt: '2026-09-12T10:00:00.000Z',
  actorUserId: ACTOR,
  ownerText: 'Make my replies warmer.',
  turnId: TURN,
  versionToken: {
    before: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
    after: { businessId: SALON, updatedAt: '2026-09-12 10:00:00.222222+00' },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture narrowing
const asProposal = (value: Record<string, unknown>) => value as any;

function renderCard(overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const handlers = { onApply: vi.fn(), onDecline: vi.fn(), onRefreshPlan: vi.fn() };
  const utils = render(
    <ProposalCard
      proposal={asProposal(proposal(overrides))}
      turnLocationId={SALON}
      locationLabel={locationLabel}
      scopeMoved={false}
      busy={false}
      error={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

describe('ProposalCard', () => {
  it('proposal card renders the target from the stored location and shows Prepared for the location when the selector moved', () => {
    const { unmount } = renderCard();
    // The target names the STORED location, and the card states what the
    // change affects (spec §8.4).
    expect(screen.getByText('Salon')).toBeInTheDocument();
    expect(screen.getByText(AFFECTS_FUTURE_DRAFTS)).toBeInTheDocument();
    // Exact before and after of the FULL voice state (spec §3.3, §6.1).
    expect(screen.getByText(/warm and brief/)).toBeInTheDocument();
    // No note while the selector still points at the turn's location.
    expect(screen.queryByText(/^Prepared for/)).not.toBeInTheDocument();
    unmount();

    // The selector moved to the Cafe. The card STILL names the Salon — the
    // target comes from the stored row, never from the browser (§3.3) — and
    // adds the note, worded exactly as D4 fixes it.
    renderCard({}, { scopeMoved: true });
    expect(screen.getByText('Prepared for Salon')).toBeInTheDocument();
    expect(screen.queryByText('Cafe')).not.toBeInTheDocument();
  });

  it('proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch', async () => {
    const user = userEvent.setup();
    const pending = renderCard();
    await user.click(screen.getByRole('button', { name: APPLY }));
    expect(pending.onApply).toHaveBeenCalledTimes(1);
    expect(pending.onApply.mock.calls[0]![0].id).toBe(PROPOSAL);
    await user.click(screen.getByRole('button', { name: NOT_NOW }));
    expect(pending.onDecline).toHaveBeenCalledTimes(1);
    pending.unmount();

    // APPLIED: the Receipt replaces the buttons and the label becomes applied.
    const applied = renderCard({
      status: 'applied',
      receipt: RECEIPT,
      appliedAt: '2026-09-12T10:00:00.000Z',
    });
    expect(screen.getByText(PROPOSAL_APPLIED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: APPLY })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NOT_NOW })).not.toBeInTheDocument();
    // The Receipt's own fields: the actual after, the verbatim owner text and
    // the turn id as correlation id (spec §6.5).
    expect(screen.getByText('Make my replies warmer.')).toBeInTheDocument();
    expect(screen.getByText(TURN)).toBeInTheDocument();
    expect(screen.getByText(/effective now/i)).toBeInTheDocument();
    applied.unmount();

    // STALE: the sentence, and a Refresh plan action that posts a new turn
    // from the original instruction (spec §3.3).
    const stale = renderCard({ status: 'stale', failureReason: 'version_mismatch' });
    expect(screen.getByText(PROPOSAL_STALE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: APPLY })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: REFRESH_PLAN }));
    expect(stale.onRefreshPlan).toHaveBeenCalledTimes(1);
    stale.unmount();

    // contract_changed also offers Refresh plan — a fresh plan is exactly the
    // fix — but says the plan must be prepared again, not that settings moved.
    renderCard({ status: 'rejected', failureReason: 'contract_changed' });
    expect(screen.getByText(/must be prepared again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REFRESH_PLAN })).toBeInTheDocument();
    expect(screen.queryByText(PROPOSAL_STALE)).not.toBeInTheDocument();
  });

  it('proposal previews expose exact fact replacements before approval', async () => {
    // SAME LENGTH, DIFFERENT CONTENT. A count renders "Avoid 2" on both sides
    // and the owner approves a swap they never read — and the catalog
    // describer says only "Keep 2 thing(s) out of every reply"
    // (src/lib/agents/operator/catalog.ts:157-171), so the headline cannot
    // carry it either.
    renderCard({
      operation: 'set_avoid_facts',
      describe: 'Keep 2 thing(s) out of every reply',
      input: { avoidFacts: ['shellfish', 'the old menu'] },
      before: {
        ...VOICE_BEFORE,
        tone: 'warm and brief',
        productsServices: 'haircuts and colour',
        avoidFacts: ['peanuts', 'the old menu'],
        highlightFacts: ['free parking'],
        sampleResponses: ['Thanks so much!'],
      },
      after: {
        ...VOICE_BEFORE,
        tone: 'warm and brief',
        productsServices: null,
        avoidFacts: ['shellfish', 'the old menu'],
        highlightFacts: ['free parking'],
        sampleResponses: ['Thanks so much!'],
      },
    });

    // BOTH sides of the swap are on screen, by value.
    expect(screen.getByText('peanuts')).toBeInTheDocument();
    expect(screen.getByText('shellfish')).toBeInTheDocument();
    // The item that did NOT change appears on both sides and is not flagged.
    expect(screen.getAllByText('the old menu')).toHaveLength(2);
    for (const node of screen.getAllByText('the old menu')) {
      expect(node).not.toHaveClass('op-changed');
    }
    // The changed items ARE flagged, and not by colour alone — the class
    // carries a weight as well.
    expect(screen.getByText('peanuts')).toHaveClass('op-changed');
    expect(screen.getByText('shellfish')).toHaveClass('op-changed');

    // A CLEARED scalar is not silently "Not set" on both sides.
    expect(screen.getByText('haircuts and colour')).toBeInTheDocument();
    expect(screen.getByText('Cleared')).toBeInTheDocument();

    // And the two fields this operation does NOT touch are still shown, as
    // values, so "full effective state" means what §6.1 says it means.
    expect(screen.getAllByText('free parking')).toHaveLength(2);
    expect(screen.getAllByText('Thanks so much!')).toHaveLength(2);
    expect(screen.getAllByText('warm and brief')).toHaveLength(2);

    // Nothing is applied yet: the buttons are still the only way forward.
    expect(screen.getByRole('button', { name: APPLY })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: NOT_NOW })).toBeInTheDocument();
  });
});

describe('RequestedCapabilityCard', () => {
  it('requested capability card has no Apply button', () => {
    render(<RequestedCapabilityCard request="Stop replying on weekends" />);
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
    expect(screen.getByText(CANNOT_DO_YET)).toBeInTheDocument();
    // A separate KIND, not a Proposal with no button: the two travel under
    // separate response keys so a renderer cannot grow an Apply onto one.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx"`
Expected: FAIL — the placeholder renders only `describe`, so `Salon`, the Apply button and the Receipt fields are all absent.

- [ ] **Step 3: Write `ReceiptView.tsx`**

Replace `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx`:

```tsx
'use client';

import type { Receipt } from '@/lib/agents/operator/schema';
import { AFFECTS_FUTURE_DRAFTS } from './wording';
import './operator.css';

export interface ReceiptViewProps {
  receipt: Receipt;
  locationLabel: (locationId: string) => string;
}

/**
 * The **Receipt**, rendered from the stored JSONB and nothing else.
 *
 * Only the Receipt establishes that something changed (spec §6.5), so every
 * field here is a passthrough of what the server wrote inside the mutation's
 * transaction. Nothing on this component recomputes a value, reads a live
 * count, or formats a number the server did not produce.
 */
export function ReceiptView({ receipt, locationLabel }: ReceiptViewProps) {
  return (
    <div className="op-receipt">
      <p className="op-state-line">
        {receipt.effectiveNow ? 'Effective now.' : 'Scheduled.'} {AFFECTS_FUTURE_DRAFTS}
      </p>

      <div className="op-diff">
        <div className="op-diff-col">
          <span className="op-kv-label">Before</span>
          <VoiceStateLines state={receipt.before} />
        </div>
        <div className="op-diff-col">
          <span className="op-kv-label">After</span>
          <VoiceStateLines state={receipt.after} />
        </div>
      </div>

      {receipt.differsFromPreview && (
        <p className="op-note">
          The saved result is not exactly what the plan previewed. What is shown under
          &ldquo;After&rdquo; is the state that was actually saved.
        </p>
      )}

      {receipt.remainingBlocked.length > 0 && (
        <p className="op-note">Still blocked: {receipt.remainingBlocked.join(', ')}.</p>
      )}

      <dl className="op-kv">
        <dt className="op-kv-label">Location</dt>
        <dd className="op-diff-value">{locationLabel(receipt.scope.locationId)}</dd>
        <dt className="op-kv-label">Applied</dt>
        <dd className="op-diff-value">
          <time dateTime={receipt.appliedAt}>{new Date(receipt.appliedAt).toLocaleString()}</time>
        </dd>
        <dt className="op-kv-label">You asked</dt>
        {/* VERBATIM owner text, as the server stored it (spec §6.5). */}
        <dd className="op-diff-value">{receipt.ownerText}</dd>
        <dt className="op-kv-label">Reference</dt>
        <dd className="op-diff-value">{receipt.turnId}</dd>
      </dl>
    </div>
  );
}

/** The five voice fields, each labelled. `null` and `[]` read as "not set". */
function VoiceStateLines({ state }: { state: Receipt['before'] }) {
  const rows: Array<[string, string]> = [
    ['Tone', state.tone ?? 'Not set'],
    ['Products and services', state.productsServices ?? 'Not set'],
    ['Keep out of replies', state.avoidFacts.length === 0 ? 'Nothing' : state.avoidFacts.join('; ')],
    ['Highlight when it fits', state.highlightFacts.length === 0 ? 'Nothing' : state.highlightFacts.join('; ')],
    ['Sample replies', state.sampleResponses.length === 0 ? 'None' : `${state.sampleResponses.length} saved`],
  ];
  return (
    <>
      {rows.map(([label, value]) => (
        <span key={label} className="op-diff-value">
          <span className="op-kv-label">{label}: </span>
          {value}
        </span>
      ))}
    </>
  );
}
```

- [ ] **Step 4: Write `ProposalCard.tsx`**

Replace `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx`:

```tsx
'use client';

import type { ProposalView } from '@/lib/agents/operator/proposals';
import { parseVoiceState } from '@/lib/agents/operator/schema';
import { ReceiptView } from './ReceiptView';
import {
  AFFECTS_FUTURE_DRAFTS,
  APPLY,
  NOT_NOW,
  OFFERS_REFRESH_PLAN,
  PROPOSAL_APPLIED,
  PROPOSAL_DECLINED,
  PROPOSAL_SUPERSEDED,
  REFRESH_PLAN,
  preparedForNote,
  proposalFailureSentence,
} from './wording';
import './operator.css';

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The turn's STORED location — the card's target, never the selector (§3.3). */
  turnLocationId: string;
  /** How to name a location on screen. Supplied by the client, which owns the roster. */
  locationLabel: (locationId: string) => string;
  /** True when the browser's current scope is not the turn's location (D4). */
  scopeMoved: boolean;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  busy: boolean;
  error: string | null;
}

/**
 * One **Proposal** as a Harbor card, rendered ENTIRELY from the stored row.
 *
 * The target is the proposal's own `location_id`, falling back to the turn's
 * stored location — never the browser's current selector (spec §3.3). That is
 * the whole reason the note exists: the owner may be looking at the Cafe while
 * reading a plan prepared for the Salon, and a card that renamed itself to
 * match the selector would be describing a change it is not about to make.
 */
export function ProposalCard({
  proposal,
  turnLocationId,
  locationLabel,
  scopeMoved,
  onApply,
  onDecline,
  onRefreshPlan,
  busy,
  error,
}: ProposalCardProps) {
  const targetLocationId = proposal.locationId ?? turnLocationId;
  const headingId = `op-proposal-${proposal.id}`;
  const reasonId = `${headingId}-reason`;

  const before = parseVoiceState(proposal.before, 'agent_proposals.before');
  const after = parseVoiceState(proposal.after, 'agent_proposals.after');

  const pending = proposal.status === 'pending';
  const refreshable =
    proposal.failureReason !== null && OFFERS_REFRESH_PLAN.has(proposal.failureReason);

  return (
    <section className="card op-card" aria-labelledby={headingId}>
      <h2 className="card-h2" id={headingId}>{proposal.describe}</h2>

      <div className="op-kv">
        <span className="op-kv-label">This location</span>
        <span className="op-kv-value">{locationLabel(targetLocationId)}</span>
      </div>
      {scopeMoved && <p className="op-note">{preparedForNote(locationLabel(targetLocationId))}</p>}

      {/* EXACT before and after of the full voice state (spec §3.3, §6.1).
          Counts are not enough: replacing one avoided fact with a different
          one of the same length produced two identical-looking columns, and
          the owner approved replacement content they never saw. The catalog
          describer has the same limit ("Keep 3 thing(s) out of every reply",
          src/lib/agents/operator/catalog.ts:157-171), which is why the card
          does not lean on it for the values. */}
      <div className="op-diff">
        <div className="op-diff-col">
          <span className="op-kv-label">Now</span>
          <VoiceStateDetail state={before} other={after} side="before" />
        </div>
        <div className="op-diff-col">
          <span className="op-kv-label">After this change</span>
          <VoiceStateDetail state={after} other={before} side="after" />
        </div>
      </div>

      <p className="op-state-line">{AFFECTS_FUTURE_DRAFTS}</p>

      {proposal.status === 'applied' && proposal.receipt !== null && (
        <>
          <p className="op-state-line">{PROPOSAL_APPLIED}</p>
          <ReceiptView receipt={proposal.receipt} locationLabel={locationLabel} />
        </>
      )}

      {proposal.status === 'superseded' && <p className="op-state-line">{PROPOSAL_SUPERSEDED}</p>}

      {(proposal.status === 'stale' || proposal.status === 'rejected' || proposal.status === 'failed')
        && proposal.status !== 'superseded' && (
        <p className="op-state-line">
          {proposal.status === 'rejected' && proposal.failureReason === null
            ? PROPOSAL_DECLINED
            : proposalFailureSentence(proposal.failureReason)}
        </p>
      )}

      {error !== null && (
        <p className="op-notice" id={reasonId} role="alert">{error}</p>
      )}

      {pending && (
        <div className="op-actions">
          <button
            type="button"
            className="btn btn-primary op-action"
            disabled={busy}
            aria-describedby={error !== null ? reasonId : undefined}
            onClick={() => onApply(proposal)}
          >
            {APPLY}
          </button>
          <button
            type="button"
            className="btn btn-secondary op-action"
            disabled={busy}
            onClick={() => onDecline(proposal)}
          >
            {NOT_NOW}
          </button>
        </div>
      )}

      {!pending && refreshable && (
        <div className="op-actions">
          <button
            type="button"
            className="btn btn-secondary op-action"
            disabled={busy}
            onClick={() => onRefreshPlan(proposal)}
          >
            {REFRESH_PLAN}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * One column of the before/after diff: ALL FIVE voice fields, with their EXACT
 * stored values.
 *
 * The two list fields are rendered ITEM BY ITEM, not as a count, and each item
 * that is absent from the other side is marked as changed. A count-only render
 * makes "avoid: peanuts" → "avoid: shellfish" look identical on both sides,
 * and the owner approves a replacement they never read (RB-04).
 *
 * A `null` scalar reads "cleared" on the AFTER side and "Not set" on the
 * BEFORE side: clearing a value is a change the owner is agreeing to, and
 * "Not set" on both sides would hide it.
 */
function VoiceStateDetail({
  state,
  other,
  side,
}: {
  state: ReturnType<typeof parseVoiceState>;
  other: ReturnType<typeof parseVoiceState>;
  /** Which column this is. Only the after side can report a removal. */
  side: 'before' | 'after';
}) {
  // `side` is which COLUMN this is. "Cleared" is a statement about a removal,
  // so it belongs only to the AFTER side of one: a null on the BEFORE side of
  // a proposal that SETS a value means the field was never set, and calling
  // that "Cleared" told the owner a change had happened that had not (RB2-07).
  const scalar = (value: string | null, counterpart: string | null) => {
    const changed = value !== counterpart;
    const removed = side === 'after' && value === null && counterpart !== null;
    const text = value === null ? (removed ? 'Cleared' : 'Not set') : value;
    return <span className={changed ? 'op-diff-value op-changed' : 'op-diff-value'}>{text}</span>;
  };

  const list = (values: readonly string[], counterpart: readonly string[]) => {
    if (values.length === 0) return <span className="op-diff-value">Nothing</span>;
    const theirs = new Set(counterpart);
    return (
      <ul className="op-diff-list">
        {values.map((value, index) => (
          <li
            key={`${value}-${index}`}
            className={theirs.has(value) ? 'op-diff-value' : 'op-diff-value op-changed'}
          >
            {value}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <span className="op-kv-label">Tone</span>
      {scalar(state.tone, other.tone)}
      <span className="op-kv-label">Products and services</span>
      {scalar(state.productsServices, other.productsServices)}
      <span className="op-kv-label">Keep out of replies</span>
      {list(state.avoidFacts, other.avoidFacts)}
      <span className="op-kv-label">Highlight when it fits</span>
      {list(state.highlightFacts, other.highlightFacts)}
      <span className="op-kv-label">Sample replies</span>
      {list(state.sampleResponses, other.sampleResponses)}
    </>
  );
}
```

- [ ] **Step 5: Write `RequestedCapabilityCard.tsx`**

Replace `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx`:

```tsx
'use client';

import { CANNOT_DO_YET } from './wording';
import './operator.css';

export interface RequestedCapabilityCardProps {
  request: string;
}

/**
 * A **Requested capability** (spec §3.3). A SEPARATE KIND, not a Proposal with
 * no button: the two travel under separate response keys (`proposals`,
 * `unsupported`) so a renderer can never grow an Apply affordance onto one.
 * There is no interactive element in this component at all, which is what the
 * test asserts.
 */
export function RequestedCapabilityCard({ request }: RequestedCapabilityCardProps) {
  return (
    <section className="card op-card">
      <h2 className="card-h2">{request}</h2>
      <p className="op-state-line">{CANNOT_DO_YET}</p>
    </section>
  );
}
```

- [ ] **Step 6: Prove the Refresh-plan payload (title R3)**

T3 already wired `onApply`, `onDecline` and `onRefreshPlan` in `OperatorClient.tsx`, and `refreshPlan` takes the whole turn so it can read BOTH the original instruction and the original location. This step proves the part a card test cannot see: what actually goes on the wire.

Append to `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx`, inside its existing `describe('OperatorClient', …)` block:

```tsx
  it('Refresh plan preserves the original instruction and location after scope changes', async () => {
    // A STALE plan prepared for the Salon, while the browser now points at the
    // Cafe. Reading the composer scope here would prepare the replacement for
    // the wrong location, and `createTurn` would accept it without complaint —
    // it validates only that the location is an active member of the account
    // (src/lib/agents/operator/turns.ts:122-129).
    const stale = {
      id: PROPOSAL, turnId: TURN, operation: 'set_tone', contractVersion: 1,
      labelKind: 'fact', locationId: SALON, status: 'stale',
      rationale: 'You asked for warmer replies.', input: { tone: 'warm and brief' },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      describe: 'Set the reply tone to "warm and brief"',
      preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
      receipt: null, appliedAt: null, failureReason: 'version_mismatch',
    };
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: conversationWith([storedTurn({ proposals: [stale] })]),
      })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    // THE SELECTOR HAS MOVED to the Cafe.
    scopeMock.value = CAFE;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    await user.click(await screen.findByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));
    const [refreshed] = postBodies(fetchMock);
    // The ORIGINAL instruction and the ORIGINAL location, verbatim.
    expect(refreshed.text).toBe('Make my replies warmer.');
    expect(refreshed.locationId).toBe(SALON);
    // A NEW key: this is a new turn, not a replay of the old one.
    expect(refreshed.clientTurnKey).not.toBe(stale.preparedVersionToken.updatedAt);
    expect(typeof refreshed.clientTurnKey).toBe('string');
  });

  it('Refresh plan works under All locations', async () => {
    // Under `all` the composer is disabled, but the plan already names its
    // location — refusing to refresh it would leave the owner with a dead card
    // and no way back except changing a selector the card does not use.
    const stale = {
      id: PROPOSAL, turnId: TURN, operation: 'set_tone', contractVersion: 1,
      labelKind: 'fact', locationId: SALON, status: 'stale',
      rationale: 'You asked for warmer replies.', input: { tone: 'warm and brief' },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      describe: 'Set the reply tone to "warm and brief"',
      preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
      receipt: null, appliedAt: null, failureReason: 'version_mismatch',
    };
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: conversationWith([storedTurn({ proposals: [stale] })]),
      })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });
    scopeMock.value = 'all';

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    const button = await screen.findByRole('button', { name: 'Refresh plan' });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));
    expect(postBodies(fetchMock)[0].locationId).toBe(SALON);
  });
```

The second case carries no promised title — it is a sibling assertion on the same behaviour, and the intake's title covers the pair.

- [ ] **Step 7: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)/dashboard/operator"`
Expected: PASS — titles 30–37. The `OperatorClient` suite must stay green: none of its four cases renders a Proposal, so the new handlers are unexercised there and unbroken.

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm lint && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx" \
        "src/app/(authenticated)/dashboard/operator/ReceiptView.tsx" \
        "src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx" \
        "src/app/(authenticated)/dashboard/operator/operator.css" \
        "src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx" \
        "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx"
git commit -m "feat(operator): the Proposal card, the Receipt view, the stale state with Refresh plan and the Requested-capability card"
```

---

### Task T5: The summary panel and its connect call to action

Runs in PARALLEL with T4. It touches exactly two files, neither of which T4 touches.

**Blocking edges:** T2 (`connectionStatus` on `OwnerConversationSummary`), T3 (the placeholder and the props the client already passes).

**Lease:** `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx`, `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx`.

**Turns green (verbatim):**
38. `summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing`

**Files:**
- Modify: `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx` (replace the T3 placeholder)
- Test: `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx` (title 38)

**Precedent paths:** `src/lib/agents/operator/reads.ts:122-130` (the summary shape, as T2 extends it) · `src/app/(authenticated)/dashboard/connect/page.tsx:290-296` (the existing connect link and its `--rw-sage-deep` treatment) · `src/app/(authenticated)/_styles/console.css:1850-1865` (`.empty-link`, the pill the call to action reuses).

**The panel does NOT import the dashboard DTOs.** The architecture pass measured it field by field (H1-D): the dashboard payload's rating band buckets ALL rated reviews where the Operator wants pending drafts by star; the posted count is absent (`totalReviewsHandled` is all-time, `recentReviewCount` is a capped received sample); the location list is absent from the per-location DTO; and importing the assembled DTOs drags in a 45-second Redis TTL cache plus ranking, velocity and briefs. **Run A's granular helpers stay the source** — `getPendingApprovalCountsForAccount`, `readPosted7d`, `getAutoApprovalSettings` and `readVoiceConfig`, already wired in `getConversationForOwner`. This panel is a pure renderer of what that read returns. T6 corrects spec §14's "Default: reuse" to say so.

**Completion evidence:** `pnpm exec vitest run "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx"` green; `pnpm lint`, `pnpm typecheck`, `pnpm build` green.

- [ ] **Step 1: Write the failing panel test (title 38)**

Replace `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx` with:

```tsx
// @vitest-environment jsdom
// The summary panel's three blocks and the connect call to action.
//
// It renders what `getConversationForOwner` returned and nothing else — no
// dashboard DTO, no second read, no recomputed number (architecture pass
// H1-D). Every assertion here is therefore a passthrough assertion.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryPanel } from '../SummaryPanel';

const SUMMARY = {
  pending: { pendingCount: 3, draftsWaiting: 5 },
  recent: { posted7d: 9, reportingPeriodDays: 7 },
  rules: {
    threshold: null,
    vetoWindowMinutes: 15,
    dailyCap: 5,
    locationOverrideExists: false,
  },
  facts: {
    tone: 'warm and brief',
    productsServices: null,
    avoidFacts: [],
    highlightFacts: [],
    sampleResponses: [],
    updatedAt: '2026-09-12 09:00:00.111111+00',
  },
  pendingProposals: [],
  connectionStatus: 'active' as const,
  asOf: '2026-09-12T10:00:00.000Z',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture narrowing
const asSummary = (value: Record<string, unknown>) => value as any;

describe('SummaryPanel', () => {
  it('summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing', () => {
    const connected = render(<SummaryPanel summary={asSummary(SUMMARY)} hint={null} />);

    // Waiting for you.
    expect(screen.getByText(/waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Recently completed, with its reporting period stated rather than implied.
    expect(screen.getByText(/recently completed/i)).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/last 7 days/i)).toBeInTheDocument();
    // Current operating rules.
    expect(screen.getByText(/current operating rules/i)).toBeInTheDocument();
    expect(screen.getByText(/15 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/5 a day/i)).toBeInTheDocument();

    // THE AS-OF STAMP: a live number and the instant it was read must not be
    // able to disagree, so the panel prints the server's own `asOf`.
    const stamps = screen.getAllByText(/as of/i);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    for (const stamp of stamps) {
      expect(stamp.querySelector('time')).toHaveAttribute('datetime', SUMMARY.asOf);
    }

    // Connected: no call to action.
    expect(screen.queryByRole('link', { name: /connect google/i })).not.toBeInTheDocument();
    connected.unmount();

    // NOT connected, in all three non-active shapes.
    for (const status of ['pending', 'disconnected', null]) {
      const { unmount } = render(
        <SummaryPanel summary={asSummary({ ...SUMMARY, connectionStatus: status })} hint={null} />,
      );
      const cta = screen.getByRole('link', { name: /connect google/i });
      expect(cta).toHaveAttribute('href', '/dashboard/connect');
      unmount();
    }

    // No summary and a hint: the chooser's sentence stands in for the blocks.
    render(<SummaryPanel summary={null} hint="Pick one location to talk about." />);
    expect(screen.getByText('Pick one location to talk about.')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for you/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx"`
Expected: FAIL — the placeholder renders an empty `<aside>`.

- [ ] **Step 3: Write `SummaryPanel.tsx`**

Replace `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx`:

```tsx
'use client';

import Link from 'next/link';
import type { OwnerConversationSummary } from '@/lib/agents/operator/reads';
import './operator.css';

export interface SummaryPanelProps {
  summary: OwnerConversationSummary | null;
  /** Shown instead of the blocks when the scope is `all` and nothing is chosen. */
  hint: string | null;
}

/**
 * The summary panel (spec §3.1): three blocks from AUTHORITATIVE reads, each
 * carrying the instant it was read at.
 *
 * A PURE RENDERER. It imports no dashboard DTO and issues no read of its own —
 * the architecture pass (H1-D) measured that the dashboard payload shapes the
 * rating band wrong, lacks the posted count and lacks the location list, and
 * that importing it drags in a 45-second Redis cache. Run A's granular helpers,
 * already wired into `getConversationForOwner`, are the source.
 *
 * `null` summary is NOT a zeroed panel. Every number here is scoped to one
 * location, and with none chosen an all-zeros panel with a fresh timestamp
 * reads as "just measured, and the answer is zero" — which for an account with
 * a dozen drafts waiting is a lie the timestamp vouches for.
 */
export function SummaryPanel({ summary, hint }: SummaryPanelProps) {
  if (summary === null) {
    return (
      <aside className="op-panel" aria-label="Summary">
        {hint !== null && <p className="op-body">{hint}</p>}
      </aside>
    );
  }

  const { pending, recent, rules, connectionStatus, asOf } = summary;

  return (
    <aside className="op-panel" aria-label="Summary">
      {connectionStatus !== 'active' && (
        <div className="op-kv">
          <span className="op-kv-label">Google</span>
          <p className="op-body">
            This location is not connected to Google, so nothing can be posted yet.
          </p>
          <Link className="empty-link op-action" href="/dashboard/connect">
            Connect Google Business
          </Link>
        </div>
      )}

      <section className="op-kv" aria-label="Waiting for you">
        <span className="op-kv-label">Waiting for you</span>
        <span className="op-kv-value">{pending.pendingCount}</span>
        <span className="op-body">
          {pending.draftsWaiting} across every location
        </span>
        <AsOf asOf={asOf} />
      </section>

      <section className="op-kv" aria-label="Recently completed">
        <span className="op-kv-label">Recently completed</span>
        <span className="op-kv-value">{recent.posted7d}</span>
        <span className="op-body">posted in the last {recent.reportingPeriodDays} days</span>
        <AsOf asOf={asOf} />
      </section>

      <section className="op-kv" aria-label="Current operating rules">
        <span className="op-kv-label">Current operating rules</span>
        <span className="op-body">
          {rules.threshold === null
            ? 'Auto-posting is off — you approve every reply.'
            : `Auto-posting from ${rules.threshold} stars up.`}
        </span>
        <span className="op-body">
          You get {rules.vetoWindowMinutes} minutes to stop a reply, up to {rules.dailyCap} a day.
        </span>
        <span className="op-body">
          {rules.locationOverrideExists
            ? 'These are this location’s own rules.'
            : 'These come from the account default.'}
        </span>
        <AsOf asOf={asOf} />
      </section>
    </aside>
  );
}

/**
 * The server's OWN `asOf`, never a second `new Date()` in the browser: a number
 * and the instant it was read must not be able to disagree.
 */
function AsOf({ asOf }: { asOf: string }) {
  return (
    <span className="op-asof">
      As of <time dateTime={asOf}>{new Date(asOf).toLocaleTimeString()}</time>
    </span>
  );
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm exec vitest run "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx" && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add "src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx" \
        "src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx"
git commit -m "feat(operator): the summary panel — three blocks with as-of stamps and the connect call to action"
```

---

### Task T6: Documentation, registries and the alerting record

Docs only — no production file, no test. It has **no blocking edge on any code tracer** and may run at any point, but its `path:line` claims must be re-checked against HEAD before it commits (green CI is not proof that documentation is true).

**One external action is NOT this task's:** the root builds Sentry rule 11 in BOTH Sentry projects (`subsystem:worker_job` AND `queue:agent_turn`, every event, level `error`) and hands back the two rule ids. `<staging-rule-id>` and `<prod-rule-id>` below are the ONLY placeholders in this entire plan, and the task is not complete until they are replaced with real ids.

**Lease:** every docs file listed below. **Blocking edges:** none (docs); the two `docs/directory/lib-owner-operator.md` rows describe files T1 creates, so commit T6 after T1 if `ci:directory-map` is run in between.

**Files:**
- Modify: `docs/roadmap/2026-09-11-owner-operator.md:80` (§3.1 — the route AND the visual system), `:631` (§14 dashboard-reuse default), `:639` (one new §14 entry), `:663` (a §15 entry)
- Modify: `docs/runbooks/beta-launch-alerting.md:412` (rule 11 → BUILT), `:350` (the §1 checkbox's Response block), `:438` (a new "Rule 11 — …" prose note)
- Modify: `docs/context/owner-operator.md:29` (two new terms)
- Modify: `CONTEXT-MAP.md:25` (the two terms join the row)
- Modify: `.claude/reference/env-vars.md:661` (the staging-flip note)
- Modify: `docs/eservices-variables.md:215` (the status glyph and note)
- Modify: `.claude/reference/lab-notes/postgres.md:10` (23 → 25) and `:17` (two live parse sites)
- Modify: `docs/directory/lib-owner-operator.md:23` (two new rows)
- Modify: `docs/directory/app-api-b.md:79` (an `operator/` section)
- Modify: `docs/directory/app-authenticated.md:34` (the page rows)
- Modify: `docs/directory/components.md:33` (the three shell rows)

**Completion evidence:** `pnpm ci:directory-map` green (it fails on a production file under `src/lib/` with no row — `apply.ts` and `version-token.ts` are the two that can fail it); every `path:line` in the inserted prose re-resolved with `sed -n` at the commit SHA; `rg -n '<staging-rule-id>|<prod-rule-id>' docs/` returns nothing.

- [ ] **Step 1: Correct spec §3.1 and add the §14 entries**

In `docs/roadmap/2026-09-11-owner-operator.md`, replace line 80:

```
Route: `src/app/(authenticated)/dashboard/operator/page.tsx`, URL
`/dashboard/operator`. **Both halves of this line were corrected in Run B
(2026-09-12):** the route was written as a top-level `src/app/(authenticated)/operator/page.tsx`,
and it sits under `dashboard/` so it rides `src/proxy.ts`'s existing owner-page
branch (login redirect, `role === 'owner'`, AAL2) with no change to the proxy;
and the visual system was written as "Island", which is wrong — the screen is
inside the authenticated shell, which already loads `_styles/tokens.css` +
`_styles/console.css` and wraps everything in `.rw-console`
(`src/app/(authenticated)/layout.tsx:31-32`, `:182`), so an Island surface there
would be a second visual system inside one shell. Visual system: **Console
(Harbor)**; see `repworth-brand-design`. Two regions:
```

Replace line 631 (the dashboard-reuse default) with:

```
- Whether the summary panel reads should be one aggregated route or reuse the dashboard payload. **2026-09-12 (Run B): the "reuse" default is REFUTED and the question is closed.** The architecture pass (H1-D) measured the dashboard payload field by field: the rating band buckets ALL rated reviews where the Operator wants pending drafts by star (`readStarBands` is the right reader); the posted count is ABSENT (`totalReviewsHandled` is all-time, `recentReviewCount` a capped *received* sample — `readPosted7d` is the right reader); and the per-location DTO carries no location list. Importing the assembled DTOs would also drag in a 45-second Redis TTL cache plus ranking, velocity and briefs, and two of four fields would still be wrong. Run A's granular helpers — `getPendingApprovalCountsForAccount`, `readPosted7d`, `getAutoApprovalSettings`, `readVoiceConfig`, already wired into `getConversationForOwner` — are the source, and `SummaryPanel.tsx` is a pure renderer over them.
```

Append one entry at the end of §14 (after line 639, before `## 15. Review log`):

```
- **Go-live alerting for the six DOMAIN terminal reasons — settled 2026-09-12 (Run B, decision D6): structured logs only, no Sentry rule.** `operator_disabled` is an orderly flag-off skip and `budget_exceeded` is a per-account terminal; neither is an incident, and a rule that pages on both would train the operator to ignore the lane. The two paths that ARE alerted stay alerted: a `job_outbox` row for topic `agent_turn` landing `failed` raises `outbox_failed:agent_turn` through runbook rule 1, and BullMQ retry exhaustion reaches Sentry through `worker/job-failure-sink.ts` under runbook **rule 11**, which Run B built in both Sentry projects before the staging flip. The distribution is read from the rows instead, on staging with the flag on: `SELECT failure_reason, count(*) FROM agent_turns WHERE created_at > now() - interval '7 days' GROUP BY 1`. **Revisit trigger: the §12.1 checkpoint.** If any domain reason is materially represented there, it earns its own rule then — with a real rate to set the threshold from, which is the thing this decision was missing.
```

- [ ] **Step 2: Add the §15 build-log entry**

Append at the end of `docs/roadmap/2026-09-11-owner-operator.md` (after line 663):

```
- 2026-09-12, **Run B built** (`feat/owner-operator-run-b`): the **Version token**
  module and its single JSONB parse site; `applyProposal` — contract check before
  any lock, then one transaction that locks `businesses` then the proposal,
  revalidates actor / subscription / tier / ownership under those locks, compares
  the three tokens text to text, writes only the operation's own fields through
  the shared voice writer, reads the state back, writes the server-owned
  **Receipt**, and marks sibling pending Proposals on the location stale;
  `declineProposal` (actor only, idempotent); the two POST routes and their
  result-kind map; `?locationId=` and `connectionStatus` on the conversation
  read; ONE `hasImpersonationCookie`; `/api/operator` on the owner-API AAL2
  allowlist; and the Operator screen — Console (Harbor), URL-state polling with
  back-off and a 4-minute ceiling, per-reason failure wording, the All-locations
  chooser, the Proposal card with its Receipt and **Refresh plan**, the
  Requested-capability card, and the summary panel. The screen sits at
  `/dashboard/operator` (owner decision 2026-09-12) so it rides the existing
  owner-page proxy branch rather than needing a new one. NOT built, deliberately: the
  three auto-approval proposables, `patchAutoApprovalSettingsInTransaction`, the
  consequence line, asymmetric friction, undo from Receipts, and any production
  flag flip. §3.1's visual system was corrected from Island to Console; §14's
  dashboard-reuse default was refuted; the domain-terminal alerting question was
  closed as logs-only with rule 11 built in both Sentry projects. T8 (the staging
  flip, p50/p95, the constants tune and the §12.1 checkpoint report) is a
  follow-up PR — see `docs/superpowers/plans/feat-owner-operator-run-b-plan.md`.
  Two plan decisions were reversed by the owner before execution and are
  recorded in `docs/superpowers/plans/feat-owner-operator-run-b-deviations.md`:
  the page route (top-level → under `dashboard/`) and the nav-section test's
  home (a new file → the existing `active-nav.test.ts`).
```

- [ ] **Step 3: Flip runbook rule 11 to BUILT and add its triage note**

**Precondition — the root's external action:** rule 11 is created in BOTH Sentry projects before this step. Filter `subsystem` equals `worker_job` **AND** `queue` equals `agent_turn`; trigger every event; destination the Discord route; level `error` (the `captureException` default). Record both rule ids.

In `docs/runbooks/beta-launch-alerting.md`, replace the Rule-name cell of line 412 so the row reads:

```
| 11 | `agent-turn-exhausted → discord` (Owner Operator, red-team P1-3) **BUILT 2026-09-12, staging rule `<staging-rule-id>`, production rule `<prod-rule-id>`** | `subsystem` equals `worker_job` **AND** `queue` equals `agent_turn` | **every event** | `error` (the `captureException` default) |
```

Add a prose note after the Rule 10 block ends at line 437 and before the blockquote at line 439 — matching the `**Rule N — <title> (#ticket).**` shape rule 10 uses:

```
**Rule 11 — Owner Operator `agent_turn` retry exhaustion (Run B).** The event is
whatever `worker/job-failure-sink.ts` captures after BullMQ exhausts the job's
attempts, tagged `subsystem:worker_job` and `queue:agent_turn`. It carries ids
only — never owner text, a **Reply segment**, a **Proposal** body or a
**Receipt**.

**Triage — `outbox_id` → `job_outbox.payload` → `agent_turns.status`.** The
Sentry event names the outbox row, not the turn, so the walk is three steps and
must be done in this order; skipping to `agent_turns` means guessing which turn
the alert was about.

```sql
-- 1. The outbox row the failed dispatch owned. `payload` carries the ids.
SELECT id, topic, status, attempts, updated_at, payload
FROM job_outbox
WHERE id = '<outbox_id from the Sentry event>';

-- 2. The turn that row points at, and where it actually stopped.
SELECT id, account_id, status, failure_reason, attempt, claimed_at, completed_at
FROM agent_turns
WHERE id = (
  SELECT payload ->> 'turn_id'
  FROM job_outbox
  WHERE id = '<outbox_id from the Sentry event>'
)::uuid;
```

Read the pair together. A turn that is `failed` with `failure_reason =
'exhausted'` is the expected end state and the alert is informational. **A turn
still `accepted` or `running` beside a terminal `job_outbox` row is the
stranded-turn case (§14, CA1)**: nothing will ever complete it, its successors
in that conversation will fail `predecessor_stalled` after 20 minutes, and the
owner's screen times out after 4 minutes and offers a new conversation. The
operator's action is to confirm the account and tell the owner to start a new
conversation; the durable fix is a turn-aware exhaustion hook in `OutboxPoller`,
which is not built.

Distribution of the six DOMAIN terminal reasons, which have NO Sentry rule by
decision (spec §14, 2026-09-12):

```sql
SELECT failure_reason, count(*)
FROM agent_turns
WHERE created_at > now() - interval '7 days'
GROUP BY 1;
```
```

Also append a `**Response:**` line to the existing §1 checkbox for this rule, after `docs/runbooks/beta-launch-alerting.md:350`:

```
  **Response:** walk `outbox_id` → `job_outbox.payload` → `agent_turns.status`
  (the Rule 11 note in §1a-do carries the two queries). An `exhausted` turn is
  the expected end state; a non-terminal turn beside a terminal outbox row is
  the stranded-turn case and the owner must start a new conversation.
```

- [ ] **Step 4: Coin the two glossary terms**

Append to `docs/context/owner-operator.md` (after line 29):

```
- **Receipt**: the server-written `agent_proposals.receipt` JSONB — operation, scope, the `before` the card showed, the `after` that actually committed, `differsFromPreview`, `effectiveNow`, what it affects, what remains blocked, `appliedAt`, the actor, the VERBATIM `owner_text` of the turn that produced the **Proposal**, the turn id as correlation id, and the **Version token** on both sides of the write. **Written in the SAME transaction as the mutation, and only there**: there is no committed mutation without a Receipt and no Receipt without a committed mutation, and the client supplies no field of it. A repeat Apply returns the stored one and executes nothing. _Avoid_: confirmation, result, audit entry, changelog. *(coined in the Run B intake, 2026-09-12)*

- **Refresh plan**: the action a `stale` or `contract_changed` **Proposal** card offers — **a new Operator turn posted from that Proposal's ORIGINAL `owner_text`**, not a retry of the Apply. The settings moved (or the code did), so the plan must be prepared again against the state that exists now; the owner's own words are the only input still true. It creates a fresh **Proposal**; it never revives the stale one. _Avoid_: retry, re-apply, regenerate, refresh. *(coined in the Run B intake, 2026-09-12)*
```

In `CONTEXT-MAP.md`, replace the Owner Operator row (line 25) so its `Terms:` list gains the two, in the order they are coined:

```
- [Owner Operator](./docs/context/owner-operator.md) — the conversational configuration surface: one owner message, one model reply built of validated segments, the stored proposals it prepares, and the receipt one approved click produces. Terms: **Operator turn**, **Turn claim**, **Fenced completion**, **Context snapshot**, **Reply segment**, **Proposal**, **Requested capability**, **Contract version**, **Version token**, **Operating rules**, **Pasted-review scrub**, **Operator flag**, **Receipt**, **Refresh plan**.
```

- [ ] **Step 5: Amend the two env inventories for the staging flip**

Both rows already exist; this AMENDS them rather than adding rows. In `.claude/reference/env-vars.md`, append to the Prerequisite cell of line 661 (`OWNER_OPERATOR_ENABLED`), inside the same cell:

```
 **Run B (2026-09-12) made the flag reach a UI:** with it on, `/dashboard/operator` renders and both navs show the entry; with it off `page.tsx` calls `notFound()` and neither nav shows a link — server-authoritative through a prop, still no `NEXT_PUBLIC` companion. Turning it on also opens the two mutation routes `POST /api/operator/proposals/:id/{apply,decline}`, which change a location's voice columns through the shared writer. **Before flipping it on in ANY environment, Sentry rule 11 must exist in that environment's Sentry project** (`docs/runbooks/beta-launch-alerting.md`, rule 11) — it is the only alert on the `agent_turn` lane's retry exhaustion. Staging first, per the flag-flip skill; production stays off.
```

In `docs/eservices-variables.md`, replace line 215:

```
| `OWNER_OPERATOR_ENABLED` | ⬜ | Owner Operator turn pipeline **and the `/dashboard/operator` screen + apply/decline routes (Run B)** — requires migration 120 in that environment AND Sentry rule 11 in that environment's project before the flip |
```

- [ ] **Step 6: Register the two new JSONB parse sites**

In `.claude/reference/lab-notes/postgres.md`, change the header count on line 10 from `**Exactly 23 production JSONB field-to-parser sites today:**` to `**Exactly 25 production JSONB field-to-parser sites today:**`, and replace the Owner Operator bullet (line 17) with:

```
- Owner Operator (6): `agent_turns.reply` through `parseReplySegments` (called in `context.ts` and twice in `reads.ts`), and `agent_proposals.input` + `.before` + `.after` through the shared `parseJsonbObject` (called in `proposals.ts`), both reached from `src/lib/agents/operator/schema.ts` (`parseReplySegments` is defined there; `parseJsonbObject` is re-exported from `agents/read.ts`). Run B added the last two, both read by `mapStored` in `proposals.ts`: `agent_proposals.prepared_version_token` through `parseVersionToken` (`src/lib/agents/operator/version-token.ts` — its own module because `apply.ts` and the apply route's body schema both need the shape, and the token's text-to-text rule needs one owner), and `agent_proposals.receipt` through `parseReceipt` (`schema.ts`, returning `null` for the un-applied rows rather than throwing). Each narrows and throws on a shape the writers cannot have produced — the `parseEvidence` posture.
```

- [ ] **Step 7: Add every directory row**

In `docs/directory/lib-owner-operator.md`, append two rows to the first table (it ends at line 23; line 24 is blank). **These two are the only rows `ci:directory-map` can fail on** — the gate covers `worker/` and `src/lib/` and nothing under `src/app/**` or `src/components/**`:

```
| `apply.ts` | **Run B.** The Apply protocol behind one call: the **Contract version** check before any lock, then one transaction that locks the `businesses` row and THEN the proposal row, revalidates actor / subscription / tier / ownership under those locks, compares current / prepared / expected **Version token**s text to text, writes only the operation's own fields through the shared voice writer, reads the state back, writes the **Receipt**, and marks sibling pending **Proposal**s on that location stale. Six result kinds; every non-`not_found` one carries the row. A thrown executor rolls mutation and Receipt back together; a deterministic refusal commits `failed`/`write_failed`. |
| `version-token.ts` | **Run B.** The voice-scope **Version token**: its type, its `.strict()` schema (reused by the apply route's body), its JSONB parse site and its equality. TEXT END TO END — no `Date` anywhere, because postgres.js truncates the microseconds Postgres stores and a round-tripped token compares equal to a row written a microsecond later. |
```

In `docs/directory/app-api-b.md`, insert a new section at line 79 (after the admin table ends at `:78`, before the `contact/` heading at `:80`) — the three Run A routes have never had rows, so this adds all five at once:

```
#### `operator/`

The **Owner Operator** API, gated by `OWNER_OPERATOR_ENABLED` (404 `operator_disabled` before auth when off) and inside `isProtectedOwnerApiRoute`, so proxy branch 6 applies the owner AAL2 gate. Glossary: `docs/context/owner-operator.md`.

| Route | What it does |
|-------|--------------|
| `turns/route.ts` | POST: **Run A.** One transaction — upsert the conversation, insert the `accepted` **Operator turn**, enqueue the `agent_turn` outbox row. Idempotent on `(account_id, client_turn_key)`; same payload returns the ids, different payload is 409. Impersonated sessions are refused 409. |
| `turns/[id]/route.ts` | GET: **Run A.** The polled turn, account-scoped. Status, rendered **Reply segment**s, `proposals` and `unsupported` under separate keys. A malformed id is the same 404 a foreign one gets. |
| `conversation/route.ts` | GET: **Run A**, deepened in Run B. The transcript (50 most recent turns) plus the live summary panel. `?id=` selects a conversation; **Run B's `?locationId=` scopes the summary when the conversation has no turns yet**, and the summary carries the location's `connectionStatus`. |
| `proposals/[id]/apply/route.ts` | POST: **Run B.** `withSameOrigin` → flag → `requireWritableOwner` → impersonation → `{ expectedVersionToken }` (`.strict()`, no `confirmationLevel` — that is slice 2) → `applyProposal`. Maps six result kinds: applied 200, stale 409 `proposal_stale`, rejected 409 `<reason>`, not-pending 409, failed 500 `apply_failed`, not-found 404. Every non-404 body carries the **Proposal** row. |
| `proposals/[id]/decline/route.ts` | POST: **Run B.** Same gates, no body. `declineProposal` records the actor only and is idempotent; an already-decided **Proposal** answers 409 `proposal_not_pending`. |
```

In `docs/directory/app-authenticated.md`, append to the `(authenticated)/` table at line 35 (it runs 9–34):

```
| `dashboard/operator/page.tsx` | **(Owner Operator Run B)** `/dashboard/operator` — the conversational configuration screen. Server component so the `OWNER_OPERATOR_ENABLED` gate stays server-authoritative (invariant #13): `notFound()` when off, then `OperatorClient` inside a `<Suspense>` boundary, which `useSearchParams` requires. Console (Harbor), correcting spec §3.1's "Island". |
| `dashboard/operator/OperatorClient.tsx` | **(Owner Operator Run B)** The conversation state machine. Holds `conversationId` + `turnId` in URL state so a refresh resumes the same turn; POSTs `/api/operator/turns` with the SELECTED location frozen into the row; polls `GET /api/operator/turns/:id` at 2 s, backing off to 5 s after 30 s, with a hard 4-minute ceiling (spec §14 CA1 — a stranded turn never answers) that offers "Keep waiting" or a new conversation. Renders per-reason failure wording, stops on a 404 `operator_disabled` from any route, disables the composer under `All locations` behind an inline chooser that drives the existing scope, and owns the Apply / Not now / **Refresh plan** writes. |
| `dashboard/operator/ProposalCard.tsx` | **(Owner Operator Run B)** One **Proposal** as a Harbor card, entirely from the stored row: the catalog describer, the target from the TURN's stored location (never the browser's selector), before/after, "Future drafts only", and Apply / Not now. Adds `Prepared for <location>` when the selector has moved, the **Receipt** once applied, and **Refresh plan** on `version_mismatch` or `contract_changed`. |
| `dashboard/operator/ReceiptView.tsx` | **(Owner Operator Run B)** The server-written **Receipt**, rendered as a passthrough — nothing here recomputes a value or reads a live count. Flags `differsFromPreview` when the committed state is not what the plan previewed. |
| `dashboard/operator/RequestedCapabilityCard.tsx` | **(Owner Operator Run B)** A **Requested capability**: the normalized request and "RepWorth cannot do this yet. Nothing changed." No interactive element at all — a separate kind, not a Proposal with no button. |
| `dashboard/operator/SummaryPanel.tsx` | **(Owner Operator Run B)** Waiting for you / Recently completed / Current operating rules, each with the server's own `asOf`, plus the existing connect call to action when the location's `connectionStatus` is not `active`. A pure renderer over Run A's granular helpers — it imports NO dashboard DTO (architecture pass H1-D). |
| `dashboard/operator/StarterActions.tsx` | **(Owner Operator Run B)** The three fixed starter messages (Set up replies / Change my tone / Show what needs me). Each POSTS its message rather than pre-filling the composer. |
| `dashboard/operator/wording.ts` | **(Owner Operator Run B)** Every owner-facing string on the screen: the seven `TURN_FAILURE_REASON` sentences, the **Proposal** status and failure sentences, the route error codes, and the fixed notices. No `'use client'`, so the server page can import the title. |
| `dashboard/operator/operator.css` | **(Owner Operator Run B)** Screen-local Console styles. Loads after `console.css` and therefore owns every `.op-*` selector; `.panel` and a bare `.stat` do not exist in the Console stylesheets, which is why `.op-panel` and `.op-kv` are defined here. |
```

In `docs/directory/components.md`, add three rows beside the existing `dashboard/shell/*` cluster (lines 31–33):

```
| `dashboard/shell/Sidebar.tsx` | The Console's desktop rail: identity (account control + the location the numbers describe), the work group with its pending badge, children that appear only under the active section, and the utility dock. Every flag-gated row — Requests, and the Operator row added in Run B — is driven by a server-authoritative prop from `(authenticated)/layout.tsx`, never a `NEXT_PUBLIC` companion (invariant #13). |
| `dashboard/shell/MobileTabBar.tsx` | The fixed bottom bar below the sidebar breakpoint. Five tabs by default — the third slot FOLDS Requests and Review QR rather than shrinking — plus a sixth Operator tab when its server-authoritative prop is true. Six is the ceiling: at 390px each tab gets a 57px content box, which fits an 8-character label and would not fit a 10-character one. |
| `dashboard/shell/active-nav.ts` | Single owner of the nav-highlight rule: pathname → one `NavSection` (`dashboard`, `reviews`, `requests`, `analytics`, `operator`, `settings`), so the two navs cannot drift and two rows cannot highlight at once. Also owns `SETTINGS_DEFAULT_HREF`. No `'use client'`, so a server page can import it. |
```

- [ ] **Step 8: Verify and commit**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b && pnpm ci:directory-map && rg -n '<staging-rule-id>|<prod-rule-id>' docs/ .claude/ || true`
Expected: `directory-map-audit: passed`, and the `rg` prints NOTHING — if it prints the placeholders, the root has not supplied the rule ids and this task is not done.

Re-resolve every `path:line` the inserted prose cites, at the current HEAD, before committing:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
for pair in "src/app/(authenticated)/layout.tsx:31" "src/app/(authenticated)/layout.tsx:182" \
            "src/app/(authenticated)/layout.tsx:77" "src/app/(authenticated)/layout.tsx:97" \
            "src/proxy.ts:366" "src/proxy.ts:385"; do
  printf '%-48s | ' "$pair"; sed -n "${pair##*:}p" "${pair%:*}"
done
```

Expected: each prints the line the prose describes. **A citation that has moved is corrected here, not carried.**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add docs/roadmap/2026-09-11-owner-operator.md \
        docs/runbooks/beta-launch-alerting.md \
        docs/context/owner-operator.md \
        CONTEXT-MAP.md \
        .claude/reference/env-vars.md \
        docs/eservices-variables.md \
        .claude/reference/lab-notes/postgres.md \
        docs/directory/lib-owner-operator.md \
        docs/directory/app-api-b.md \
        docs/directory/app-authenticated.md \
        docs/directory/components.md
git commit -m "docs(operator): Run B — Console correction, the logs-only alerting decision with rule 11 BUILT, Receipt and Refresh plan in the glossary, and every registry row"
```

---

### Task T7: The e2e spec, its SQL seed helper, and the browser evidence at 390 and 1440

**Blocking edges:** T1, T2, T3, T4, T5 — it exercises the whole screen against real routes and a real database. **Lease:** `e2e/operator.spec.ts`, `e2e/helpers/operator-seed.ts`, `docs/reviews/feat-owner-operator-run-b/evidence/*.png`.

**Turns green (verbatim):**
39. `e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440`
40. `e2e: a settings write between proposal and Apply produces a stale card with Refresh plan`

**Files:**
- Create: `e2e/helpers/operator-seed.ts`
- Modify: `e2e/operator.spec.ts` (convert the two T0 fixmes)
- Create: `docs/reviews/feat-owner-operator-run-b/evidence/*.png`

**Precedent paths:** `e2e/harness.ts:31-32` (`isAuthHarnessConfigured`, false in CI because the staging Supabase secrets never reach a runner) · `e2e/harness.ts:88-101` (`createOwnerUser`) · `e2e/harness.ts:150-171` (`signInViaMagicLink`) · `e2e/seed.ts:95` (`getE2eSql`) · `e2e/seed.ts:671-731` (`seedAuthOwnerAccount` / `cleanupAuthOwnerAccount` — the latter is reached through `deleteOwnerUser`, `e2e/harness.ts:214-217`, and is NOT a harness export) · `e2e/owner-channels.spec.ts:26-31` (the unauthenticated-redirect block that runs in CI).

**How the worker is stood in for — and what is NOT stood in for.** The OWNER sends the turn, through the composer: the POST route, its transaction and its outbox row all run for real, and `countTurns` asserts exactly one turn exists afterwards. Only the worker's half is simulated, and it is simulated **through the production builders** — `readVoiceConfig` → `buildProposalRows` → `insertProposals`, the same three functions `worker/jobs/agent-turn/AgentTurnWorker.ts:211-214` calls. That matters beyond tidiness: a hand-typed Proposal fixture omits the `updatedAt` key the real preview carries (RB-01), so it would render and apply cleanly in a test while every real row failed. There is no Railway worker in an e2e run and no provider key; everything else on the path is real.

**Completion evidence:** `pnpm test:e2e` green (the two signed-in flows run locally with the harness env exported, and self-skip in CI); nine PNGs under `docs/reviews/feat-owner-operator-run-b/evidence/`; the stored row asserted behind each browser assertion.

- [ ] **Step 1: Write the seed helper**

Create `e2e/helpers/operator-seed.ts`:

```ts
// e2e/helpers/operator-seed.ts
//
// The WORKER STAND-IN for the Operator e2e flows. A Playwright run has no
// Railway worker and no provider key, so these helpers do with SQL what
// `AgentTurnWorker` would have done — but THROUGH THE PRODUCTION BUILDERS, not
// by hand-typing rows.
//
// That distinction is the point. `AgentTurnWorker` builds a Proposal from
// `readVoiceConfig`'s result (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`),
// whose type is `VoiceConfig & { updatedAt }`; `preview` returns that object as
// `before` and spreads it into `after` (`src/lib/agents/operator/catalog.ts:96-98`);
// and `buildProposalRows` stores both (`src/lib/agents/operator/proposals.ts:77-78`).
// A hand-typed five-key fixture silently omits that sixth key and cannot catch
// a reader that rejects the real shape. So the helper calls the same three
// functions the worker calls.
//
// The OWNER still sends the turn, through the UI. This file only completes it.
import { buildProposalRows, insertProposals } from '@/lib/agents/operator/proposals';
import { proposableOperation } from '@/lib/agents/operator/catalog';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { getE2eSql } from '../seed';

export interface CompletedTurn {
  conversationId: string;
  turnId: string;
  proposalId: string;
  /** The token the card will send back on Apply. */
  versionToken: { businessId: string; updatedAt: string };
}

/** The most recent non-terminal turn for an account — the one the UI just POSTed. */
export async function findAcceptedTurn(accountId: string): Promise<{
  id: string; conversationId: string; locationId: string; ownerText: string;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    id: string; conversation_id: string; location_id: string; owner_text: string;
  }[]>`
    SELECT id, conversation_id, location_id, owner_text
    FROM agent_turns
    WHERE account_id = ${accountId}::uuid
      AND status IN ('accepted', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row) throw new Error('operator-seed: no accepted turn — did the UI send one?');
  return {
    id: row.id,
    conversationId: row.conversation_id,
    locationId: row.location_id,
    ownerText: row.owner_text,
  };
}

/**
 * Completes an ALREADY-SENT turn the way the worker would: one `set_tone`
 * **Proposal** built by `buildProposalRows`, and a stored reply whose
 * `proposal` segment references it.
 */
export async function completeTurnWithProposal(input: {
  accountId: string;
  userId: string;
  tone?: string;
}): Promise<CompletedTurn> {
  const sql = getE2eSql();
  const turn = await findAcceptedTurn(input.accountId);
  const tone = input.tone ?? 'warm and brief';

  const voice = await readVoiceConfig(sql, {
    accountId: input.accountId,
    locationId: turn.locationId,
  });
  if (!voice) throw new Error('operator-seed: voice row not found');

  const operation = proposableOperation('set_tone');
  if (!operation) throw new Error('operator-seed: set_tone left the catalog');
  const parsed = operation.parseInput({ tone });
  if (!parsed.ok) throw new Error('operator-seed: set_tone rejected its own input');

  const rows = buildProposalRows(
    {
      conversationId: turn.conversationId,
      turnId: turn.id,
      accountId: input.accountId,
      actorUserId: input.userId,
      locationId: turn.locationId,
    },
    [{
      operation,
      input: parsed.input,
      scope: { accountId: input.accountId, locationId: turn.locationId },
      rationale: 'You asked for warmer replies.',
    }],
    voice,
  );

  await sql.begin(async (tx) => {
    await insertProposals(tx, rows);
    await tx`
      UPDATE agent_turns
      SET status = 'completed',
          reply = ${tx.json([
            { type: 'text', text: 'Here is a plan for your reply tone.' },
            { type: 'proposal', proposalId: rows[0]!.id },
          ] as never)},
          completed_at = NOW()
      WHERE id = ${turn.id}::uuid AND account_id = ${input.accountId}::uuid
    `;
  });

  return {
    conversationId: turn.conversationId,
    turnId: turn.id,
    proposalId: rows[0]!.id,
    versionToken: { businessId: turn.locationId, updatedAt: voice.updatedAt },
  };
}

/**
 * Moves `businesses.updated_at` the way a settings-form PUT would — the STALE
 * fixture. It writes a real voice column so the move is a genuine write and
 * not a bare timestamp touch, which is what a real concurrent edit looks like.
 */
export async function moveVoiceRow(input: {
  accountId: string;
  businessId: string;
  tone: string;
}): Promise<void> {
  const sql = getE2eSql();
  await sql`
    UPDATE businesses
    SET tone = ${input.tone}, updated_at = NOW()
    WHERE id = ${input.businessId}::uuid AND account_id = ${input.accountId}::uuid
  `;
}

/** Row-state assertions the browser flow checks its claims against. */
export async function readProposalRow(proposalId: string): Promise<{
  status: string; failure_reason: string | null; receipt: unknown; decided_by_user_id: string | null;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    status: string; failure_reason: string | null; receipt: unknown; decided_by_user_id: string | null;
  }[]>`
    SELECT status, failure_reason, receipt, decided_by_user_id
    FROM agent_proposals WHERE id = ${proposalId}::uuid
  `;
  if (!row) throw new Error('operator-seed: proposal row not found');
  return row;
}

export async function readTone(businessId: string): Promise<string | null> {
  const sql = getE2eSql();
  const [row] = await sql<{ tone: string | null }[]>`
    SELECT tone FROM businesses WHERE id = ${businessId}::uuid
  `;
  return row?.tone ?? null;
}

export async function countTurns(accountId: string): Promise<number> {
  const sql = getE2eSql();
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM agent_turns WHERE account_id = ${accountId}::uuid
  `;
  return row?.count ?? 0;
}

/**
 * Removes every row these helpers created for one account. Runs BEFORE
 * `deleteOwnerUser`, which deletes the businesses and the account those rows
 * reference by foreign key.
 */
export async function cleanupOperatorSeed(accountId: string): Promise<void> {
  const sql = getE2eSql();
  await sql`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
}
```

- [ ] **Step 2: Convert the two Playwright fixmes**

Replace the `test.describe('Operator screen — authenticated', …)` block in `e2e/operator.spec.ts`:

```ts
test.describe('Operator screen — authenticated', () => {
  // The staging Supabase secrets never reach a CI runner, so these self-skip
  // there and run locally against the harness (e2e/harness.ts:31-32). The
  // unauthenticated redirect above runs everywhere.
  test.skip(!isAuthHarnessConfigured, 'auth harness env not set (local only)');

  let owner: OwnerHandle;

  test.beforeEach(async () => { owner = await createOwnerUser(); });

  test.afterEach(async () => {
    if (owner) {
      // Operator rows FIRST: `deleteOwnerUser` deletes the businesses and the
      // account they reference by foreign key (e2e/harness.ts:214-217).
      await cleanupOperatorSeed(owner.seed.accountId);
      await deleteOwnerUser(owner);
    }
  });

  test('e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440', async ({ page }) => {
    await signInViaMagicLink(page, owner.email, '/dashboard/operator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/operator');
    await expect(page.getByRole('heading', { name: 'Operator' })).toBeVisible();
    await page.screenshot({
      path: 'docs/reviews/feat-owner-operator-run-b/evidence/empty-screen-1440.png',
      fullPage: true,
    });

    // THE OWNER SENDS. This is the POST route, the transaction and the outbox
    // row — not a hand-written conversation.
    await page.getByRole('textbox', { name: /message/i }).fill('Make my replies warmer.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Preparing your plan')).toBeVisible();
    expect(await countTurns(owner.seed.accountId)).toBe(1);

    // THE WORKER'S HALF, through the production builders — `readVoiceConfig`,
    // `buildProposalRows`, `insertProposals`. The stored preview therefore has
    // the real six-key shape, which is the shape the card has to render.
    const completed = await completeTurnWithProposal({
      accountId: owner.seed.accountId,
      userId: owner.seed.userId,
    });

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect(page.getByText('Set the reply tone to "warm and brief"')).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: `docs/reviews/feat-owner-operator-run-b/evidence/proposal-card-${viewport.width}.png`,
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Applied')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Make my replies warmer.').first()).toBeVisible();
    await page.screenshot({
      path: 'docs/reviews/feat-owner-operator-run-b/evidence/receipt-1440.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: 'docs/reviews/feat-owner-operator-run-b/evidence/receipt-390.png',
      fullPage: true,
    });

    // THE ROW BEHIND THE SCREEN. A green browser assertion over a Receipt that
    // did not commit is the failure this asserts away.
    const row = await readProposalRow(completed.proposalId);
    expect(row.status).toBe('applied');
    expect(row.failure_reason).toBeNull();
    expect(row.receipt).not.toBeNull();
    expect(row.decided_by_user_id).toBe(owner.seed.userId);
    expect(await readTone(owner.seed.businessId)).toBe('warm and brief');
    // ONE turn: the send was not duplicated by a retry or a re-render.
    expect(await countTurns(owner.seed.accountId)).toBe(1);
  });

  test('e2e: a settings write between proposal and Apply produces a stale card with Refresh plan', async ({ page }) => {
    await signInViaMagicLink(page, owner.email, '/dashboard/operator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/operator');

    await page.getByRole('textbox', { name: /message/i }).fill('Make my replies warmer.');
    await page.getByRole('button', { name: 'Send' }).click();
    const completed = await completeTurnWithProposal({
      accountId: owner.seed.accountId,
      userId: owner.seed.userId,
    });
    await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible({ timeout: 15_000 });

    // THE CONCURRENT WRITE, after the card rendered and before the click.
    await moveVoiceRow({
      accountId: owner.seed.accountId,
      businessId: owner.seed.businessId,
      tone: 'formal and precise',
    });

    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(/settings changed after this plan was prepared/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Refresh plan' })).toBeVisible();
    await page.screenshot({
      path: 'docs/reviews/feat-owner-operator-run-b/evidence/stale-card-1440.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: 'docs/reviews/feat-owner-operator-run-b/evidence/stale-card-390.png',
      fullPage: true,
    });

    const row = await readProposalRow(completed.proposalId);
    expect(row.status).toBe('stale');
    expect(row.failure_reason).toBe('version_mismatch');
    expect(row.receipt).toBeNull();
    // NOTHING was applied: the concurrent write's value stands untouched.
    expect(await readTone(owner.seed.businessId)).toBe('formal and precise');

    // REFRESH PLAN posts a NEW turn from the original instruction and the
    // original location (RB-03).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Refresh plan' }).click();
    await expect(page.getByText('Preparing your plan')).toBeVisible({ timeout: 15_000 });
    expect(await countTurns(owner.seed.accountId)).toBe(2);
    const refreshed = await findAcceptedTurn(owner.seed.accountId);
    expect(refreshed.ownerText).toBe('Make my replies warmer.');
    expect(refreshed.locationId).toBe(owner.seed.businessId);
  });
});
```

and add to the file's import block:

```ts
import { expect } from '@playwright/test';
import {
  createOwnerUser,
  deleteOwnerUser,
  isAuthHarnessConfigured,
  signInViaMagicLink,
  type OwnerHandle,
} from './harness';
import {
  cleanupOperatorSeed,
  completeTurnWithProposal,
  countTurns,
  findAcceptedTurn,
  moveVoiceRow,
  readProposalRow,
  readTone,
} from './helpers/operator-seed';
```

`deleteOwnerUser` (`e2e/harness.ts:214-217`) is the complete owner teardown and takes the whole `OwnerHandle`. `cleanupAuthOwnerAccount` is NOT an export of `harness.ts` — it lives in `e2e/seed.ts` and is called by `deleteOwnerUser` — so importing it from the harness would fail at collection. `harness.ts` is outside this run's edit surface and needs no change.

- [ ] **Step 3: Run the spec**

Run:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
pnpm test:e2e -- operator.spec.ts
```

Expected in CI and without the harness env: the unauthenticated redirect PASSES, the two signed-in flows SKIP. Locally with `E2E_SUPABASE_URL`, `E2E_SUPABASE_SERVICE_KEY`, `TEST_DATABASE_POOL_URL` and `OWNER_OPERATOR_ENABLED=true` exported: all three pass.

- [ ] **Step 4: Capture the remaining browser evidence**

The spec's own screenshots cover four of the nine states. Capture the other five with the local stack, because they need conditions a Playwright assertion should not manufacture inside a passing test.

**How the local stack runs for this:** put `OWNER_OPERATOR_ENABLED=true` and `MOCK_EXTERNAL_APIS=true` in `.env.local`, run `pnpm dev:all` (Next on 3000, the Railway worker on 3001), sign in as the harness owner, and seed with the same `e2e/helpers/operator-seed.ts` functions from a `tsx` one-liner.

Create the capture script as a scratch file (NOT committed — `e2e/` and `scripts/` additions are outside this run's surface), run it, and commit only the PNGs:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
mkdir -p docs/reviews/feat-owner-operator-run-b/evidence
cat > /tmp/operator-evidence.mjs <<'SCRIPT'
import { chromium } from 'playwright';
const OUT = 'docs/reviews/feat-owner-operator-run-b/evidence';
const STATES = [
  ['empty-screen', '/dashboard/operator'],
  ['preparing', '/dashboard/operator?conversationId=CONV&turnId=TURN'],
  ['receipt', '/dashboard/operator?conversationId=APPLIED_CONV'],
  ['stale-refresh-plan', '/dashboard/operator?conversationId=STALE_CONV'],
  ['rejected-contract-changed', '/dashboard/operator?conversationId=CONTRACT_CONV'],
  ['failed-turn', '/dashboard/operator?conversationId=FAILED_CONV'],
  ['all-locations-chooser', '/dashboard/operator'],
  ['not-available', '/dashboard/operator'],
];
const browser = await chromium.launch();
const context = await browser.newContext({ storageState: '/tmp/operator-auth.json' });
for (const [name, path] of STATES) {
  for (const width of [390, 1440]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
    await page.close();
  }
}
await browser.close();
SCRIPT
node /tmp/operator-evidence.mjs
```

Before running it, substitute the four `*_CONV` placeholders with real ids from the seed helpers, save an authenticated `storageState` to `/tmp/operator-auth.json` (sign in once with `signInViaMagicLink`, then `context.storageState({ path })`), and set up the four non-happy states:

| State | How to reach it |
|---|---|
| empty screen with starter actions | a fresh `/dashboard/operator` with no `conversationId` |
| Preparing your plan | seed a conversation whose turn is left `accepted` (omit the `completeTurn` half of the helper) |
| a reply with a Proposal card | send through the UI, then `completeTurnWithProposal` |
| the Receipt after Apply | apply it through the UI, then reload the same `conversationId` |
| a stale card with Refresh plan | `moveVoiceRow`, then Apply |
| a rejected Apply (contract_changed) | `UPDATE agent_proposals SET contract_version = 2 WHERE id = …`, then Apply |
| a failed turn | `UPDATE agent_turns SET status='failed', failure_reason='model_output_invalid' WHERE id = …` |
| the All-locations chooser | set the `rw_location_scope` cookie to `all` on a two-location account |
| the disabled / not-found state | set `OWNER_OPERATOR_ENABLED=false`, restart `pnpm dev:all`, load `/dashboard/operator` (the page's not-found) and an open screen's notice |

That is nine states × two widths = **18 PNGs**, plus the four the spec captures. Name every file `<state>-<width>.png`.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b
git add e2e/operator.spec.ts e2e/helpers/operator-seed.ts docs/reviews/feat-owner-operator-run-b/evidence
git commit -m "test(operator): e2e spec, SQL worker stand-in, and browser evidence at 390 and 1440"
```

---

### Task T8: After merge — the staging flip, the latency measurement, the constants tune and the §12.1 checkpoint

**This task is a CHECKLIST, not code, and it runs AFTER the Run B PR merges** (decision D7). Its output is a follow-up PR containing the tuned constants and the checkpoint report. Nothing here is done on the Run B branch.

**Blocking edges:** the Run B merge, and T6 (rule 11 must be BUILT and recorded before the flip).

- [ ] **1. Confirm the preconditions before touching a flag.**
  - Migration 120 is in the staging database (introspect the four tables — never the Supabase migration ledger).
  - Sentry rule 11 exists in the STAGING Sentry project and `docs/runbooks/beta-launch-alerting.md:412` records its id.
  - `pnpm ci:rls-audit` and `pnpm ci:tenant-scope` were green on the merged PR.
- [ ] **2. Flip the flag on staging, through the `flag-flip` skill.** `OWNER_OPERATOR_ENABLED=true` on **both** lanes — Railway (the worker) and Vercel (the staging Custom Env) — because both read it. Production stays `false`. Follow the skill's record-and-verify steps; do not set the variable by hand without it.
- [ ] **3. Drive the §12.1 items 1–7 on staging.** A signed-in owner sends a message, receives a `set_tone` **Proposal**, applies it, and reads the **Receipt**; the next generated draft for that location reflects the new tone; a refresh during "Preparing your plan" resumes the same turn; a repeated Apply returns the original Receipt; a resent message returns the same ids; a concurrent form write marks the Proposal `stale`; another account's Proposal is 404; a bumped `contract_version` is `contract_changed`; two simultaneous dispatches produce one completed turn and one proposal set; a secondary-location turn keeps its target when the selector moves; a missing or mismatched Origin is rejected on both POST routes before any write.
- [ ] **4. Measure p50 and p95 (§12.1 item 10).** With the flag on and at least a day of traffic:

```sql
SELECT
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch from completed_at - created_at)) AS p50_seconds,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from completed_at - created_at)) AS p95_seconds,
  count(*) AS completed_turns
FROM agent_turns
WHERE status = 'completed'
  AND completed_at IS NOT NULL
  AND created_at > now() - interval '7 days';
```

  And the terminal-reason distribution the logs-only decision relies on:

```sql
SELECT failure_reason, count(*)
FROM agent_turns
WHERE created_at > now() - interval '7 days'
GROUP BY 1;
```

- [ ] **5. Tune the three constants in `worker/jobs/agent-turn/constants.ts`, under two floors that do not move.**
  - `AGENT_TURN_LEASE_SECONDS` (today 180, `worker/jobs/agent-turn/constants.ts:12`) must stay **above p95 × 1.5 AND above 2 × the provider timeout** (30 s per call, `src/lib/llm/client-options.ts`) — that is what makes a stale claim mean "crashed" rather than "slow". A lease shorter than a live call lets a second dispatch start while the first is still talking to the provider.
  - `AGENT_TURN_PREDECESSOR_STALL_SECONDS` (today 1200, `:19`) must stay **above one outbox watchdog window** (900 000 ms default) so a predecessor that merely needs re-dispatching is rescued before this turn gives up on it.
  - `AGENT_TURN_PREDECESSOR_WAIT_MS` (today 10 000, `:22`) is the only one with no floor; lower it only if p50 is well under 10 s.
  - **If the measurement does not justify a change, change nothing and record that.** A constant moved without a number behind it is the hunch §14 forbids.
- [ ] **6. Write the §12.1 checkpoint report** into `docs/roadmap/2026-09-11-owner-operator.md` as a table, one row per item 1–10:

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Owner sends, receives a tone Proposal, applies, reads an accurate Receipt | | |
| 2 | The next generated draft reflects the new tone | | |
| 3 | Refresh resumes; repeat Apply returns the original Receipt; resend returns the same ids | | |
| 4 | Concurrent form write → `stale`; another account → 404; bumped contract → `contract_changed` | | |
| 5 | Two simultaneous dispatches → one completed turn, one proposal set | | |
| 6 | Secondary-location turn keeps its target when the selector moves | | |
| 7 | Missing/mismatched Origin rejected on both POST routes before any write | | |
| 8 | Auto-approval Apply path examined; remaining work estimated in §13 | | |
| 9 | One COO-roster owner named, with an observation window | | |
| 10 | p50 and p95 turn latency recorded | | |

- [ ] **7. Add the §15 entry for the follow-up** and open the PR with the tuned constants (or the recorded decision not to tune), the checkpoint table, and the flag-flip record. `OWNER_OPERATOR_ENABLED` stays **off in production** — the production flip is its own decision, taken against the checkpoint.

---

## Parallel groups

```
T0 (alone)  →  T1 (alone)  →  { T2 | T3 }  →  { T4 | T5 }  →  T7
                                    T6 (docs, any time; commit after T1)
                                                                 T8 (after merge)
```

- **T0 alone.** It authors every promised title and is the enforcement spot check; running it beside anything else makes "did the title land" unanswerable.
- **T1 alone.** It owns `apply.ts`, `version-token.ts`, `schema.ts`, `catalog.ts` and the reader half of `proposals.ts`; T2 appends `declineProposal` to that same file afterwards, so the two cannot overlap.
- **{T2, T3}.** Disjoint by directory: T2 is `src/lib/**` + `src/app/api/**`, T3 is `src/app/(authenticated)/**` + `src/components/**`. T3 does not wait on T2 because it calls only Run A routes; the `?locationId=` it sends is ignored before T2 lands and honoured after.
- **{T4, T5}.** T4 owns the three card files plus `OperatorClient.tsx`; T5 owns `SummaryPanel.tsx`. Both need T1, T2 and T3.
- **T6 anywhere.** Docs only, no code dependency — but its `docs/directory/lib-owner-operator.md` rows describe files T1 creates, so commit it after T1 if `ci:directory-map` runs in between, and re-resolve every `path:line` against HEAD immediately before committing.
- **T7 last on the branch.** It exercises the whole screen against real routes and a real database, and its evidence is stale the moment any of T1–T5 moves.
- **T8 after merge**, as a follow-up PR (D7).

---

## Self-review record

**1. Spec coverage.** §3.1 the screen (T3 + T5; the Island→Console correction is T6). §3.2 a turn, all six steps (T3). §3.3 both card contracts, including the target-from-stored-location rule and the "prepared for" note (T4). §3.4 reply segments — Run A's renderer, unchanged; T3 renders what it returns. §5.1's two remaining routes (T2). §6.2 contract version vs. freshness (T1, and the two are refused with different reasons). §6.3 the full lifecycle — `applied` (T1), `stale` (T1), `rejected` by owner (T2) and by the server (T1), `failed` (T1), `superseded` (Run A's `supersedePendingProposals`, unchanged and rendered by T4). §6.4 the Apply protocol, all six numbered steps, with step 4 (confirmation) explicitly absent because no Run B operation widens autonomy. §6.5 every Receipt field. §7's `POST apply`/`POST decline` row (T2). §8.1, §8.3, §8.4 (T1 + T4). §12.1 items 1–10 (T8). §14's three Run B open items: the alerting decision is CLOSED (T6), the stranded turn and the clock conflict are SURFACED by the screen's 4-minute ceiling and recorded as still open. **Deferred by the intake `non_goals` and named as such:** §3.5 the consequence line, §3.3's asymmetric friction, §3.6 the policy-refused card, §6.6 undo, §10's `patchAutoApprovalSettingsInTransaction`, the three auto-approval proposables, and the "last five posted replies" list. **No uncovered in-scope requirement.**

**2. Placeholder scan.** `<staging-rule-id>` and `<prod-rule-id>` in T6 are the only placeholders in the plan, are declared as such in T6's preamble, and are gated by a `rg` in T6 Step 8 that must print nothing. Zero "TBD", zero "add appropriate error handling", zero "write tests for the above", zero "similar to Task N" — T4's card test and T5's panel test repeat their fixtures rather than referring to T1's. Two deliberate casts, each justified at the call site: `asProposal` / `asSummary` in the two component suites, which narrow a test fixture rather than widening production code. T7 Step 4's `*_CONV` tokens are inside a script the task tells the implementer to substitute before running and are not committed. Two steps tell the implementer to prefer the live file over the plan if they disagree (T2 Step 17's shim note, T7 Step 2's harness-export note) — that is deference to the authority, not a gap.

**3. Type consistency.** `VoiceVersionToken` is `{ businessId, updatedAt }` everywhere: `version-token.ts`, `ProposalView.preparedVersionToken`, `ApplyProposalInput.expectedVersionToken`, `Receipt.versionToken.{before,after}`, the apply route's body schema and the e2e seed. `Receipt` is declared once in `schema.ts` and consumed by `ProposalView.receipt`, `ReceiptView` and `ApplyResult`. `VoiceState` is the FIVE `VoiceConfig` fields and is used identically in `Receipt.before/after`, `parseVoiceState` and `ProposalCard`'s `summarize`. `ProposalView` gained `turnId`, `preparedVersionToken`, `receipt`, `appliedAt` and `failureReason`, and all three list readers plus the two new single-row readers project the same column set. `ApplyResult`'s six kinds map 1:1 to the apply route's switch and its exhaustiveness guard; `DeclineResult`'s three map 1:1 to the decline route's. `PROPOSAL_FAILURE_REASON`'s six members are exactly the keys of `PROPOSAL_FAILURE_WORDING`, and `OFFERS_REFRESH_PLAN` is a subset of them. `TURN_FAILURE_REASON`'s seven members are exactly the keys of `TURN_FAILURE_WORDING`, and `OFFERS_NEW_CONVERSATION` is a subset. `NavSection` gained `'operator'` and both navs, `deriveNavSection` and the new test agree on it. `operatorEnabled` is a required prop on both navs and is supplied by the layout in one place.

**4. Open risks, stated rather than hidden.** (a) **`deriveNavSection` is order-sensitive** now that the page is a `/dashboard` child: the operator arm must sit above the `/dashboard` catch-all, and a reordering silently folds the Operator row into Dashboard. It is pinned by its own case in the existing suite, and that case exists for exactly this reason. (b) The screen's URL moved to `/dashboard/operator` after the plan was first written; any stale `/operator` link in a doc, a runbook or a bookmark 404s rather than redirecting, because no rewrite was added. (c) T1's live-DB suite SKIPS SILENTLY without `TEST_DATABASE_POOL_URL`, and a skipped rollback proof looks exactly like a passing one — T1 Step 17 says so explicitly. (d) The `.btn` class family DESIGN.md documents and the one that exists in CSS disagree on four names; this plan writes only the three that exist, but a future Console change should reconcile them. (e) T7's evidence capture depends on a locally running `pnpm dev:all` and a hand-built `storageState`; it is the one step in the plan that is not reproducible from a single command.

---

## Review appendix

### Round 1 — titles added

Ten titles joined `tests_to_add` as a result of round 1. They are quoted here EXACTLY as they must appear in the code, and the root has added them to the intake so T0 Step 7's spot check reads all fifty.

| Id | Title | Owned by |
|---|---|---|
| R1 | `worker-produced proposals render and apply successfully` | T1, `apply.integration.test.ts` |
| R2 | `operator times out while a poll request remains unresolved` | T3, `OperatorClient.test.tsx` |
| R3 | `Refresh plan preserves the original instruction and location after scope changes` | T4, `OperatorClient.test.tsx` |
| R4 | `proposal previews expose exact fact replacements before approval` | T4, `ProposalCard.test.tsx` |
| R5 | `retry after a lost POST response resumes the original turn` | T3, `OperatorClient.test.tsx` |
| R6 | `operator renders every stored segment kind in order` | T3, `OperatorClient.test.tsx` |
| R7 | `terminal failures and requested capabilities survive reload and subsequent turns` | T3, `OperatorClient.test.tsx` |
| R8 | `loaded conversations retain identity and starting over stays empty` | T3, `OperatorClient.test.tsx` |
| R9 | `first-time owner receives a scoped summary and connection CTA before sending` | T2, `reads.integration.test.ts` |
| R10 | `repeat Apply after location archival returns the original receipt without writes` | T1, `apply.integration.test.ts` |

### Round 1 (Codex, plan-skeptic) — REVISE → 11 accepted

Every finding was verified against source by the root and accepted as written.

| Id | Severity | Disposition | Where it landed |
|---|---|---|---|
| RB-01 | high | ACCEPT | T1 Step 5 — `StoredVoiceStateSchema` accepts and DROPS the `updatedAt` every real preview carries (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214` → `src/lib/agents/operator/catalog.ts:96-98` → `src/lib/agents/operator/proposals.ts:77-78`); T1 Step 16 adds R1 through the production builders; T7 Steps 1–2 make the browser flow complete a real turn the same way, instead of hand-typing a five-key row that hides the shape. |
| RB-02 | high | ACCEPT | T3 Step 6 — the poll loop gained an INDEPENDENT deadline `setTimeout` that aborts the controller and shows the recovery actions whether or not a fetch ever settles, cleared on completion and unmount; T3 Step 4 adds R2 with a never-resolving fetch. |
| RB-03 | high | ACCEPT | T3 Step 6 — `send(text, locationId)` takes the location explicitly and `refreshPlan(turn)` passes the TURN's stored `locationId`, never the composer scope; the button works under `All locations`. T4 Step 6 adds R3 (plus a sibling `all`-scope case). |
| RB-04 | high | ACCEPT | T4 Step 4 — `VoiceStateDetail` renders all five fields by value, lists item by item, marks each item absent from the other side, and shows a cleared scalar as "Cleared"; T4 Step 1 adds R4 with equal-length arrays of different content. |
| RB-05 | medium | ACCEPT | T3 Step 6 — a `PendingSubmission` is retained until the POST resolves and re-POSTed verbatim by `retry`; only a new message allocates a key. T3 Step 4 adds R5; T7's flow asserts `countTurns === 1`. |
| RB-06 | medium | ACCEPT | T3 Step 6 — `TurnBody` switches exhaustively over `RenderedSegment` (with a `never` guard), renders a `status` segment's frozen value / period / `asOf`, the `scope_check` chooser, and each `proposal` card AT its referenced position, appending any unreferenced proposal after the segments. T3 Step 4 adds R6. |
| RB-07 | medium | ACCEPT | T2 Step 3 adds `listUnsupportedForTurns`; T2 Step 19 puts `unsupported` on `OwnerConversationTurn` and reads it in one batch; T3 Step 6 renders failure wording and requested-capability cards from the TRANSCRIPT, not from an in-flight poll. T3 Step 4 adds R7. |
| RB-08 | medium | ACCEPT | T3 Step 6 — the bare GET's conversation id is ADOPTED into state and the URL, an unfinished latest turn resumes polling, and "Start a new conversation" sets an explicit `fresh` flag that keeps the empty screen empty until the next send. T3 Step 4 adds R8. |
| RB-09 | medium | ACCEPT | T2 Step 19 — `OwnerConversationView.conversation` is nullable, a first-time owner with a valid `?locationId=` gets `{ conversation: null, turns: [], summary }`, and the summary builder is extracted so both paths share it; T2 Step 20 records that the route now answers 200. T2 Step 21 adds R9 against the live database. |
| RB-10 | medium | ACCEPT | T1 Step 14 — the proposal row is locked and its status read BEFORE an inactive location is refused, so a repeat Apply after archival returns the stored Receipt and a non-pending one answers `not_pending`; business-before-proposal ordering is unchanged wherever the business exists. T1 Step 12 re-primes the unit case; T1 Step 16 adds R10. |
| RB-11 | medium | ACCEPT | T3 Steps 10–11 use `/^Operator$/i` against the rendered LABEL; T2 Step 17's new `describe` gets its own `beforeEach` and uses the real `mockGetConversationForOwner`; T1 Step 12 and the decline suite match writes with `/^\s*UPDATE\s/m` instead of an `includes('UPDATE')` that also matches `FOR UPDATE`; T7 Step 2 calls `cleanupOperatorSeed` then `deleteOwnerUser`; T0 Step 6 now EXECUTES every scaffold file one at a time with its expected output written down. |
### Round 2 (Codex, verification) — REVISE → 7 accepted

Every finding is a defect the round-1 fixes introduced; each was verified against source by the root and accepted as written. No new test titles.

| Id | Severity | Disposition | Where it landed |
|---|---|---|---|
| RB2-01 | high | ACCEPT | T2 Step 19 — the CONSOLIDATED replacement of the `latest` block now issues `listUnsupportedForTurns` beside `listProposalsForTurns` and maps `unsupported: unsupportedByTurn.get(turn.id) ?? []` on every `OwnerConversationTurn`. The earlier instruction block described it; the block that actually replaces the code did not, and the client maps `turn.unsupported` unconditionally. |
| RB2-02 | medium | ACCEPT | T2 Step 17 — both `mockGetConversation` references are `mockGetConversationForOwner`, the name the file actually defines (`src/app/api/operator/__tests__/conversation-route.test.ts:4-7`). |
| RB2-03 | medium | ACCEPT | T2 Step 21 — the edit adds a `conversationOrThrow(view)` helper and routes the three unguarded `.id` reads (`src/lib/agents/operator/__tests__/reads.integration.test.ts:319`, `:325`, `:335`) through it, since RB-09 made `conversation` nullable and those reads no longer typecheck. |
| RB2-04 | medium | ACCEPT | T3 Step 6 — identity adoption and unfinished-turn discovery are now two independent conditions. A URL carrying `?conversationId=` without `turnId` resumes an `accepted`/`running` latest turn; previously only the bare GET could, so a reload after the turn id was cleared sat silent while the worker worked. |
| RB2-05 | medium | ACCEPT | T3 Step 4 — the start-over case drives the four-minute deadline and asserts the timeout notice BEFORE clicking the recovery button, which the screen only offers once there is something to recover from. |
| RB2-06 | medium | ACCEPT | T3 Step 4 — `useRouter` returns ONE hoisted object. A fresh object per render changed `writeUrl`'s `[router]` identity, tore down and re-ran every dependent effect, and turned a state-updating response into a read loop. |
| RB2-07 | low | ACCEPT | T4 Step 4 — `VoiceStateDetail` takes a `side`, and "Cleared" is reserved for the AFTER column of an actual removal; a null on the BEFORE side of a proposal that SETS a value reads "Not set", because nothing was cleared. |
### Round 3 — titles added

| Id | Title | Owned by |
|---|---|---|
| R11 | `a delayed conversation response never replaces a newly submitted turn` | T3, `OperatorClient.test.tsx` |

### Round 3 (Codex, verification, resumed) — REVISE → 1 accepted; loop closed at round 3, owner lock

| Id | Severity | Disposition | Where it landed |
|---|---|---|---|
| RB3-01 | medium | ACCEPT | T3 Step 6 — the unfinished-turn callback read `turnId` as captured by the render that ISSUED the conversation GET, so a turn submitted while that read was outstanding could be replaced by the older turn the stale response named: state and URL both moved to A, and B's polling was cancelled. Two halves, both applied. (1) `activeTurnIdRef` holds the CURRENT active turn and is what the callback reads; every writer of `turnId` updates it in the same breath. (2) `loadEpochRef` is bumped on every successful POST and on "Start a new conversation", the in-flight `conversationLoadRef` controller is aborted, and any conversation response whose captured epoch is older is discarded before it reaches `setView`. T3 Step 4 adds R11, which holds the GET open, lets the POST resolve first, then releases the stale answer and asserts the URL, the absence of any poll for the older turn, and that polling continues on the new one. |

**The review loop is closed at round 3 under the owner lock.** Round 1 returned 11 findings and round 2 returned 7 regressions of those fixes; round 3 returned this one. No further adversarial round is scheduled — remaining risk is carried into execution and the post-implementation red-team pass.

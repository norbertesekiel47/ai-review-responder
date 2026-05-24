# Edit Existing Replies — Zernio v1 Revival

**Date:** 2026-05-23
**Author:** Norbert (with Claude Code)
**Status:** Draft v1
**Supersedes nothing.** This is a *revival delta* on top of the original feature design.
**Behavior source of truth:** `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md`.
Where this doc and the original disagree on *behavior*, the original wins. This doc only
governs *how the parked feature lands on today's `main`*.
**Explicit exception — this revival doc supersedes the original on flag naming and layering**
(§4.4): the original's single `EDIT_EXISTING_REPLIES_ENABLED` no longer exists. `main` split it
into `EXTERNAL_REPLY_IMPORT_ENABLED` + `PAST_REPLIES_VIEW_ENABLED`, and this revival adds a third,
`EDIT_REPLIES_ENABLED`. Treat any `EDIT_EXISTING_REPLIES_ENABLED` reference in the original spec or
the parked tag as renamed per §4.4.
**Parked code reference:** git tag `wip/edit-existing-replies-zernio-v1` (immutable; never edited).
**Feature flag (new):** `EDIT_REPLIES_ENABLED`, default `false`.

---

## 1. Why now (context shift since the deferral)

The 2026-05-02 deferral (`docs/progresstracking.md:3604`) parked the full edit feature and
shipped a read-only "Past Replies" tab, on the bet that GBP API access (single-PUT reply
replacement) would arrive within ~12 months and make Zernio's DELETE-then-POST orphan-recovery
machinery vestigial.

Two things changed:

1. **GBP timeline blew up** — GBP access is now 12–18+ months out (or rejected). The "wait for
   GBP" bet no longer holds, so the Zernio recovery machinery is *not* throwaway; it will run in
   production for the foreseeable future and is worth maintaining.
2. **Edit-existing is the premium-tier headline unlock.** Premium needs a concrete capability to
   justify its price, independent of GBP.

Decision: revive the full Zernio v1 feature (edit / regenerate / republish + orphan recovery),
adapted onto current `main`.

## 2. Scope

**In scope**

- Full edit / regenerate / republish of already-`posted` replies via Zernio DELETE-then-POST,
  including the orphan-recovery state machine (`/retry`, `/restore-original`, orphan markers).
- Premium **C-2 tier split**: gap-period replies editable by all tiers; pre-subscription
  *historical* replies editable by premium only. (See original spec §4.1.)
- **Per-currently-selected-location.** The feature inherits the live page's `currentLocationId`
  model — no new multi-location UI.
- **Surface recoverable failed rows** (see §5) — required to make recovery reachable.

**Out of scope**

- Voice-learning bootstrap from imported replies (orthogonal; original spec §8 follow-up).
- Bulk "regenerate all" (original spec §2 non-goal).
- Any GBP API path.

## 3. Method: Hybrid revival

The parked tag is 3 weeks old, branched from a merge-base (`cfda7a5`, 2026-04-29) that predates
~60 commits on `main` — including the worker-layer reorganization, multi-location (migration 034),
account-scope owner-channel work, and security hardening. A clean cherry-pick of the whole delta
is unsafe (high conflict surface in the riskiest files). A full rebuild risks reintroducing the
hidden-draft bug class fixed across 6 review rounds. So:

### 3.1 Port from the tag (low-conflict leaf modules)

These are mostly *additive new files* and carry the embedded Round-2/3/4 fixes (drawer + regenerate
flow). Copy/cherry-pick onto the revival branch, then apply the §4 drift fixes:

- `src/lib/responses/edit-existing.ts` (`assertCanEditReply`, `validateOptimisticConcurrency`,
  structured error classes) + its tests.
- The 7 API routes under `src/app/api/dashboard/past-replies/` (`draft`, `draft/[responseId]`
  PATCH+DELETE, `draft-status`, `publish`, `[responseId]/retry`, `[responseId]/restore-original`)
  + route tests + the consolidated cross-origin test.
- `src/components/dashboard/EditReplyDrawer.tsx` (6-state machine) and the `PastReplyCard` recovery
  branch.
- **Zernio client (corrected path).** Reply methods now live in `src/lib/zernio/client/replies.ts`
  (`createReplyClient`), **not** `src/lib/zernio/client.ts`. Add `deleteReply` there alongside
  `postReply`. Plus: `'delete_reply'` in the `EndpointKind` union, the corresponding case in the
  transport mock (`src/lib/zernio/client/transport.ts`), and `ZernioReplyAlreadyDeletedError`
  (404-on-delete classification) in the error layer.

### 3.2 Rebuild against current structure (drifted integration seams)

The worker layer was reorganized; these do **not** apply cleanly and are re-implemented by hand,
using the tag as a reference implementation:

- **DELETE-before-POST branch — as a publisher module, not in the worker entry.**
  `worker/jobs/publisher/ResponsePublisherWorker.ts` (`handlePublishResponse`) is already a thin
  orchestrator that dispatches to `load-context`, `post-reply`, `review-lookup`, `no-connection`.
  The new edit-publish branch (Phase A pre-flight + Phase B locked tx — `reviews`+`responses FOR
  UPDATE` across Zernio DELETE+POST, per-CATCH commit semantics) lives in a **new sibling module**
  (e.g. `worker/jobs/publisher/edit-publish.ts`); the worker entry only decides which branch to
  dispatch: **(sibling `posted` exists OR `posting_error LIKE '%_after_delete_succeeded'`) →
  edit-publish, else today's `post-reply`**. The orphan-marker half of the predicate is essential —
  an orphan-retry row (DELETE succeeded, POST failed) has no `posted` sibling (it's `superseded`),
  so dispatching on sibling-`posted` alone would misroute it to plain `post-reply`.
- **Expose `posting_error` in `load-context.ts`.** The current
  `loadPublishResponseContext` SELECT returns `id, review_id, business_id, approved_text, status`
  but **omits `posting_error`** — orphan-marker detection (`%_after_delete_succeeded`) needs it.
  Add the column to the query and the `PublishResponseContext['response']` interface.
- **onFailed orphan conversion** — the tag put this in a standalone `worker/jobs/publisher-on-failed.ts`.
  On main it belongs in **`worker/jobs/publisher/failed-hook.ts`** (`handlePublisherFailed`), per the
  CLAUDE.md worker-layout invariant. Extend that hook; do not re-introduce the standalone file.
- **`process-review` stale-marking branch** — the unconditional stale-marking UPDATE at the top of
  the content-change block.
- **`verify409InTx`** — the tx-aware 409 verifier in `worker/jobs/publisher-error-handlers.ts`.

## 4. Drift fixes (the real revival work)

1. **Re-point the C-2 anchor from `businesses` to `accounts`.** Since migration 034, subscription
   tier and `subscription_activated_at` live on `accounts` (the billing parent), not `businesses`.
   - Fix `assertCanEditReply` to read tier + activation from the account.
   - Fix the **already-live read-only page** (`src/app/(authenticated)/dashboard/past-replies/page.tsx:45`),
     which currently reads `subscription_tier` / `subscription_activated_at` off `businesses` — a
     latent bug today (masked because the flag is off). Review rows stay scoped by
     `business_id = currentLocationId`; only the tier/activation anchor moves to the account.
2. **Scope every route to the *currently selected* location — not the primary one.**
   `requireRole()` / `getCurrentUser()` (`src/lib/db/auth.ts:7`) return `accountId` plus the
   account's **primary** location (`is_primary = TRUE`), which is **not** the location the owner is
   currently viewing. The parked routes scoped off the session's single business id; on multi-location
   accounts that would let an owner edit the *wrong* location (or behave account-wide). Each of the
   7 routes MUST resolve the **current** location the same way the live read-only page does —
   `requireOwnerAccess()` → `currentLocationId`, which reads the `rw_location_scope` cookie — and
   scope every review/response lookup by `business_id = currentLocationId`. The tier/historical
   anchor (item 1 above) reads from the **account**; review rows are scoped by the **current
   location**.
   Nothing is keyed off client-supplied IDs.
3. **Do not re-add already-landed pieces.** Migration **031** and the ingestion branches in
   `worker/jobs/zernio/zernio-ingest-shared.ts` are already on `main`. Verify they match the
   feature's needs; add nothing new there.
4. **Flag layering.** `main` already has `EXTERNAL_REPLY_IMPORT_ENABLED` (ingestion writes) and
   `PAST_REPLIES_VIEW_ENABLED` (read-only UI). Add **`EDIT_REPLIES_ENABLED`** gating the edit
   routes, the drawer's edit affordances, and the publisher DELETE+POST branch. Editing requires
   **both** `PAST_REPLIES_VIEW_ENABLED` and `EDIT_REPLIES_ENABLED`. Server-authoritative (no
   `NEXT_PUBLIC_*` companion); routes return `503 feature_disabled` when off.

## 5. In-scope addition beyond the parked read-only code

The read-only split dropped the failed-row plumbing. Because Zernio DELETE+POST can fail, the
`/retry` + `/restore-original` routes and the drawer's recovery state are **unreachable** without
surfacing failed rows. Shipping editing without this would leave owners stuck with no recovery path.
Therefore, in scope.

**Surface ALL owner-recoverable failures, not only the orphan case.** There are two distinct
recoverable shapes, and they differ in whether a live `posted` sibling still exists:

| Failure | `posting_error` prefix | Live `posted` sibling? | Recovery route |
|---|---|---|---|
| **Orphan** — DELETE ok, POST failed | `post_after_delete_failed_*` | **No** (Google slot empty) | `/restore-original` (or `/retry`) |
| **Delete-failed** — DELETE failed | `delete_failed_*` | **Yes** (original still on Google) | `/retry` |

Because a `delete_failed_*` failed row can **coexist with a live `posted` row for the same review**,
the page must **de-duplicate by review**: sidecar `failed_response_id` / `failed_posting_error` onto
the existing `posted` card via a LATERAL join (keyed on `review_id`), rather than rendering a second
card. Orphan rows (no `posted` sibling) render their own recovery card. Then:

- The `PastReplyCard` recovery-state branch consumes the sidecar fields.
- `failed_response_id` / `failed_posting_error` plumb through page → card → drawer.

No new migration — `failed` rows already exist in `responses`; this is read + UI plumbing only.

## 6. Safety invariants (preserved)

- **No auto-posting.** `/publish` requires explicit owner-session approval, logged in
  `approval_audit_log` (`auth_method='owner_session'`). No path from generation to Google posting
  without it.
- **Server-authoritative tier gate.** `assertCanEditReply` runs before any side effect on every
  mutating route; UI lock states are cosmetic.
- **Optimistic concurrency.** `{ hash, version }` snapshot captured at drawer-open, re-validated
  in-tx on `/draft`, PATCH, `/publish`.
- **DELETE-before-POST under lock.** `reviews`+`responses FOR UPDATE` held across the external
  Zernio I/O so `processReview` content-changes serialize against it.
- **Outbox atomicity.** Any transition into a `HANDLED_STATUSES` value inserts the `publish_response`
  outbox row in the same tx.

## 7. Testing

- Port the ~115 parked unit tests (helper, 7 routes, cross-origin, drawer, publisher-edit branch,
  verifier, onFailed conversion). Adapt for relocated files + account-scoping.
- **Tier-name coverage.** Tests MUST exercise the canonical tier names `basic`, `standard`,
  `premium`, `founders` (`src/lib/accounts/tier-config.ts`). Do **not** use the legacy `founding`
  string — the C-2 gate distinguishes premium vs non-premium, so include at least one non-premium
  case under `basic` *and* one under `founders` to prove the gate isn't accidentally tier-name-specific.
- **HARD GATE — publisher + recovery integration tests.** This is the only code that can orphan a
  real Google reply, so these are **required to merge** (not deferred): (1) DELETE-success +
  POST-failure leaves the documented orphan marker and `'failed'` state; (2) retry-exhaustion
  conversion via the `failed-hook.ts` path; (3) `/retry` recovery for both `delete_failed_*` and
  `post_after_delete_failed_*`; (4) `/restore-original` for the orphan case. These need
  `TEST_DATABASE_POOL_URL` (real Postgres for `FOR UPDATE` semantics) — if the harness is
  unavailable, the plan must stand up that fixture rather than skip the gate.
- E2E (Playwright browser flow) remains deferred — needs the browser harness; not a merge gate.

## 8. Rollout

- **Phase A** — revival branch merged to `main` with `EDIT_REPLIES_ENABLED=false`. All edit code
  inert; production behavior unchanged. Soak.
- **Phase B** — flip `EDIT_REPLIES_ENABLED=true` (Vercel + Railway). The ingestion +
  `PAST_REPLIES_VIEW_ENABLED` flags can be flipped independently first.
- No schema change required at any phase (031 already landed).

**Rollback after Phase B requires an ordered drain — not a single flag flip.** The publisher's
edit branch is selected by *DB state* (a sibling `posted` row + orphan markers), not only by the
flag. If `EDIT_REPLIES_ENABLED` is turned off while edit-publish outboxes or
`%_after_delete_succeeded` orphan markers are in flight, the worker could fall back to fresh-publish
(POST-only) semantics on a row that needs DELETE-first or recovery — re-orphaning or double-posting.
Rollback order:

1. **Disable the UI flag first** (`EDIT_REPLIES_ENABLED=false` on Vercel) so no *new* edit publishes
   are enqueued.
2. **Let in-flight edit-publish outboxes drain** (watch `job_outbox` for `publish_response` rows
   tied to edit drafts; wait for completion/terminal).
3. **Verify no recoverable state remains** — no `responses` rows with `posting_error LIKE
   'delete_failed_%'` or `LIKE 'post_after_delete_failed_%'`, and no orphan markers.
4. **Only then disable the worker branch** (Railway flag).

This ordered drain belongs in the runbook (`docs/runbooks/zernio-launch-runbook.md` §10).

## 9. Open follow-ups (tracked, not in this effort)

- Voice-learning bootstrap from imported replies (original spec §8).
- Migrate `postReply` to the documented `/v1/inbox/...` path for consistency with `deleteReply`
  (original spec §4.2 note).

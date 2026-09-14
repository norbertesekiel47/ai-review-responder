## `src/lib/`

### `agents/operator/`

**Owner Operator** — the turn pipeline behind `OWNER_OPERATOR_ENABLED` (Run A),
plus Apply and Decline (Run B), and the policy proposal, consequence and
Apply extensions under development in Run C.
The sibling `agents/` rows (`run-spine.ts`, `read.ts`) stay on
[lib-platform.md](lib-platform.md); this folder sits here because both default
pages are at the 3,000-word cap. Glossary: `docs/context/owner-operator.md`;
spec of record: `docs/roadmap/2026-09-11-owner-operator/README.md`.

| File | What it does |
|------|--------------|
| `consequence.ts` | Pure `simulateRule`: excludes imported reviews, uses the shared star threshold and platform-cap resolver, counts eligibility and hold reasons per location/UTC day, and returns the scope's daily histogram and busiest-day count. Review timestamps and UTC day keys are supplied by server reads; no database or model call occurs here. |
| `policy-state.ts` | One-statement policy snapshot: full effective dials, opaque row tokens, active locations and a 30-day review cohort with confirmed ingestion origins. Maps that fixed cohort through `simulateRule`, preserving location overrides. The retained-veto read counts approved auto-policy drafts against their latest immutable approval grant, locking only audit rows; Apply supplies the account lock. |
| `schema.ts` | Strict model-output contract with seven operation-specific proposal inputs and no model fields for counts, approval, confirmation or receipts. Owns turn/proposal/failure vocabularies, full voice and policy state, frozen policy consequences and readiness reasons, and the discriminated voice/policy Receipt schemas. `parseReceipt` preserves legacy voice receipts and returns `null` for an un-applied row; state parsers narrow already-parsed objects, keeping server metadata outside the writable dials. |
| `catalog.ts` | Operation registry: three reads, four voice proposables, three policy proposables and one capability capture. Proposables remain contract version 1. Voice operations supply only their changed writer fields; policy operations supply full-state previews, shared-writer patches, exposure classification, confirmation phrases and descriptions of created overrides. Model-visible operations carry input shapes and expansion-readiness reasons. |
| `operation-inputs.ts` | Strict input schemas shared by the catalog and model-output validator, keeping operation shapes consistent without a catalog/schema import cycle. Policy value domains are checked against the shared settings writer. |
| `render.ts` | The **Pasted-review scrub**, the semantic validator (invented counts and completion claims over `text` AND `question`, dangling refs, scope rules — returning the proposals it parsed), `materializeReply` (the write-path transform: `status_ref` → a frozen value, `proposal_ref` → a stored id, scrub notice prepended), and the deterministic read-path renderer. |
| `context.ts` | `buildSnapshot`, plus the reusable `readPosted7d` and `RECENT_COMPLETED_DAYS`. The one star-band query (pending_approval, held drafts and soft-deleted reviews excluded, grouped by location and star). The `Snapshot` type has no field that could hold review text, response text, a reviewer name — or `sampleResponses`. |
| `prompt.ts` | `OWNER_OPERATOR_SYSTEM_PROMPT`, its version and SHA-256 hash (recorded on every `api_costs` row), and the untrusted-data envelope builder. |
| `model-call.ts` | One cost-guarded `owner_operator` call with at most one validation retry. Every attempt is billed and audited — including the invalid one. Transient and budget errors propagate; only the `api_costs` write is best-effort. |
| `turns.ts` | Turn WRITES: creation, claim/predecessor protocol and fenced terminal transitions. Claim release binds the current token to the exact outbox attempt; healthy predecessor waits refresh liveness atomically, transient releases do not, and failed outboxes reconcile on yield. Poller exhaustion locks the stored tenant/turn identity without blocking completion: accepted or expired claims fail atomically, live/contended claims keep a recoverable outbox. Owner reads live in `reads.ts`. |
| `reads.ts` | The account-scoped owner READS: `getTurnForOwner` (the polled turn) and `getConversationForOwner` (the transcript, bounded to the 50 most recent turns, plus the live summary panel — `null` when there is no turn to scope it to, never a zeroed one). Proposals come from one batched `listProposalsForTurns`, never a query per turn. **Run B added `?locationId=` and `connectionStatus`**: the caller-supplied location scopes the summary ONLY when the conversation has no turns yet (the latest-turn scoping still wins whenever a turn exists), and an owner with no conversation at all receives the empty view with a scoped summary rather than a 404 — an id that is not an active member of the account scopes nothing and the summary stays `null`. |
| `proposals.ts` | **Proposal** and **Requested capability** construction and persistence, account-scoped reads, row locks, and idempotent actor-recording Decline. Policy preparation freezes full before/after consequences, row tokens and expansion-readiness reasons; the owner view derives confirmation from stored dials. Supersession matches operation and nullable scope across earlier turns. Apply invalidation follows the changed token domain: voice siblings on one location, policy siblings on one location, or all account policy siblings after an account-default write. |
| `authorize.ts` | Worker step 3: re-resolves actor, subscription posture and location from the database before any snapshot is built. |
| `flags.ts` | `ownerOperatorEnabled()` — the single reader of `OWNER_OPERATOR_ENABLED` (the **Operator flag**). Server-only; no `NEXT_PUBLIC_*` companion (invariant #13). |
| `apply.ts` | Apply dispatches from the stored token domain after checking the contract. Voice locks the business before the proposal; policy locks the account before the proposal. Both revalidate the actor and compare current/prepared/expected tokens before a shared-writer mutation and atomic Receipt. Policy expansions require readiness and an exact stored-state phrase before mapping to the settings writer's `standard` confirmation; mismatch leaves the proposal pending. Policy receipts include actual dials, consequences over one pre-write cohort and the immutable-grant veto count. Repeated Apply returns the stored Receipt; thrown post-write failures roll back the transaction. |
| `version-token.ts` | Strict voice and policy version tokens, their JSONB parser and structural equality. Policy tokens distinguish absent rows and include the account default in every location token. Timestamps remain opaque text to preserve PostgreSQL microseconds. |

### `responses/` (continued)

The rest of the folder is inventoried on
[lib-reviews-responses.md](lib-reviews-responses.md); this one row lives here
because that page is at the cap.

| File | What it does |
|------|--------------|
| `voice-settings.ts` | The single transactional writer for a location's voice fields, shared by the settings route and the Owner Operator. Takes the `businesses` row lock FIRST and account-scoped, so ownership and write cannot be separated; `highlight_facts` joined the column map in Run A. `sampleResponses` stops here — it has no field in the **Context snapshot**. |

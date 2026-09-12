## `src/lib/`

### `agents/operator/`

**Owner Operator Run A** — the turn pipeline behind `OWNER_OPERATOR_ENABLED`.
The sibling `agents/` rows (`run-spine.ts`, `read.ts`) stay on
[lib-platform.md](lib-platform.md); this folder sits here because both default
pages are at the 3,000-word cap. Glossary: `docs/context/owner-operator.md`;
spec of record: `docs/roadmap/2026-09-11-owner-operator/README.md`.

| File | What it does |
|------|--------------|
| `schema.ts` | The model-output zod contract (`.strict()` throughout, which is what makes "no field for counts, approval, confirmation or receipts" mechanical), the turn/proposal/failure-reason vocabularies, and the ONLY PgBouncer JSONB parse sites for the four migration-120 tables (`parseJsonbObject` / `parseReplySegments` — allowlisted in lab-notes/postgres.md). |
| `catalog.ts` | The v1 operation registry. Four kinds separated by TypeScript type so a write cannot be registered as immediately executable. Run A registers three reads, four voice proposables and one capture; the auto-approval operations and the Apply/Decline commands are absent, not stubbed. Every proposable is `contract_version: 1`. |
| `render.ts` | The **Pasted-review scrub**, the semantic validator (invented counts and completion claims over `text` AND `question`, dangling refs, scope rules — returning the proposals it parsed), `materializeReply` (the write-path transform: `status_ref` → a frozen value, `proposal_ref` → a stored id, scrub notice prepended), and the deterministic read-path renderer. |
| `context.ts` | `buildSnapshot`, plus the reusable `readPosted7d` and `RECENT_COMPLETED_DAYS`. The one star-band query (pending_approval, held drafts and soft-deleted reviews excluded, grouped by location and star). The `Snapshot` type has no field that could hold review text, response text, a reviewer name — or `sampleResponses`. |
| `prompt.ts` | `OWNER_OPERATOR_SYSTEM_PROMPT`, its version and SHA-256 hash (recorded on every `api_costs` row), and the untrusted-data envelope builder. |
| `model-call.ts` | One cost-guarded `owner_operator` call with at most one validation retry. Every attempt is billed and audited — including the invalid one. Transient and budget errors propagate; only the `api_costs` write is best-effort. |
| `turns.ts` | Turn WRITES: `createTurn`'s single transaction, the **Turn claim** / release / predecessor protocol, the two **Fenced completion** terminal transitions and the two unfenced ones. The owner reads live in `reads.ts`. |
| `reads.ts` | The account-scoped owner READS: `getTurnForOwner` (the polled turn) and `getConversationForOwner` (the transcript, bounded to the 50 most recent turns, plus the live summary panel — `null` when there is no turn to scope it to, never a zeroed one). Proposals come from one batched `listProposalsForTurns`, never a query per turn. |
| `proposals.ts` | **Proposal** and **Requested capability** construction (`buildProposalRows`, consuming the validator's parsed output) and persistence, plus the supersession that uses `IS NOT DISTINCT FROM` so an account-default proposal's predecessor is not silently left pending, and `turn_id <>` so one turn's two same-scope proposals do not supersede each other. |
| `authorize.ts` | Worker step 3: re-resolves actor, subscription posture and location from the database before any snapshot is built. |
| `flags.ts` | `ownerOperatorEnabled()` — the single reader of `OWNER_OPERATOR_ENABLED` (the **Operator flag**). Server-only; no `NEXT_PUBLIC_*` companion (invariant #13). |

### `responses/` (continued)

The rest of the folder is inventoried on
[lib-reviews-responses.md](lib-reviews-responses.md); this one row lives here
because that page is at the cap.

| File | What it does |
|------|--------------|
| `voice-settings.ts` | The single transactional writer for a location's voice fields, shared by the settings route and the Owner Operator. Takes the `businesses` row lock FIRST and account-scoped, so ownership and write cannot be separated; `highlight_facts` joined the column map in Run A. `sampleResponses` stops here — it has no field in the **Context snapshot**. |

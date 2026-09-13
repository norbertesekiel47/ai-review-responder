# Owner Operator v1 Run B — browser evidence (T7)

Every screenshot below was taken by a real browser against the real screen, the
real routes and a real database. **The evidence is the screenshot PLUS the
row**: each entry names the SQL that establishes what was stored at the moment
the picture was taken, and the value that SQL returned. A green picture over a
row that never committed is the failure this file exists to rule out.

## How these were produced

`e2e/operator.spec.ts` captures seven of them as part of a passing run; the
other eleven come from a scratchpad capture script (not committed — `e2e/` and
`scripts/` additions are outside T7's edit surface) that drives the same screen
through the same helpers, one throwaway owner per state so no transcript
contains another state's rows.

**The environment is a fully LOCAL Supabase stack**, not the staging-backed auth
harness the runbook describes, and that is a finding rather than a convenience:

- `src/proxy.ts` `readSelf()` resolves the owner's `role`/`account_id` through
  **supabase-js / PostgREST**, and `/api/auth/callback` resolves the role the
  same way (`src/lib/shared/auth-flow.ts:55-66`). Both therefore read the
  Postgres that belongs to the Supabase **Auth** project.
- The harness's **base tier** (staging Auth + the local docker test DB) puts the
  `users` row in a different database from the one those two reads see. The
  callback logs `PGRST116` and every `/dashboard/*` request bounces to
  `/login?from=…`. Confirmed by direct probe before anything else was tried.
- The **deep tier** fixes that by pointing `TEST_DATABASE_POOL_URL` at the
  staging Postgres — i.e. by seeding and deleting rows in a **shared** database.
  That was not done.
- So: `supabase start` in a scratch directory, its Postgres provisioned to
  migrations head with `scripts/test-db-setup.sh`, and Auth + PostgREST +
  Postgres all pointing at that one local database. Nothing shared was written.

Runtime configuration for the captures: `OWNER_OPERATOR_ENABLED=true`
(`false` for the last row), `ADMIN_APP_URL` a dummy, `MULTI_LOCATION_ENABLED=true`,
`DATABASE_POOL_URL = TEST_DATABASE_POOL_URL`. No provider key and no Railway
worker: the worker's half of a turn is stood in for through the production
builders (`readVoiceConfig` → `buildProposalRows` → `insertProposals`), which is
why the stored preview carries the real shape rather than a hand-typed fixture.

## The set

| File | Width | State shown | Stored row behind it |
|---|---|---|---|
| `empty-screen-1440.png` | 1440 | Empty screen, the three starter actions, summary panel | `SELECT COUNT(*) FROM agent_turns WHERE account_id = $1` → **0** before the send (the same helper asserts **1** immediately after it, in the spec) |
| `empty-screen-390.png` | 390 | Same, narrow | `SELECT COUNT(*) FROM agent_conversations WHERE account_id = $1` → **0**; `agent_turns` → **0** |
| `preparing-1440.png` | 1440 | "Preparing your plan" — the turn is accepted and no worker exists | `SELECT status, reply, completed_at FROM agent_turns WHERE account_id = $1` → **status `accepted`, `reply` NULL, `completed_at` NULL**, one row |
| `preparing-390.png` | 390 | Same, narrow | same row, same read |
| `proposal-card-1440.png` | 1440 | The reply with a Proposal card — exact before/after of all five voice fields (`professional and friendly` → `warm and brief`) | `SELECT status, before, after FROM agent_proposals WHERE id = $1` → **`pending`**; the card's values are rendered from `before`/`after` as stored by `buildProposalRows` |
| `proposal-card-390.png` | 390 | Same, narrow | same row |
| `receipt-1440.png` | 1440 | The Receipt after Apply, with the record half (change, location, applied at/by, the verbatim instruction, the turn reference) | `SELECT status, failure_reason, receipt, decided_by_user_id FROM agent_proposals WHERE id = $1` → **`applied`, reason NULL, `receipt` NOT NULL, decider = the owner's user id**; `SELECT tone FROM businesses WHERE id = $1` → **`warm and brief`**; `agent_turns` count still **1** |
| `receipt-390.png` | 390 | Same, narrow | same four assertions |
| `stale-card-1440.png` | 1440 | The stale card after a concurrent settings write, with **Refresh plan** | `SELECT status, failure_reason, receipt FROM agent_proposals WHERE id = $1` → **`stale`, `version_mismatch`, `receipt` NULL**; `SELECT tone FROM businesses WHERE id = $1` → **`formal and precise`** (the concurrent write stands; nothing was applied) |
| `stale-card-390.png` | 390 | Same, narrow | same three assertions |
| `rejected-contract-changed-1440.png` | 1440 | A rejected Apply — "RepWorth changed since this plan was prepared" + Refresh plan | `UPDATE agent_proposals SET contract_version = 2 WHERE id = $1` first, then `SELECT status, failure_reason FROM agent_proposals WHERE id = $1` → **`rejected`, `contract_changed`** |
| `rejected-contract-changed-390.png` | 390 | Same, narrow | same row |
| `failed-turn-1440.png` | 1440 | A failed turn in `predecessor_stalled` wording, with the **Start a new conversation** recovery action | `UPDATE agent_turns SET status='failed', failure_reason='predecessor_stalled' …`, then `SELECT status, failure_reason FROM agent_turns WHERE id = $1` → **`failed`, `predecessor_stalled`** |
| `failed-turn-390.png` | 390 | Same, narrow | same row |
| `all-locations-chooser-1440.png` | 1440 | The All-locations chooser: composer blocked, "Choose a location", the panel's one-location hint | Scope is a **cookie**, not a row (`rw_location_scope=all`); `SELECT COUNT(*) FROM agent_turns WHERE account_id = $1` → **0** — the chooser blocks the send, so nothing is stored |
| `all-locations-chooser-390.png` | 390 | Same, narrow | same read |
| `not-available-1440.png` | 1440 | `OWNER_OPERATOR_ENABLED=false` → the page's `notFound()`, and the Operator nav entry is gone | No row: the flag is read server-side (`ownerOperatorEnabled()`) before anything is queried. `SELECT COUNT(*) FROM agent_turns WHERE account_id = $1` → **0** |
| `not-available-390.png` | 390 | Same, narrow | same |

## Reading notes

- The dev-mode Next.js indicator (the small badge bottom-left) is present in
  some frames; these are `pnpm dev` captures, not production builds.
- The account in every frame is a throwaway harness owner ("E2E Harness Owner",
  a synthetic `E2E Auth Biz …` location). No real owner, review text, email or
  token appears in any frame.
- Timestamps and ids differ between frames because each state used its own
  freshly seeded owner.

## Not captured

Nothing from the required set is missing. Two adjacent states were deliberately
left out because T7 does not call for them: the in-screen "not available"
notice that appears when the flag is flipped *during* an open session (distinct
from the not-found page above), and the **Requested capability** card, which
belongs to the capture operation rather than to this run's Apply path.

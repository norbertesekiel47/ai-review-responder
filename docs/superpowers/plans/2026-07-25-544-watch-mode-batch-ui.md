# Watch-mode batch UI (Requests) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3** — two adversarial review rounds, both returning `VERDICT: REVISE`, plus one bug self-caught between rounds. See the two "Revision log" sections at the bottom; all fixes are inlined below.

**Goal:** Ship the owner-facing **Requests** screen — the latest **Solicitation batch** as a funnel hero above its **spoilage report** of withheld **Asks** grouped by **withhold reason** — behind server-authoritative `SOLICITATION_WATCH_ENABLED`, and flip that flag on in staging.

**Architecture:** One deep read module (`src/lib/solicitation/batch-view.ts`) hides latest-batch selection, snapshot-consistent aggregation, bounded evidence sampling, six-reason zero-fill and the built/building/absent state discrimination behind one function. One thin composition-root route calls it. The screen is a server page (flag gate only) plus one client island that renders by discriminated `state`, following `/dashboard/requests/contacts` — its sibling one route away — for every access, scoping, polling and cancellation idiom.

**Tech Stack:** Next.js 16 App Router (server components + client islands), Postgres.js (`Sql` passed explicitly, invariant #15), Vitest + Testing Library, `@/lib/shared/logger`.

**Ticket:** #544 · **Map:** #528 · **Intake contract:** `.feature/intake.json`

**Glossary terms used verbatim** (`CONTEXT.md`): Solicitation batch · Ask · Withhold reason · Evidence snapshot · Spoilage report · Velocity banking · Batch candidate window · Restraint policy. Owner-facing label for the surface is **Requests** (coined by this ticket).

---

## Design: modules and seams

| Module | Seam | Interface | Depth verdict |
|---|---|---|---|
| `src/lib/solicitation/batch-view.ts` **(new)** | domain read/write for the Requests screen | `readLatestBatch(sql, accountId, businessId)` + `markBatchReviewed(sql, accountId, businessId, batchId)` | **Deep.** Behind two calls: latest-batch selection, snapshot-consistent aggregation, six-reason zero-fill, PgBouncer JSONB guard, state discrimination, and the `reviewed_at` lifecycle transition. Deletion test: all of it reappears in the route handler. |
| `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` | UI state machine | one island fetching the batch | Renders by `state` discriminant — no branching around impossible combinations. |

**No new seam is introduced.** `batch-view.ts` is one adapter over Postgres; there is no second adapter, so no interface abstraction is extracted (rule: one adapter means a hypothetical seam).

### The read model

```ts
// src/lib/solicitation/batch-view.ts
import { WITHHOLD_REASONS, type WithholdReason, type AskDecision }
  from '@/lib/solicitation/restraint-policy';
// NOTE: BATCH_CAP is deliberately NOT imported — the queued panel was dropped,
// so nothing here needs it, and an unused import fails the lint gate.

/** At most this many evidence rows per withhold reason. */
export const EVIDENCE_ROWS_PER_REASON = 10;
/** Server-side cap on a rendered contact name — the column is unbounded TEXT. */
export const CONTACT_NAME_MAX = 80;

export interface AskRow {
  askId: string;
  contactId: string;
  /** Truncated to CONTACT_NAME_MAX server-side. */
  contactName: string;
  decidedAt: string;
  /** The stored evidence snapshot. NOT NULL in the schema — the builder writes
   *  a full decision envelope for sends too, so this is AskDecision, never
   *  `WithholdEvidence | null`. */
  evidence: AskDecision;
}

export interface WithholdGroup {
  /** Verbatim code from the closed enum — never renamed or collapsed. */
  reason: WithholdReason;
  /** Exact total, from the same statement that produced `sample`. */
  total: number;
  /** At most EVIDENCE_ROWS_PER_REASON rows; empty when total is 0. */
  sample: AskRow[];
}

export type BatchView =
  | { state: 'no_batch'; contactsOnFile: number }
  | { state: 'building'; batchId: string; createdAt: string; contactsOnFile: number }
  | {
      state: 'built';
      batchId: string;
      builtAt: string;
      contactsOnFile: number;
      evaluated: number;
      queued: number;
      held: number;
      /** ALWAYS all six reasons in precedence order, zero-total groups included. */
      groups: WithholdGroup[];
    };
```

**No `queuedSample`.** The funnel reports the queued *count*; there is no per-person "would have sent" list. That keeps the payload at the intake's locked 6 × 10 shape and keeps 25 PII-bearing rows off the wire. The owner can see the people themselves at `/dashboard/requests/contacts`.

**Why `groups` is always length 6:** `suppressed` has no v-watch source and can never fire, yet #537 locked it as an explicit zero-count group ("Nobody this batch") so the enum stays visible. Zero-filling in the module means the UI never branches on a missing group — the impossible state cannot be constructed.

**Precedence order** is `WITHHOLD_REASONS` from `restraint-policy.ts:26` — import it, never re-declare the order. Likewise `BATCH_CAP` (`restraint-policy.ts:68`) — never write the literal `25`.

### Snapshot consistency (this is a correctness requirement, not an optimisation)

The intake locks the invariant *"every funnel number derives from `solicitation_asks`, so the hero and the ledger cannot disagree."* Three facts make that hold:

1. **Every ask-derived number comes from ONE statement** — funnel totals (`queued`/`held`/`evaluated`), per-reason totals, and the bounded sample. Any split tears: the owner DELETE at `contacts-repo.ts:96` cascades to asks via `solicitation_asks_contact_business_fk`, so a deletion landing between statements yields a `held` that disagrees with the sum of its own reason groups. **Splitting Q3 for readability is a correctness regression, not a refactor** — revision 2 made exactly that mistake and it was caught in self-review.

1b. **All three reads run in ONE read-only `REPEATABLE READ` transaction.** One statement is not sufficient once the reads are plural: account-offboarding purge (`worker/jobs/account-offboarding/purge-stages.ts:243`) can delete the batch or its asks between Q1 and Q3, which would render a "built" batch with zero asks — a legitimate-looking screen describing a batch that no longer exists. Revision 2 rejected this on the grounds that the single-statement rewrite made it unnecessary; that reasoning covered Q3's internal consistency but not Q1-versus-Q3, and it was wrong.
2. **`built` implies all asks are present.** The builder inserts asks and sets `built_at` in the *same* transaction with `built_at` written last (`batch-builder.ts:511,599`), so a batch that reads as built can never be missing asks.
3. **`contactsOnFile` is deliberately outside that snapshot.** It is labelled present-tense ("contacts on file") and is not a funnel rung, so it is allowed to move independently.

---

## File structure

**Create:**
- `src/lib/solicitation/batch-view.ts`
- `src/lib/solicitation/__tests__/batch-view.test.ts`
- `src/lib/solicitation/__tests__/batch-view.integration.test.ts`
- `src/app/api/dashboard/solicitation/batch/route.ts` (`GET`, pure read)
- `src/app/api/dashboard/solicitation/batch/reviewed/route.ts` (`POST`)
- `src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts`
- `src/app/(authenticated)/dashboard/requests/{page.tsx,RequestsClient.tsx,BatchReport.tsx,GhostPipeline.tsx,requests.css}`
- `src/app/(authenticated)/dashboard/requests/__tests__/requests-ui.test.tsx`

**Move (`git mv`, no shim — pre-launch, no external consumers):**
- `src/app/(authenticated)/dashboard/contacts/**` → `src/app/(authenticated)/dashboard/requests/contacts/**`
- *(T6 only)* `src/app/api/dashboard/contacts/location-scope.ts` → `src/app/api/dashboard/solicitation/scope.ts`

**Modify:** `src/components/dashboard/shell/Sidebar.tsx`, `src/components/dashboard/shell/MobileTabBar.tsx`, their tests, `src/app/(authenticated)/layout.tsx`, `.claude/reference/env-vars.md`, `.claude/CLAUDE.md`, `CONTEXT.md`, `docs/directory.md`.

## Task graph

```
T1 (read model + GET) ─┬─► T2 (built screen) ─┬─► T3 (all other states)
                       │                      └─► T4 (nav + route move) ─► T5 (docs)
                       └──────────────────────────────────────────────────► T6 (rename, droppable)
```

---

### Task 1: Batch read model + GET route (including the `reviewed_at` write)

**Blocking edges:** none. **Covers intake tests:** 1–7.

**Files:** create `src/lib/solicitation/batch-view.ts`, `src/lib/solicitation/__tests__/batch-view.test.ts`, `src/lib/solicitation/__tests__/batch-view.integration.test.ts`, `src/app/api/dashboard/solicitation/batch/route.ts`, `src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts`.

- [ ] **Step 1: Write the failing unit tests**

Titles **verbatim** (contract items in `.feature/intake.json` — the gate greps for them):

```ts
it('returns the most recent batch when a location has several', async () => { /* … */ });
it('returns exact withheld counts per reason and at most 10 evidence rows per group', async () => { /* … */ });
it('returns hasBatch false when the location\'s uploads completed before watch-mode was enabled', async () => { /* … */ });
it('renders suppressed as an explicit zero-count group', async () => { /* … */ });
it('records reviewed_at once and does not overwrite it on a second view', async () => { /* … */ });
```

Mock the `Sql` tagged template in the style of `src/lib/solicitation/__tests__/uploads.test.ts`. The third test seeds contacts + a completed upload and **no** `solicitation_batches` row — the exact post-flip state — asserting `state === 'no_batch'` with non-zero `contactsOnFile`.

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-544-watch-mode-batch-ui
pnpm vitest run src/lib/solicitation/__tests__/batch-view.test.ts
```
Expected: FAIL — `Cannot find module '../batch-view'`.

- [ ] **Step 3: Implement `readLatestBatch`**

Takes `sql: Sql` explicitly (invariant #15) — never imports `@/lib/db/server`.

**All three queries run inside one read-only snapshot** (see "Snapshot consistency" 1b):

```ts
return sql.begin(async (tx) => {
  await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
  // Q1, then Q2, then Q3 — all against tx, never the pool.
});
```

Inside the transaction use `tx`, and note `tx.json(x)` rather than `jsonb(x)` (composition-root-only, per invariant #15).

```sql
-- Q1 latest batch. created_at is NOT unique (migration 088:118), so the
-- UUIDv7 id is the tie-break; without it "most recent" is nondeterministic.
-- Timestamps as ::text — postgres.js decodes timestamptz to a JS Date and
-- silently truncates microseconds (CLAUDE.md gotcha).
SELECT id, built_at::text AS built_at, created_at::text AS created_at
  FROM solicitation_batches
 WHERE account_id = $1 AND business_id = $2
 ORDER BY created_at DESC, id DESC
 LIMIT 1
```

```sql
-- Q2 contacts on file. solicitation_contacts has NO account_id column
-- (migration 086), so account scope comes from the businesses join — this is
-- what contacts-repo.ts:66-68 actually does. Invariant #8 requires both keys;
-- filtering on business_id alone would violate it.
SELECT COUNT(*)::int AS n
  FROM solicitation_contacts c
  JOIN businesses b ON b.id = c.business_id
 WHERE c.business_id = $1 AND b.account_id = $2
```

```sql
-- Q3 EVERY ask-derived number in ONE statement — funnel totals, per-reason
-- totals and the bounded evidence sample all from a single snapshot.
--
-- This MUST stay one statement. Splitting the funnel's queued/held counts
-- from the ledger's per-reason totals reintroduces the tear: the owner DELETE
-- at contacts-repo.ts:96 cascades to asks via solicitation_asks_contact_
-- business_fk, so a deletion landing between two statements yields a `held`
-- that disagrees with the sum of the reason groups — violating the intake's
-- "hero and ledger cannot disagree" invariant.
--
-- The LEFT JOIN is load-bearing: `totals` always yields exactly one row, so a
-- batch with zero asks (or zero withholds) still returns its counts instead of
-- an empty result the caller would have to special-case.
--
-- Bounded by construction: at most 6 x 10 rows for any batch of any size.
WITH scoped AS (
  SELECT a.id, a.contact_id, a.status, a.withheld_reason, a.evidence,
         a.decided_at, c.name
    FROM solicitation_asks a
    JOIN solicitation_contacts c
      ON c.id = a.contact_id AND c.business_id = a.business_id
   WHERE a.account_id = $1 AND a.business_id = $2 AND a.batch_id = $3
),
totals AS (
  SELECT COUNT(*) FILTER (WHERE status = 'send')::int     AS queued,
         COUNT(*) FILTER (WHERE status = 'withhold')::int AS held,
         COUNT(*)::int                                    AS evaluated
    FROM scoped
),
ranked AS (
  SELECT s.id, s.contact_id, s.name, s.decided_at, s.evidence, s.withheld_reason,
         -- ::int is load-bearing: COUNT(*) OVER returns bigint, which
         -- postgres.js surfaces as a string and would break `total: number`.
         -- contacts-repo.ts:63 casts for exactly this reason.
         (COUNT(*) OVER (PARTITION BY s.withheld_reason))::int AS group_total,
         ROW_NUMBER() OVER (PARTITION BY s.withheld_reason
                            ORDER BY s.decided_at DESC, s.id DESC) AS rn
    FROM scoped s
   WHERE s.status = 'withhold'
)
SELECT t.queued, t.held, t.evaluated,
       r.id              AS "askId",
       r.contact_id      AS "contactId",
       LEFT(r.name, $5)  AS "contactName",   -- $5 = CONTACT_NAME_MAX; name is unbounded TEXT
       r.decided_at::text AS "decidedAt",
       r.evidence,
       r.withheld_reason AS reason,
       r.group_total     AS "groupTotal"
  FROM totals t
  LEFT JOIN ranked r ON r.rn <= $4   -- $4 = EVIDENCE_ROWS_PER_REASON
 ORDER BY r.withheld_reason, r.rn    -- deterministic row order; without it the
                                     -- sample's display order is arbitrary
```

The caller reads `queued`/`held`/`evaluated` from the first row (identical on every row) and builds groups from the non-null `r.*` columns.

State discrimination, in order — **short-circuit before Q3**:
1. No Q1 row → `{ state: 'no_batch', contactsOnFile }`.
2. Q1 row with `built_at === null` → `{ state: 'building', … }`.
3. Otherwise `state: 'built'`, `evaluated = queued + held`.

Zero-fill by mapping over `WITHHOLD_REASONS`; emit a group for **every** reason with `total: 0, sample: []` when absent.

**JSONB guard (mandatory).** `solicitation_asks.evidence` is `JSONB NOT NULL`:

```ts
const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
```
Narrow to `AskDecision` — **never** `: any`. Production JSONB parser site #17; T5 registers it.

- [ ] **Step 4: Implement `markBatchReviewed` in the same module**

Called **only** by the dedicated POST route (step 7b) — never by `readLatestBatch`.

> **Why not folded into the GET** (revision 2 tried this and it was wrong): the client polls every 2s while `state === 'building'`, so the poll that first sees `built` would perform the write in a tab the owner may have abandoned; and an aborted location-switch fetch still reaches the server, marking a batch reviewed that the owner clicked straight past. `reviewed_at` would then mean "a fetch happened", not "the owner opened the spoilage report" — inflating, with our own polling, the exact engagement number this column exists to answer. A GET firing once per HTTP request is not the same as firing once per human.

```sql
UPDATE solicitation_batches
   SET reviewed_at = GREATEST(NOW(), built_at)
 WHERE id = $1 AND account_id = $2 AND business_id = $3
   AND built_at IS NOT NULL
   AND reviewed_at IS NULL
```

Two guards, both load-bearing:
- `built_at IS NOT NULL` — migration 088's `solicitation_batches_reviewed_after_built` CHECK rejects a `reviewed_at` on an unbuilt batch.
- `GREATEST(NOW(), built_at)` — that same CHECK also requires `reviewed_at >= built_at`. `built_at` comes from the **worker host clock** (`batch-builder.ts:487,599`) while `NOW()` is the **database clock**; a worker running ahead would otherwise raise a constraint violation on a perfectly normal page view.

`reviewed_at` is deliberately **not** returned in `BatchView` — nothing in the UI depends on it. `markBatchReviewed` returns the updated row count so the route can distinguish "already reviewed" (0) from "recorded" (1); the client ignores both, but a silent 0 must not be indistinguishable from a failure server-side.

- [ ] **Step 4b: Implement the POST route**

`src/app/api/dashboard/solicitation/batch/reviewed/route.ts`. Preamble in this exact order — flag gate (404 before auth), `requireWritableOwner`, `withSameOrigin()`, **then** `requireContactsLocationScope`. The location resolution is not optional: the body carries only `batchId`, and without it the three-key UPDATE has no proven `business_id`. Reject a non-UUID `batchId` with the uniform 404, matching `resolveContactsScopedId`'s exposure. Respond `204`.

- [ ] **Step 5: Run unit tests — expected PASS**

```bash
pnpm vitest run src/lib/solicitation/__tests__/batch-view.test.ts
```

- [ ] **Step 6: Write the failing route tests**

```ts
it('returns 404 before auth when SOLICITATION_WATCH_ENABLED is off', async () => { /* … */ });
it('rejects aggregate location scope with 400', async () => { /* … */ });
it('returns uniform 404 for a location owned by another account', async () => { /* … */ });
```

Copy the mocking shape from `src/app/api/dashboard/contacts/__tests__/flag-404.test.ts`. The first test must assert the auth helper was **never called** — a 404 status alone does not prove gate order.

Add one more (non-contract) route test: **the `?scope=` query param the client sends resolves to the same location the response describes.** `resolveDashboardRequest` reads scope from the request, so a client that omits or misspells the param silently falls back to a different owned location and the owner sees another site's batch. Pin the param name in one shared constant used by both the client fetch and this test.

- [ ] **Step 7: Implement the GET route**

A composition root, so it may import `@/lib/db/server`. Copy `src/app/api/dashboard/contacts/route.ts:15-25` line for line.

```ts
export const dynamic = 'force-dynamic';
const logger = createWorkerLogger('api/dashboard/solicitation/batch');

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): 404 before auth when watch-mode is off.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/solicitation/batch',
    errorMessage: 'Failed to fetch batch',
  }, async ({ user, accountId }) => {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const view = await readLatestBatch(sql, accountId, location.locationId);

    // Observability: the ONLY signal separating a correct empty state from a
    // read bug that renders one. hasBatch:false here next to a batch row in
    // Postgres IS the bug. No review, contact or response text is logged.
    // WorkerLogger exposes log/warn/error only — there is NO .info method
    // (src/lib/shared/logger.ts:4-8). `logger.info(...)` fails typecheck.
    logger.log('batch_view_read', {
      hasBatch: view.state !== 'no_batch',
      askCount: view.state === 'built' ? view.evaluated : 0,
      sendCount: view.state === 'built' ? view.queued : 0,
      businessId: location.locationId,
    });

    return jsonResponse(view);
  });
}
```

> **Deliberate first-use, not invention:** no route under `src/app/` currently logs. `createWorkerLogger` is CLAUDE.md's single structured-logging owner (the name is historical, not a worker-only scope). Adding a second logging mechanism to dodge the name would be the actual violation.

> **This GET is a pure read.** It performs no write — see step 4's note on why folding `reviewed_at` in here corrupts the signal.

> **Log volume:** the client polls this route every 2s while a batch builds, so log unconditionally only when `state !== 'building'`; while building, log the first response and then only on state change. A 5-minute build would otherwise emit 150 identical lines per viewer.

- [ ] **Step 8: Run route tests — expected PASS**

```bash
pnpm vitest run src/app/api/dashboard/solicitation/batch
```

- [ ] **Step 9: Write the live-DB integration test**

`batch-view.integration.test.ts`, seeding in the style of `batch-builder.integration.test.ts`. Must cover: several batches for one location (most recent wins, including a **same-`created_at` tie** proving the `id DESC` tie-break); a 40-withhold group (`total === 40` while `sample.length === 10`); cross-account isolation; and a second `markBatchReviewed` call leaving `reviewed_at` unchanged.

**Plus a performance case that actually exercises the risk.** Seed a batch of **5,000 asks** (the candidate-window bound) and assert the read completes well inside the 30s `statement_timeout`. Then run `EXPLAIN (ANALYZE, BUFFERS)` on Q3 and record the plan in the deviations file. This matters because every ask index leads on `business_id`, not `batch_id` (`migration 088:200-211`), so nothing guarantees Postgres won't scan a location's full ask history across all its batches. **If it seq-scans, stop and add a `(batch_id)` index — that is a migration, which changes `db_touching` and the ship lane, so it must come back to the human, not be quietly added.**

> **#520 lesson:** this suite is NOT hard-gated by `pnpm test:integration`; it must be run explicitly, which is why it is in the intake's `verification_commands`.

- [ ] **Step 10: Run it, then commit**

```bash
TEST_DATABASE_POOL_URL=<staging pool url> pnpm vitest run src/lib/solicitation/__tests__/batch-view.integration.test.ts
git add -A && git commit -m "feat(solicitation): batch read model + GET /api/dashboard/solicitation/batch"
```

---

### Task 2: The Requests screen — built state

**Blocking edges:** T1. **Covers intake tests:** 8, 9, 13.

**REQUIRED SKILL:** invoke `repworth-brand-design` before writing any JSX.

**Visual source:** `git show prototype/537-watch-mode-batch-screen:src/app/\(authenticated\)/dashboard/solicitation-prototype/SolicitationPrototype.tsx` and its `prototype.css`. Build the **synthesis** #537 locked: variant B's funnel hero on top, variant A's reason-grouped withheld ledger below. **Do not port** B's gate-expansion or C's filter chips — both are explicit non-goals.

- [ ] **Step 1: Write the failing render tests**

```tsx
it('renders the six withhold reason codes verbatim', () => { /* … */ });
it('renders no star rating anywhere on the batch screen', () => { /* … */ });
it('renders suppressed as an explicit zero-count group', () => { /* … */ });
```

The second is the ADR 0012 guard and must be a **negative sweep over the whole rendered tree**: assert the container text matches neither `/\d(\.\d)?\s*star/i` nor `/★/`, and that no `[aria-label*="star" i]` element exists. Port the shape from the prototype's `__tests__/prototype-smoke.test.tsx`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run 'src/app/(authenticated)/dashboard/requests'
```

- [ ] **Step 3: Implement `page.tsx`**

```tsx
import { notFound } from 'next/navigation';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { RequestsClient } from './RequestsClient';

export const dynamic = 'force-dynamic';

export default function RequestsPage() {
  // Server-authoritative flag gate (invariant #13, mirrors the API route):
  // when watch-mode is off this surface does not exist — 404, no client hint.
  if (!solicitationWatchEnabled()) notFound();
  return <RequestsClient />;
}
```

- [ ] **Step 4: Implement `BatchReport.tsx`**

- **Funnel hero** — `contactsOnFile` rendered as a present-tense fact ("1,240 contacts on file"), **visually separated** from the funnel because it has a different denominator than the batch rungs → `evaluated` → `queued`. A watch-mode pill makes "nothing was sent" unmissable. Build time as **relative** text ("Built 3 days ago") — no staleness threshold (see T5's CONTEXT.md note).
- **Withheld ledger** — `groups` in array order (already precedence order): mono `reason` chip **verbatim**, owner-readable label, exact `total`, up to 10 evidence rows, "…and N more" when `total > sample.length`.
- `velocity_banked` styled as banked (violet), copy "first in line for the next batch" — banking is volume shaping, not rejection.
- `already_reviewed` renders `review_date` **only**. Never a rating; never `review_id` as user-facing text.
- Footnote pointing at the upload report for validation rejections — never withholds (#533 boundary rule).
- Reason→label map is one `const` in this file; the **codes** come from `WITHHOLD_REASONS`, never re-typed as string literals.

**Accessibility acceptance criteria** (all required, all tested): each reason group is a section with a semantic heading; the funnel is a `<ol>`, not divs; every interactive target ≥44px; visible focus ring on all focusables; no colour-only encoding of `velocity_banked` vs refusals (chip carries text); text contrast ≥4.5:1 in both themes; any animation respects `prefers-reduced-motion`.

- [ ] **Step 5: Run tests — expected PASS, then commit**

```bash
pnpm vitest run 'src/app/(authenticated)/dashboard/requests'
git add -A && git commit -m "feat(requests): batch report — funnel hero + spoilage report ledger"
```

---

### Task 3: Every other screen state

**Blocking edges:** T2. **Covers intake tests:** 10, 11, 12.

This task exists because the failure states outnumber the happy one. Implement **all** of them:

| Condition | Render |
|---|---|
| initial fetch in flight | loading skeleton, `aria-busy="true"` |
| aggregate ("all locations") scope selected | "Choose a location" — **do not fetch** (the API 400s); precedent `ContactsClient.tsx:37` |
| fetch fails (500/network) | error state with a retry button; retry re-fetches |
| 404 (flag turned off mid-session) | "This feature is no longer available" + full page reload, since the route itself is now gone |
| 401 | defer to the existing dashboard auth redirect |
| `state === 'no_batch'` | `GhostPipeline` empty mode |
| `state === 'building'` | `GhostPipeline` building mode + bounded polling |
| `state === 'built'`, `queued === 0` | `BatchReport` with a 0-queued funnel — **not** the empty state |

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders the ghost pipeline empty state with the contacts-on-file count when no batch exists', () => { /* … */ });
it('renders the building state while built_at is null and stops polling at the ceiling', () => { /* … */ });
it('renders a zero-queued funnel rather than the empty state when a built batch has no asks', () => { /* … */ });
```

Plus non-contract tests for: aggregate scope issuing **zero** fetches; error + retry; and a location switch mid-poll discarding the stale response. The polling test uses `vi.useFakeTimers()` past the ceiling and asserts no further `fetch` and that "still processing" appears. The third contract test is the trap-guard: a `'built'` view with `queued: 0` must render `BatchReport`, never `GhostPipeline`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run 'src/app/(authenticated)/dashboard/requests'
```

- [ ] **Step 3: Implement `GhostPipeline.tsx`**

Two modes from one component (they are the same skeleton at different opacity — splitting them would create two shallow components sharing one stylesheet):
- `'no_batch'` — six gates listed grayed-out (in watch-mode the restraint story *is* the product, so the empty state previews it), upload CTA to `/dashboard/requests/contacts`, consent-attestation framing, watch-mode reassurance. When `contactsOnFile > 0`, add exactly one line: *"1,240 contacts on file — upload a new file to build your first batch."*
- `'building'` — same ghost funnel, "Building your batch…", `aria-busy="true"`, and a polite `aria-live` region announcing completion so the transition is not silent for screen-reader users.

- [ ] **Step 4: Implement fetching and polling in `RequestsClient`**

Port from `UploadCard.tsx:195-246` — 2s cadence, 5-minute ceiling, `inFlight` overlap guard — with three corrections the precedent's shape does not give for free:

1. **Check the deadline BEFORE the `inFlight` guard.** If one fetch hangs forever, `inFlight` stays true and no later tick ever reaches the timeout, so the ceiling silently never fires.
2. **Key state by location scope and abort in-flight requests on switch** (`AbortController`). Copying cadence alone lets an old location's response overwrite the new location's state.
3. **Poll only while `state === 'building'`**; stop on every other state. A `no_batch` screen does not poll — a CSV completing in another tab will not appear until reload, which is the accepted trade for not polling indefinitely on an idle screen.

- [ ] **Step 5: Fire the `reviewed_at` ping on first render of a built batch**

`POST /api/dashboard/solicitation/batch/reviewed?scope=<same scope the GET used>` with `{ batchId }`, fired from an effect that runs when `BatchReport` has actually rendered — not when the fetch resolves.

**The `?scope=` param is mandatory on the POST, not just the GET.** `resolveDashboardRequest` (`src/app/api/dashboard/policy.ts:42-48`) reads scope from the request and falls back to `userLocationId` when it is absent — so a POST without it resolves the *default* location, the three-key UPDATE matches zero rows, and the route still returns `204`. Every non-default location would silently never record `reviewed_at` while looking perfectly healthy. Build the URL from the same shared scope constant the GET uses, and cover it with a test asserting a non-default location updates one row. Guard with a ref **keyed by `batchId`**, not a boolean: a scalar "already pinged" flag would mark batch A and then suppress batch B after a location switch.

Do **not** fire while the tab is hidden — check `document.visibilityState === 'visible'` and defer to the `visibilitychange` event otherwise. This is the whole point of reverting to a POST: the signal must mean a human looked.

Failures are reported, not swallowed — a console-level report is enough client-side, but "not opened" must stay distinguishable from "the write failed".

- [ ] **Step 6: Run tests — expected PASS, then commit**

```bash
pnpm vitest run 'src/app/(authenticated)/dashboard/requests'
git add -A && git commit -m "feat(requests): ghost pipeline, building state, loading/error/scope states"
```

---

### Task 4: Navigation (both navs) + the contacts route move

**Blocking edges:** T2. **Covers intake test:** 14.

- [ ] **Step 1: Write the failing test**

Verbatim: `hides the Requests sidebar row when watch-mode is off`. Render `<Sidebar … solicitationEnabled={false} />`, assert no `Requests` link; with `true`, assert one with `href="/dashboard/requests"`. Add the mirrored assertions for `MobileTabBar`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run src/components/dashboard/__tests__
```

- [ ] **Step 3: Thread the flag from the server layout**

In `src/app/(authenticated)/layout.tsx` (a server component, a permitted composition root) call `solicitationWatchEnabled()` and pass `solicitationEnabled={…}` to **both** `<Sidebar>` and `<MobileTabBar>`. **No `NEXT_PUBLIC_*` companion** — invariant #13, and `ci:static-policy` fails the build on any new one.

- [ ] **Step 4: Add the row to both navs**

`Sidebar.tsx` — new `solicitationEnabled: boolean` prop, row rendered **between Reviews and Analytics** only when true:

```tsx
{solicitationEnabled && (
  <Link href="/dashboard/requests" className={`nav-item ${isRequests ? 'active' : ''}`}
        aria-current={isRequests ? 'page' : undefined}>
    <Icon name="send" /> Requests
  </Link>
)}
```

Extend the active-path logic at `Sidebar.tsx:62-66`: add `const isRequests = pathname.startsWith('/dashboard/requests');` and `&& !isRequests` to the `isDashboard` fallback, or Requests lights up Dashboard too.

`MobileTabBar.tsx` — same prop, same `isRequests`, same conditional row, matching its `aria-current` convention. **This nav was missed in revision 1**; without it Requests is desktop-only. Pick an existing `Icon` name; add no icon asset.

- [ ] **Step 5: Move the contacts page**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-544-watch-mode-batch-ui
git mv src/app/\(authenticated\)/dashboard/contacts src/app/\(authenticated\)/dashboard/requests/contacts
```

Fix relative imports and any hard-coded `/dashboard/contacts` string in the moved files. **The API path `/api/dashboard/contacts` does NOT change** — only the page route moves. No redirect shim: the flag has never been on in any environment, so no live URL exists to break.

- [ ] **Step 6: Run, then commit**

```bash
pnpm vitest run src/components/dashboard 'src/app/(authenticated)/dashboard' && pnpm typecheck
git add -A && git commit -m "feat(requests): Requests nav row (desktop + mobile) + contacts page move"
```

---

### Task 5: Documentation and registries

**Blocking edges:** T4.

- [ ] **Step 1: Amend `SOLICITATION_WATCH_ENABLED`** (`.claude/reference/env-vars.md:528`)

It currently says the flag gates "the ENTIRE contacts/visits CSV surface". Extend: it also gates `/dashboard/requests`, `/dashboard/requests/contacts` and `GET /api/dashboard/solicitation/batch` (404 before auth on each), plus the `Requests` row in **both** navs via a server prop from `(authenticated)/layout.tsx`, no `NEXT_PUBLIC` companion. Record that the page path moved.

- [ ] **Step 2: Register JSONB parser site #17** (`.claude/CLAUDE.md`)

The allowlist says "exactly 16 production JSONB field-to-parser sites today". Change to 17 and add: `solicitation_asks.evidence` (1): `src/lib/solicitation/batch-view.ts`.

- [ ] **Step 3: Update `CONTEXT.md`**

1. Add the owner-facing label: **Requests** — the owner-facing name of the Solicitation surface (`/dashboard/requests`); `Solicitation` stays the internal/agent term, `Ask` keeps its per-candidate meaning. *(coined in ticket #544)*
2. Amend **Solicitation batch** (line 36): `expired` is **not implemented** — watch-mode renders a relative build time instead, and the derived-expiry constant lands in send-mode where it gates something (`run-engine-executor-shape.md:87-90`). The glossary must not describe code that does not exist.

- [ ] **Step 4: Update `docs/directory.md`**, then commit

Add the `requests/` page tree, the `api/dashboard/solicitation/` route family, `src/lib/solicitation/batch-view.ts`; fix the moved `dashboard/contacts` path.

```bash
git add -A && git commit -m "docs: register Requests surface, JSONB site 17, Requests glossary term"
```

---

### Task 6: One owner for the solicitation route access policy *(droppable)*

**Blocking edges:** T1. **Sequenced last deliberately** — it delivers no user-visible behavior and rewires four working routes, so it lands only after everything else is green and can be dropped without touching #544's behavior.

- [ ] **Step 1: Move the file, rename the exports**

```bash
mkdir -p src/app/api/dashboard/solicitation
git mv src/app/api/dashboard/contacts/location-scope.ts src/app/api/dashboard/solicitation/scope.ts
```

Rename exactly: `requireContactsLocationScope` → `requireSolicitationLocationScope`, `requireContactsWriteAccess` → `requireSolicitationWriteAccess`, `resolveContactsScopedId` → `resolveSolicitationScopedId`, `ContactsLocationScopeResult` → `SolicitationLocationScopeResult`, `ContactsScopedIdResult` → `SolicitationScopedIdResult`. Update the header comment to say the policy is shared by the contacts **and** batch route families.

- [ ] **Step 2: Update importers** — the four `src/app/api/dashboard/contacts/**/route.ts` files and the batch route from T1.

- [ ] **Step 3: Run — expected PASS (pure rename), then commit**

```bash
pnpm vitest run src/app/api/dashboard && pnpm typecheck
git add -A && git commit -m "refactor(solicitation): one owner for the solicitation route access policy"
```

---

## Verify gate

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-544-watch-mode-batch-ui
bash scripts/verify-gate.sh
```

Plus, explicitly (NOT hard-gated by `pnpm test:integration` — the #520 class):

```bash
TEST_DATABASE_POOL_URL=<staging pool url> pnpm vitest run src/lib/solicitation/__tests__/batch-view.integration.test.ts
```

`surface: mixed` includes `ui`, so `pnpm build` runs. Final pre-review run is `bash scripts/verify-gate.sh --review` (coverage + changed-line diff-coverage ≥80%).

## Ship (RISK = high)

1. Land on `staging`; both the Railway staging worker and the Vercel staging Custom Env redeploy on push.
2. **Flip `SOLICITATION_WATCH_ENABLED=true` in BOTH places** via the `flag-flip` skill — Vercel staging env (new; it has never carried this flag) **and** the Railway staging worker. Worker-only is the mistake that makes this ticket look broken.
3. Smoke: upload a CSV at `/dashboard/requests/contacts` → watch the building state → confirm the funnel and six reason groups → re-open and confirm `reviewed_at` did not move.
4. PR to `main`, all CI green, pause for merge approval. **No production flip** — explicitly out of scope for #544.

---

## Revision log (rev 1 → rev 2)

Adversarial review returned `VERDICT: REVISE`. Accepted and fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | Separate count and sample queries can tear (owner contact DELETE cascades to asks), violating the locked "hero and ledger cannot disagree" invariant | Counts + samples now come from **one** windowed statement (`COUNT(*) OVER` + `ROW_NUMBER()`) |
| 2 | `evidence` typed `WithholdEvidence \| null`, but the column is `JSONB NOT NULL` and the builder writes a send envelope for queued asks (`batch-builder.ts:499`) | Typed `AskDecision`; withheld sample query filters `status = 'withhold'` |
| 3 | Q2 omitted account scope and cited a false precedent — `contacts-repo.ts:66-68` joins `businesses` and filters `b.account_id` | Q2 now joins `businesses`; invariant #8 restored |
| 4 | `reviewed_at` could violate the `reviewed_at >= built_at` CHECK under worker/DB clock skew | `GREATEST(NOW(), built_at)` |
| 5 | Response row-bounded but not byte-bounded; `contact_name` is unbounded `TEXT` | `LEFT(c.name, 80)` |
| 6 | `queuedSample` added 25 PII rows beyond the intake's locked 6×10 bound | Queued panel dropped; funnel shows the count only |
| 7 | `created_at` is not unique — "most recent" was nondeterministic | `ORDER BY created_at DESC, id DESC`, with a tie test |
| 8 | Literal `25` duplicated `BATCH_CAP` | Import the constant (moot after #6, but the rule stands) |
| 9 | Task graph wrong (T5 needed T3, not T4); rename sequenced first | `reviewed_at` folded into T1; rename moved last and marked droppable |
| 10 | Missing UI states: loading, error/retry, aggregate scope, flag-off mid-session, location switch, hung poll | All specified in T3, with the deadline-before-`inFlight` and `AbortController` corrections |
| 11 | `MobileTabBar` never touched — Requests would be desktop-only | T4 now covers both navs |
| 12 | No a11y acceptance criteria | Explicit criteria in T2, `aria-busy`/`aria-live` in T3 |
| 13 | Timestamps selected raw despite being declared strings | `::text` throughout (postgres.js µs-truncation gotcha) |
| 14 | Plan edits `.claude/CLAUDE.md`, outside the locked surface; integration filename disagreed with the intake | Both folded into a single pending intake amendment (below) |

## Revision log (rev 2 → rev 3)

Round-2 adversarial review returned `VERDICT: REVISE` again. All seven findings accepted:

| # | Finding | Fix |
|---|---|---|
| 1 | Folding `reviewed_at` into the GET records "opened" for reports no human saw — 2s background-tab polling and aborted location-switch fetches both fire it, inflating the engagement number with our own traffic | **Reverted to a dedicated POST**, fired on first *render* of a built batch, ref keyed by `batchId`, suppressed while the tab is hidden, failures reported not swallowed |
| 2 | Rev 2's rejection of the transaction finding was wrong: Q1 and Q3 are still separate, and offboarding purge (`purge-stages.ts:243`) can delete a batch between them, rendering a "built" batch with zero asks | All reads now run in one `REPEATABLE READ, READ ONLY` transaction |
| 3 | `?scope=` propagation never pinned or tested — client and `resolveDashboardRequest` could resolve different locations | Param name pinned in one shared constant; route test asserts the resolved location matches the response |
| 4 | `COUNT(*) OVER` returns bigint, breaking the declared `total: number` | `::int` cast, as `contacts-repo.ts:63` already does |
| 5 | The claimed intake amendment had not actually been applied | Applied to both copies (audit + arming): `.claude/CLAUDE.md`, `src/components/dashboard/**`, corrected integration-test filename |
| 6 | The only perf test used 40 rows, while the ask indexes lead on `business_id`, not `batch_id` | Integration test seeds **5,000 asks** and records `EXPLAIN (ANALYZE, BUFFERS)`; a seq scan escalates to the human because the fix is a migration, which changes the ship lane |
| 7 | Unused `BATCH_CAP` import would fail lint | Removed, with a comment saying why it is absent |

Also fixed (non-blocking): deterministic `ORDER BY` on evidence rows, `CONTACT_NAME_MAX` instead of a literal `80`, and log sampling so 2s polling does not emit ~150 identical lines per build.

**Self-caught between rounds:** rev 2 split the funnel's `queued`/`held` counts from the ledger's per-reason totals into two statements — reintroducing the exact tear rev 2 claimed to fix. Repaired to a single CTE (`totals` + `ranked`, `LEFT JOIN`) before round 3.

**Nothing is now carried as unverified risk.** The one open item from rev 2 — whether Q3 seq-scans a large batch — is converted into a mandatory test with a defined escalation path.

## Revision log (rev 3 → rev 4)

Round-3 review returned `VERDICT: REVISE` with two findings, both accepted and both verified against source before fixing:

| # | Finding | Fix |
|---|---|---|
| 1 | `logger.info(...)` does not exist — `WorkerLogger` exposes only `log`/`warn`/`error` (`src/lib/shared/logger.ts:4-8`), so the route as written fails typecheck | `logger.log(...)`, with the interface noted inline |
| 2 | The reviewed POST omitted `?scope=`; `resolveDashboardRequest` (`policy.ts:42-48`) then falls back to `userLocationId`, so the three-key UPDATE matches **zero rows while still returning 204** — every non-default location would silently never record `reviewed_at` | `?scope=` mandatory on the POST, built from the same shared constant as the GET, with a non-default-location test |

Round 3 confirmed the round-2 fixes hold, including the single-CTE snapshot and the reverted POST. Three rounds is the cap; both remaining findings were accepted rather than disputed, so there is no disagreement to escalate — the plan proceeds with these two applied.

**Carried into execution as an unverified pattern** (not a defect, but the first of its kind in this repo): `rg` finds zero prior uses of `ISOLATION LEVEL` / `REPEATABLE READ` / `SERIALIZABLE` anywhere in the codebase. T1's `REPEATABLE READ, READ ONLY` wrapper must be **proven** against the live staging pool during T1 step 9 — Supabase runs PgBouncer in transaction pooling mode, where CLAUDE.md already documents one silent no-op in this neighbourhood (`SELECT … FOR UPDATE` outside `sql.begin()`). If the isolation level does not actually take effect, say so and re-plan the purge-race fix rather than shipping a wrapper that reads as protection but isn't.

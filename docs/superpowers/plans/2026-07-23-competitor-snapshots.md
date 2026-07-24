# Competitor Snapshots (#538) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Competitor pack — the full ~20-entry `google_maps` local pack — as normalized `competitor_snapshots` rows from the SAME SerpAPI response `RankingTrackingWorker` already fetches, per the #532 locked Competitor Delta semantics.

**Architecture:** One new standalone table mirroring `ranking_snapshots`' key (business + keyword + snapshot_date, `search_location` as a column), written with replace-pack idempotency (DELETE + bulk INSERT) in ONE `sql.begin()` transaction together with the existing own-rank upsert. The worker's internal `resolveRankPosition` is deepened into `resolveLocalPack`, returning `{ rankPosition, pack }` — SerpAPI response shape, position-fallback normalization, and mock-mode synthesis all hidden behind that single interface. No new seam: the table itself is the seam to the downstream digest/#546 tickets.

**Tech Stack:** Postgres migration 084 (UUIDv7, RLS owner_select mirror of 035 §2f), Postgres.js tx, existing Vitest harness in `worker/jobs/__tests__/RankingTrackingWorker.test.ts`.

**Intake contract:** `docs/superpowers/plans/feat-competitor-snapshots-538-intake.json` (drift detector — edit surface, invariants, promised tests). RISK = high → staging ride before `main`.

**Blocking edges:** Task 2 depends on Task 1 (table must exist for audits + migration content is referenced by the worker SQL). Task 1 has no dependencies.

---

### Task 1: Migration 084 + audit registration + docs bookkeeping

**Files:**
- Create: `supabase/migrations/084_competitor_snapshots.sql`
- Modify: `scripts/ci/tenant-tables.ts` (add `'competitor_snapshots'` next to `'ranking_snapshots'`, line ~22)
- Modify: `.claude/reference/migrations-log.md` (head bump 083→084 + entry + retention note)
- Modify: `CONTEXT.md` (glossary: **Competitor pack** term under the Competitor Delta section)

- [ ] **Step 1: Write the migration**

```sql
-- 084_competitor_snapshots.sql
-- Competitor pack persistence (#538, wayfinder map #528; semantics locked in #532).
-- Persists the full ~20-entry google_maps local pack per
-- (business, keyword, search_location, snapshot_date) from the SAME SerpAPI
-- response RankingTrackingWorker already fetches — zero marginal quota.
-- Idempotency is replace-pack: rows are deleted + reinserted atomically per
-- (business_id, keyword, snapshot_date); there is deliberately NO per-row
-- unique key because place_id can be NULL on rare entries.
-- search_location is deliberately NOT part of the replace key: the parent
-- ranking_snapshots upsert key is (business_id, keyword, snapshot_date) and
-- OVERWRITES search_location on same-day re-run — the pack mirrors that, so an
-- owner editing ranking_search_location can never orphan a stale same-day pack.
-- #532's business+keyword+search_location key is the READ-side comparison
-- filter, applied by consumers over these ≤~20-row packs.
-- Concurrency: the worker's tx performs the ranking_snapshots upsert FIRST;
-- its unique-index row lock serializes concurrent same-key jobs, so the
-- DELETE+INSERT below it can never interleave into a duplicated pack.
-- data_cid is write-only in v1 — insurance for place_id-rotation continuity.
-- RLS: owner read-only, mirroring ranking_snapshots (035 §2f). All writes come
-- from the Railway worker over the direct Postgres connection (not subject to
-- these authenticated-role policies).

CREATE TABLE competitor_snapshots (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  keyword VARCHAR(255) NOT NULL,
  search_location VARCHAR(255),
  snapshot_date DATE NOT NULL,
  rank_position INTEGER,               -- normalized pack position (SerpAPI position, else array index + 1)
  place_id TEXT,                       -- canonical ChIJ… Place ID; NULL when SerpAPI omits it
  data_cid TEXT,                       -- long-lived Google CID; unread in v1
  title TEXT NOT NULL,                 -- '' when SerpAPI omits the name
  rating REAL,                         -- NULL when unrated
  review_count INTEGER,                -- NULL when absent
  is_self BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_competitor_snapshots_lookup
  ON competitor_snapshots (business_id, keyword, snapshot_date DESC);

ALTER TABLE competitor_snapshots ENABLE ROW LEVEL SECURITY;

-- Owner can SELECT competitor packs for their account's locations. Read-only —
-- no INSERT/UPDATE/DELETE policies for the authenticated role.
DROP POLICY IF EXISTS competitor_snapshots_owner_select ON competitor_snapshots;
CREATE POLICY competitor_snapshots_owner_select ON competitor_snapshots
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));
```

- [ ] **Step 2: Register the table for the CI audits**

In `scripts/ci/tenant-tables.ts`, add `'competitor_snapshots',` on the line after `'ranking_snapshots',` (keep the business-scoped grouping).

- [ ] **Step 3: Update `.claude/reference/migrations-log.md`**

Change the head line to `Current head: **084** — next migration is **085**` and add the entry (follow the existing entry format in the file):

```markdown
- **084_competitor_snapshots.sql** — Competitor pack persistence (#538, map #528,
  semantics #532). New `competitor_snapshots` table (full ~20 local-pack rows per
  business+keyword+snapshot_date incl. is_self row; nullable place_id/rating/
  review_count; data_cid write-only rotation insurance). Replace-pack idempotency
  (DELETE+INSERT in the RankingTrackingWorker tx) — deliberately no per-row unique
  key. RLS owner_select mirror of 035 §2f. Retention: exempt (core competitor
  history, ~20 rows/business/week); revisit if table exceeds ~5M rows or when the
  Competitor Delta digest line ships.
```

- [ ] **Step 4: Add the glossary term to `CONTEXT.md`**

Append under the "Competitor Delta (locked 2026-07-23 — ticket #532…)" section:

```markdown
- **Competitor pack**: the full ~20-entry `local_results` set persisted as `competitor_snapshots` rows per (business, keyword, search_location, snapshot_date) — is_self row included when the location appears, entries with missing place_id/rating/review_count kept with NULLs. Replaced atomically on re-run (replace-pack idempotency); an empty pack for a date is itself a recorded fact. *(coined in #538 grilling)*
```

- [ ] **Step 5: Run the DB-touching audits**

Run (from the worktree root): `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538 && pnpm ci:rls-audit && pnpm ci:tenant-scope`
Expected: both PASS. `ci:rls-audit`'s static gate reads the migrations SQL, so the ENABLE RLS in this same commit satisfies the new registration; its live-DB check only runs when `TEST_DATABASE_POOL_URL` is set (leave it unset locally — the staging/prod schema gets migration 084 at ship time).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/084_competitor_snapshots.sql scripts/ci/tenant-tables.ts .claude/reference/migrations-log.md CONTEXT.md
git commit -m "feat(db): competitor_snapshots table — Competitor pack persistence (#538)"
```

**Do NOT apply the migration to any Supabase project in this task** — staging application happens at ship (step 8), prod in lockstep at promotion.

---

### Task 2: Worker extension — resolveLocalPack + transactional pack persistence (TDD)

**Files:**
- Modify: `worker/jobs/RankingTrackingWorker.ts` (rename/extend `resolveRankPosition` → `resolveLocalPack`; wrap step-7 persistence in `sql.begin`)
- Test: `worker/jobs/__tests__/RankingTrackingWorker.test.ts` (extend the existing harness — `sqlReturnQueue`/`mockSql`/`mockSql.begin` already exist)

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('RankingTrackingWorker')` block (harness helpers `makeJob`, `mockBusinessRow`, `sqlReturnQueue`, `mockGetJson`, `mockIsMockMode`, `mockSql` are already defined at the top of the file). Helper for reading a call's SQL text: `(c: any[]) => c[0]?.join?.('') ?? ''`.

```ts
describe('competitor pack persistence (#538)', () => {
  function sqlTextOf(call: any[]): string {
    return call[0]?.join?.('') ?? '';
  }
  function packInsertCalls() {
    return mockSql.mock.calls.filter((c: any[]) => sqlTextOf(c).includes('INSERT INTO competitor_snapshots'));
  }

  it('persists the full pack in one transaction with an is_self row and field mapping', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_rival_1', data_cid: 'cid-1', title: 'Rival One', position: 1, rating: 4.8, reviews: 320 },
        { place_id: 'ChIJ_test_place', title: 'Test Biz', position: 2, rating: 4.5, reviews: 120 },
        { place_id: 'ChIJ_rival_3', title: 'Rival Three', position: 3 },
      ],
    });

    await handleTrackRanking(makeJob());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    const inserts = packInsertCalls();
    expect(inserts).toHaveLength(3);
    // Self row: place_id matches business, is_self=true (is_self is the final value param)
    const selfCall = inserts.find((c: any[]) => c.includes('ChIJ_test_place'));
    expect(selfCall).toBeTruthy();
    expect(selfCall![selfCall!.length - 1]).toBe(true);
    // Rival rows carry is_self=false
    const rivalCall = inserts.find((c: any[]) => c.includes('ChIJ_rival_1'));
    expect(rivalCall![rivalCall!.length - 1]).toBe(false);
    // data_cid mapped when present
    expect(rivalCall).toContain('cid-1');
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('preserves NULLs for missing rating/reviews/place_id and never drops entries', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { title: 'No Identity Diner', position: 1 },                    // no place_id at all
        { place_id: 'ChIJ_rival_2', title: 'Unrated Cafe', position: 2 }, // no rating/reviews
      ],
    });

    await handleTrackRanking(makeJob());

    // Positional map of the INSERT's value params (call[0] is the template
    // strings array, values follow): 1=id 2=business_id 3=keyword
    // 4=search_location 5=snapshot_date 6=rank_position 7=place_id
    // 8=data_cid 9=title 10=rating 11=review_count 12=is_self
    const inserts = packInsertCalls();
    expect(inserts).toHaveLength(2);
    const noIdentity = inserts.find((c: any[]) => c.includes('No Identity Diner'))!;
    expect(noIdentity[7]).toBeNull();  // place_id specifically → NULL
    expect(noIdentity[12]).toBe(false); // no place_id can never be self
    const unrated = inserts.find((c: any[]) => c.includes('Unrated Cafe'))!;
    expect(unrated[7]).toBe('ChIJ_rival_2');
    expect(unrated[10]).toBeNull();  // rating → NULL
    expect(unrated[11]).toBeNull();  // review_count → NULL
  });

  it('deletes the existing pack before inserting (replace-pack idempotency)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
    });

    await handleTrackRanking(makeJob());

    const calls = mockSql.mock.calls;
    const deleteIdx = calls.findIndex((c: any[]) => sqlTextOf(c).includes('DELETE FROM competitor_snapshots'));
    const insertIdx = calls.findIndex((c: any[]) => sqlTextOf(c).includes('INSERT INTO competitor_snapshots'));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });

  it('clears the pack (delete, zero inserts) when local_results is empty', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    await handleTrackRanking(makeJob());

    const deleteCall = mockSql.mock.calls.find((c: any[]) => sqlTextOf(c).includes('DELETE FROM competitor_snapshots'));
    expect(deleteCall).toBeTruthy();
    expect(packInsertCalls()).toHaveLength(0);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('persists the pack without an is_self row when own business is absent', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 },
        { place_id: 'ChIJ_rival_2', title: 'Rival Two', position: 2 },
      ],
    });

    await handleTrackRanking(makeJob());

    const inserts = packInsertCalls();
    expect(inserts).toHaveLength(2);
    for (const c of inserts) expect(c[c.length - 1]).toBe(false);
  });

  it('fails the job when the pack write fails (tx rejects, outbox untouched)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
    });
    mockSql.begin.mockRejectedValueOnce(new Error('insert exploded'));

    await expect(handleTrackRanking(makeJob())).rejects.toThrow('insert exploded');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('propagates a failure thrown INSIDE the tx callback (pack insert throws)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
    });
    // Throw from the competitor INSERT executed inside sql.begin's callback —
    // exercises the real code path (begin's default impl runs cb(mockSql)).
    const originalImpl = mockSql.getMockImplementation();
    mockSql.mockImplementation((s: TemplateStringsArray, ..._v: unknown[]) => {
      if ((s?.join?.('') ?? '').includes('INSERT INTO competitor_snapshots')) {
        return Promise.reject(new Error('pack insert exploded'));
      }
      return Promise.resolve(sqlReturnQueue.shift() ?? []);
    });

    await expect(handleTrackRanking(makeJob())).rejects.toThrow('pack insert exploded');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    mockSql.mockImplementation(originalImpl!);
  });

  it('synthesizes and persists a mock pack through the same tx path in mock mode', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockIsMockMode.mockReturnValue(true);

    await handleTrackRanking(makeJob());

    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    const inserts = packInsertCalls();
    expect(inserts.length).toBeGreaterThan(0);
    const selfRows = inserts.filter((c: any[]) => c[c.length - 1] === true);
    expect(selfRows).toHaveLength(1);
  });
});
```

Note on the atomicity test: true DELETE+INSERT rollback is Postgres `sql.begin` semantics we don't re-prove in unit tests; the unit contract proven here is "tx failure → job rejects → BullMQ retry, outbox untouched" (replace-pack + rank upsert make the retry converge).

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538 && pnpm vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts`
Expected: the new `competitor pack persistence` tests FAIL (no `competitor_snapshots` statements, no `sql.begin` call); all pre-existing tests still PASS.

- [ ] **Step 3: Implement `resolveLocalPack` + transactional persistence**

In `worker/jobs/RankingTrackingWorker.ts`:

(a) Add the pack types after `RankingBusiness`:

```ts
interface CompetitorPackEntry {
  position: number;
  placeId: string | null;
  dataCid: string | null;
  title: string;
  rating: number | null;
  reviewCount: number | null;
  isSelf: boolean;
}

interface LocalPackResult {
  rankPosition: number | null;
  pack: CompetitorPackEntry[];
}
```

(b) Replace `resolveRankPosition` with `resolveLocalPack` (same params, deeper return — SerpAPI shape, position fallback, and mock synthesis stay hidden inside):

```ts
// Resolve a keyword's full local pack: our own rank plus every competitor row
// (the Competitor pack, #532/#538). Mock mode synthesizes a pack; otherwise one
// SerpAPI google_maps query — the SAME call that always resolved the rank, so
// persisting competitors adds zero marginal quota.
async function resolveLocalPack(
  keyword: string,
  business: RankingBusiness,
  hasCoords: boolean,
  logger: RankingLogger,
): Promise<LocalPackResult> {
  if (isMockMode()) {
    const rankPosition = Math.floor(Math.random() * 10) + 1;
    const pack: CompetitorPackEntry[] = Array.from({ length: 10 }, (_, idx) => {
      const position = idx + 1;
      if (position === rankPosition) {
        return {
          position,
          placeId: business.google_place_id,
          dataCid: null,
          title: 'Mock Self',
          rating: 4.5,
          reviewCount: 120,
          isSelf: true,
        };
      }
      return {
        position,
        placeId: `mock-place-${position}`,
        dataCid: null,
        title: `Mock Rival ${position}`,
        rating: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
        reviewCount: 20 + Math.floor(Math.random() * 380),
        isSelf: false,
      };
    });
    logger.log(`[mock] keyword="${keyword}" rank=${rankPosition} pack=${pack.length}`);
    return { rankPosition, pack };
  }

  const params: Record<string, unknown> = {
    engine: 'google_maps',
    q: keyword,
    api_key: getWorkerConfig().SERPAPI_API_KEY,
    timeout: SERPAPI_TIMEOUT_MS,
  };

  if (hasCoords) {
    params.ll = `@${business.google_place_lat},${business.google_place_lng},15z`;
  } else {
    params.location = business.ranking_search_location;
  }

  const response = await getJson(params);

  if (response.error) {
    const errorMsg = typeof response.error === 'string'
      ? response.error
      : JSON.stringify(response.error);
    throw new Error(`SerpAPI ranking search error: ${errorMsg}`);
  }

  const localResults: Array<{
    place_id?: string;
    data_cid?: string;
    title?: string;
    position?: number;
    rating?: number;
    reviews?: number;
  }> = response.local_results ?? [];

  // Full-pack rule (#532): every entry is persisted; missing fields become
  // NULLs (title '' — an unnamed entry is still a rank fact), never dropped.
  const pack: CompetitorPackEntry[] = localResults.map((r, idx) => ({
    // Prefer SerpAPI's position field (handles non-contiguous results, ads,
    // mixed groups); fall back to array index + 1 — same rule the own-rank
    // match has always used.
    position: Number.isInteger(r.position) ? r.position! : idx + 1,
    placeId: typeof r.place_id === 'string' ? r.place_id : null,
    dataCid: typeof r.data_cid === 'string' ? r.data_cid : null,
    title: typeof r.title === 'string' ? r.title : '',
    rating: typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null,
    reviewCount: Number.isInteger(r.reviews) ? r.reviews! : null,
    isSelf: typeof r.place_id === 'string' && r.place_id === business.google_place_id,
  }));

  const selfEntry = pack.find((entry) => entry.isSelf);
  const rankPosition = selfEntry ? selfEntry.position : null;

  logger.log(
    `keyword="${keyword}" place_id=${business.google_place_id} ` +
    `rank=${rankPosition ?? 'not found'} (${pack.length} results)`,
  );
  return { rankPosition, pack };
}
```

(c) In `handleTrackRanking`, replace the Step 6/7 block inside the keyword loop:

```ts
    // ── Step 6: Resolve the local pack (mock synthesis, or SerpAPI google_maps) ──
    const { rankPosition, pack } = await resolveLocalPack(keyword, business, hasCoords, logger);

    // ── Step 7: Persist own rank + Competitor pack in ONE transaction ──
    // Replace-pack idempotency: delete + reinsert the pack for this
    // (business, keyword, date). A pack failure rolls back the rank row and
    // fails the job — BullMQ retry converges (upsert + replace are idempotent).
    // ORDER IS LOAD-BEARING: the rank upsert's unique-index row lock
    // (business_id, keyword, snapshot_date) serializes concurrent same-key
    // jobs, so the pack DELETE+INSERT below it can never interleave into a
    // duplicated pack. Keep the upsert first.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
        VALUES (${uuidv7()}, ${businessId}, ${keyword}, ${rankPosition}, ${searchLocationValue}, ${today}, 'serpapi')
        ON CONFLICT (business_id, keyword, snapshot_date)
        DO UPDATE SET rank_position = EXCLUDED.rank_position, search_location = EXCLUDED.search_location, source = 'serpapi'
      `;
      await tx`
        DELETE FROM competitor_snapshots
        WHERE business_id = ${businessId} AND keyword = ${keyword} AND snapshot_date = ${today}
      `;
      for (const entry of pack) {
        await tx`
          INSERT INTO competitor_snapshots
            (id, business_id, keyword, search_location, snapshot_date,
             rank_position, place_id, data_cid, title, rating, review_count, is_self)
          VALUES
            (${uuidv7()}, ${businessId}, ${keyword}, ${searchLocationValue}, ${today},
             ${entry.position}, ${entry.placeId}, ${entry.dataCid}, ${entry.title},
             ${entry.rating}, ${entry.reviewCount}, ${entry.isSelf})
        `;
      }
    });
```

The per-row INSERT loop is deliberate: the pack is bounded (≤ ~20 rows, weekly), and one-statement-per-call matches the house style and the queue-based test harness. Do not switch to `sql(rows)` bulk-insert helpers.

- [ ] **Step 4: Run the full worker test file**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538 && pnpm vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts`
Expected: ALL tests pass — the 7 new ones and every pre-existing one (the mock-mode + rank-only tests exercise the renamed function through the unchanged public seam `handleTrackRanking`).

- [ ] **Step 5: Run the DB-touching audits (worker SQL now references the table)**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538 && pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: PASS with NO allowlist changes — the tenant-scope audit ignores INSERT statements and the DELETE is directly `business_id`-scoped. Do NOT add entries to `scripts/ci/tenant-scope-allowlist.ts`: the audit rejects unused allowlist entries, so a speculative entry FAILS the audit.

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/RankingTrackingWorker.ts worker/jobs/__tests__/RankingTrackingWorker.test.ts
git commit -m "feat(worker): persist Competitor pack in RankingTrackingWorker tx (#538)"
```

(If Step 5 touched `scripts/ci/tenant-scope-allowlist.ts`, include it in the same commit.)

---

## Out of scope (intake non-goals — do not build)

Digest line, Named-rival storage/UI (#546), pagination past ~20, per-competitor lookups, rotation-continuity reads of `data_cid`, the stale `SERPAPI_PREFILL_COST_USD` constant, the unmerged research-docs branch, anything `google_local`.

## Verification gate (step 5 of /feature)

`scripts/verify-gate.sh` from the worktree root — lint, typecheck, full test suite, every `ci:*` audit, plus the intake's `pnpm vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts`.

## Ship lane (RISK = high)

Staging ride first: land on `staging`, apply migration 084 to the staging Supabase project, smoke the ranking path (staging worker logs + `competitor_snapshots` rows), then PR to `main`, CI green, explicit merge approval, migration to prod in lockstep at promotion.

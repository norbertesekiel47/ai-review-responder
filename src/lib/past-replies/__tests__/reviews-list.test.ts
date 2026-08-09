// src/lib/past-replies/__tests__/reviews-list.test.ts
//
// T1 EVAL suite for #678 — the Reviews list half of the 52 locked titles,
// authored VERBATIM before implementation.
//
// **Reviews list** (CONTEXT.md glossary, verbatim): the owner's single
// inventory of every review for a location. NOT a new page —
// `dashboard/reviews/history` is widened in place. Grouped `Unanswered` then
// `Answered`, newest-first inside each group, `PAGE_SIZE` 50. Distinct from the
// **Needs Action** queue at `dashboard/reviews`.
//
// RED until Task 4 (the query) and Task 5 (the row derivation — since #727 the
// two-axis `deriveAxes`/`deriveRowAction` — plus `provenanceBadge` /
// `groupReplies`) land. Every symbol Task 5 owns is reached through the module
// NAMESPACE rather than a named import: a named import of a missing export is an
// ESM link error that kills the whole file, which would un-register all 17
// titles. A namespace property is `undefined` today, so each title fails on its
// own terms — a red test beats a todo.

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import * as repliesView from '../replies-view';
import { loadPastRepliesPageView } from '../load-replies';

// The batched regen-budget peek (Task 6) is an Upstash read. Stub it so these
// pure query/grouping titles never reach Redis; its own fail-open behaviour is
// pinned in src/lib/costs/__tests__/regen-budget-batch.test.ts.
vi.mock('@/lib/costs/tracker', () => ({
  peekRegenBudgetBatch: vi.fn(async () => new Map()),
}));

const { PAGE_SIZE } = repliesView;

// Task 5 addition. Read off the namespace so a missing export is `undefined`
// (per-title failure) rather than a module-level link error.
const provenanceBadge = repliesView.provenanceBadge;

const ACCOUNT_ID = '01234567-0000-7000-8000-0000000000a0';
const LOCATION_ID = '01234567-0000-7000-8000-0000000000b0';
const OTHER_LOCATION_ID = '01234567-0000-7000-8000-0000000000b1';
const ACTIVATED = '2026-03-01T00:00:00.000Z';

// ── The post-Task-4 view shape ────────────────────────────────────────────────
//
// `PastRepliesPageView` still spells gapRows/histRows today, so these local
// interfaces describe what Task 4 Step 3 renames it to. The cast at the call
// site keeps this scaffolding type-clean while leaving the ASSERTIONS red.

interface ListCardRow {
  review_id: string;
  reply_state: string;
  row_action: string;
  response_id: string;
  approved_text: string | null;
  posted_at: string | null;
  failed_response_id: string | null;
  failed_posting_error: string | null;
  version: number | null;
}

interface ReviewsListView {
  locationDisplayName: string;
  unansweredRows: ListCardRow[];
  answeredRows: ListCardRow[];
  unansweredTotal: number;
  answeredTotal: number;
  avgStarRating: number | null;
  page: number;
  totalPages: number;
}

interface SqlCall {
  text: string;
  values: readonly unknown[];
}

interface FakeRows {
  biz?: Record<string, unknown>[];
  main?: Record<string, unknown>[];
  unansweredTotal?: number;
  answeredTotal?: number;
  avg?: number | null;
}

const DEFAULT_BIZ = {
  name: 'Harbour Bakery',
  display_label: null,
  subscription_tier: 'copilot',
  subscription_activated_at: new Date(ACTIVATED),
};

/**
 * A tagged-template stand-in for the Postgres.js client. Dispatches by the SQL
 * text so the assertions can also inspect what was actually issued (ORDER BY,
 * OFFSET, the absence of a second row-producing query after F3).
 */
function fakeSql(rows: FakeRows): { sql: Sql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (/AS\s+review_id/i.test(text)) return Promise.resolve(rows.main ?? []);
    if (/AVG\(/i.test(text)) return Promise.resolve([{ avg: rows.avg ?? null }]);
    if (/COUNT\(\*\)/i.test(text) && /NOT\s+EXISTS/i.test(text)) {
      return Promise.resolve([{ count: rows.unansweredTotal ?? 0 }]);
    }
    if (/COUNT\(\*\)/i.test(text)) return Promise.resolve([{ count: rows.answeredTotal ?? 0 }]);
    if (/FROM\s+businesses/i.test(text)) return Promise.resolve(rows.biz ?? [DEFAULT_BIZ]);
    return Promise.resolve([]);
  };
  return { sql: tagged as unknown as Sql, calls };
}

/** One row of the single post-F3 row source (Task 4 Step 1). */
function listRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_id: 'rev-1',
    review_text: 'Lovely sourdough',
    review_date: new Date('2026-04-01T12:00:00.000Z'),
    review_content_hash: 'hash-1',
    external_reply_ingested_at: null,
    star_rating: 5,
    reviewer_name: 'Sam',
    // Answered iff response_id is non-null (the posted LEFT JOIN).
    response_id: null,
    approved_text: null,
    approval_method: null,
    posted_at: null,
    version: null,
    failed_response_id: null,
    failed_posting_error: null,
    draft_response_id: null,
    draft_held: false,
    generation_in_flight: false,
    is_orphan: false,
    orphan_failed_response_id: null,
    orphan_posting_error: null,
    superseded_text: null,
    ...overrides,
  };
}

function answeredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return listRow({
    response_id: 'resp-1',
    approved_text: 'Thanks for visiting!',
    approval_method: APPROVAL_METHOD.OWNER,
    posted_at: new Date('2026-04-02T09:00:00.000Z'),
    version: 1,
    ...overrides,
  });
}

async function loadView(
  rows: FakeRows,
  page = 1,
  locationId = LOCATION_ID,
): Promise<{ view: ReviewsListView | null; calls: SqlCall[] }> {
  const { sql, calls } = fakeSql(rows);
  const raw = await loadPastRepliesPageView(sql, {
    accountId: ACCOUNT_ID,
    locationId,
    page,
  });
  return { view: raw as unknown as ReviewsListView | null, calls };
}

function mainQuery(calls: SqlCall[]): SqlCall {
  const found = calls.filter((call) => /AS\s+review_id/i.test(call.text));
  expect(found).toHaveLength(1); // F3: exactly ONE row source, no orphan sidecar query
  return found[0]!;
}

/**
 * The four shapes `fakeSql` actually resolves rows for, i.e. the discrimination
 * `mainQuery` does, widened to its three siblings.
 *
 * Query-count assertions must run through this rather than counting raw tagged
 * template calls (Q3). A tagged call can also be a FRAGMENT — a bound
 * `text[]` status array, for instance — which produces no rows; counting those
 * makes the assertion measure helper calls instead of queries, and that is what
 * dictates the production SQL's shape rather than its behaviour.
 */
const ROW_PRODUCING_QUERY_SHAPES = [
  /AS\s+review_id/i,
  /AVG\(/i,
  /COUNT\(\*\)/i,
  /FROM\s+businesses\s+b/i,
] as const;

function rowProducingQueries(calls: SqlCall[]): SqlCall[] {
  return calls.filter((call) =>
    ROW_PRODUCING_QUERY_SHAPES.some((shape) => shape.test(call.text)),
  );
}

function allRows(view: ReviewsListView): ListCardRow[] {
  return [...view.unansweredRows, ...view.answeredRows];
}

// ── loadPastRepliesPageView — the widened query ───────────────────────────────

describe('loadPastRepliesPageView (Reviews list)', () => {
  it('loadPastRepliesPageView returns never-replied reviews as unanswered rows', async () => {
    const { view } = await loadView({
      main: [listRow({ review_id: 'rev-never' })],
      unansweredTotal: 1,
      answeredTotal: 0,
    });

    expect(view).not.toBeNull();
    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-never']);
    expect(view!.answeredRows).toHaveLength(0);
    // A never-replied review is exactly what the Generate door exists for.
    expect(view!.unansweredRows[0]!.reply_state).toBe('none');
    expect(view!.unansweredRows[0]!.row_action).toBe('generate');
  });

  it('loadPastRepliesPageView orders unanswered rows before answered rows', async () => {
    // `false` sorts before `true` in Postgres, so `(resp.id IS NOT NULL)` leads
    // with the unanswered group (S6). Pin the ORDER BY as well as the grouping:
    // the grouping alone would still pass if the SQL sorted the other way and
    // the mapper re-sorted in JS, which would break as soon as pagination bites.
    const { view, calls } = await loadView({
      main: [
        answeredRow({ review_id: 'rev-answered', review_date: new Date('2026-05-01T00:00:00.000Z') }),
        listRow({ review_id: 'rev-unanswered', review_date: new Date('2026-01-01T00:00:00.000Z') }),
      ],
      unansweredTotal: 1,
      answeredTotal: 1,
    });

    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-unanswered']);
    expect(view!.answeredRows.map((row) => row.review_id)).toEqual(['rev-answered']);
    expect(mainQuery(calls).text).toMatch(/ORDER BY\s*\(\s*resp\.id IS NOT NULL\s*\)/i);
  });

  it('loadPastRepliesPageView orders newest-first within each group', async () => {
    const { view } = await loadView({
      main: [
        listRow({ review_id: 'un-old', review_date: new Date('2026-02-01T00:00:00.000Z') }),
        listRow({ review_id: 'un-new', review_date: new Date('2026-06-01T00:00:00.000Z') }),
        answeredRow({ review_id: 'ans-old', review_date: new Date('2026-01-01T00:00:00.000Z') }),
        answeredRow({ review_id: 'ans-new', review_date: new Date('2026-07-01T00:00:00.000Z') }),
      ],
      unansweredTotal: 2,
      answeredTotal: 2,
    });

    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['un-new', 'un-old']);
    expect(view!.answeredRows.map((row) => row.review_id)).toEqual(['ans-new', 'ans-old']);
  });

  it('loadPastRepliesPageView paginates over all reviews, not only replied ones', async () => {
    // 120 unanswered + 30 answered = 150 reviews → 3 pages at PAGE_SIZE 50.
    // Pre-#678 the denominator was posted-only (30 → 1 page) and the tail of a
    // fresh Review import was unreachable.
    const { view, calls } = await loadView({
      main: [listRow()],
      unansweredTotal: 120,
      answeredTotal: 30,
    }, 3);

    expect(view!.totalPages).toBe(Math.ceil(150 / PAGE_SIZE));
    expect(view!.unansweredTotal).toBe(120);
    expect(view!.answeredTotal).toBe(30);
    // Page 3 → OFFSET 2 * PAGE_SIZE. Asserted on page THREE, not page two: the
    // `LIMIT ${PAGE_SIZE}` bind alone satisfies `toContain(PAGE_SIZE)`, so the
    // page-2 form passed even with the OFFSET dropped entirely. 2 * PAGE_SIZE
    // is a value the LIMIT cannot supply, so this pins the OFFSET distinctly.
    expect(mainQuery(calls).values).toContain(2 * PAGE_SIZE);
    expect(view!.page).toBe(3);
  });

  it('loadPastRepliesPageView marks a review with a non-terminal response as draft-ready and never generatable', async () => {
    const { view } = await loadView({
      main: [listRow({ review_id: 'rev-draft', draft_response_id: 'resp-draft', draft_held: false })],
      unansweredTotal: 1,
      answeredTotal: 0,
    });

    // No posted sibling → grouped Unanswered, but it must never offer Generate:
    // the partial unique index (023+026+029) permits at most ONE non-terminal
    // response per review, so a second draft could not persist anyway (S2).
    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-draft']);
    expect(view!.unansweredRows[0]!.reply_state).toBe('none');
    expect(view!.unansweredRows[0]!.row_action).toBe('draft_ready');
    expect(view!.unansweredRows[0]!.row_action).not.toBe('generate');
  });

  it('loadPastRepliesPageView marks a review with an in-flight generate_response outbox row as generating', async () => {
    const { view, calls } = await loadView({
      main: [listRow({ review_id: 'rev-gen', generation_in_flight: true })],
      unansweredTotal: 1,
      answeredTotal: 0,
    });

    expect(view!.unansweredRows[0]!.row_action).toBe('generating');
    // The in-flight set is the byte-for-byte contract from job-outbox-status.ts
    // (invariant #2) — members AND order.
    expect(mainQuery(calls).text).toContain("'pending', 'dispatching', 'dispatched'");
  });

  it('loadPastRepliesPageView groups an orphan row under unanswered without a generate affordance', async () => {
    const { view } = await loadView({
      main: [listRow({
        review_id: 'rev-orphan',
        is_orphan: true,
        orphan_failed_response_id: 'fail-1',
        orphan_posting_error: 'post_after_delete_failed_http_400',
        superseded_text: 'The reply we could not repost',
      })],
      unansweredTotal: 1,
      answeredTotal: 0,
    });

    // D-G: an orphan has no live Google reply (so `Unanswered` is honest) but
    // DOES have a superseded draft — offering Generate would race /retry and
    // /restore-original.
    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-orphan']);
    expect(view!.unansweredRows[0]!.reply_state).toBe('orphan');
    expect(view!.unansweredRows[0]!.row_action).toBe('recover');
    expect(view!.answeredRows).toHaveLength(0);
  });

  it('loadPastRepliesPageView scopes every row and count to the requested business_id', async () => {
    const { calls } = await loadView({
      main: [listRow()],
      unansweredTotal: 1,
      answeredTotal: 1,
    }, 1, OTHER_LOCATION_ID);

    // Invariant #8: every query in the page load is tenant-scoped. The biz
    // lookup additionally asserts account ownership.
    const dataQueries = rowProducingQueries(calls).filter(
      (call) => !/FROM\s+businesses\s+b/i.test(call.text),
    );
    // Exactly FOUR ROW-PRODUCING queries: the single row source, the two group
    // COUNTs, and the average. Pre-#678 there were five (the separate orphan
    // query, deleted by F3) and the counts were the activation-split
    // gap/historical pair, which S3 replaces with per-row provenance badges.
    // Counted through rowProducingQueries so a bound fragment (e.g. a status
    // `text[]`) never inflates the number and dictates the production SQL (Q3).
    expect(dataQueries).toHaveLength(4);
    for (const call of dataQueries) {
      expect(call.text).toMatch(/business_id\s*=/i);
      expect(call.values).toContain(OTHER_LOCATION_ID);
      // No query still splits on subscription_activated_at.
      expect(call.text).not.toMatch(/timestamptz/i);
    }
    const bizLookup = calls.find((call) => /FROM\s+businesses\s+b/i.test(call.text));
    expect(bizLookup!.values).toContain(ACCOUNT_ID);
  });

  it('loadPastRepliesPageView averages star rating over all reviews, not only replied ones', async () => {
    const { view, calls } = await loadView({
      main: [listRow()],
      unansweredTotal: 3,
      answeredTotal: 1,
      avg: 4.25,
    });

    expect(view!.avgStarRating).toBe(4.25);
    const avgQuery = calls.find((call) => /AVG\(/i.test(call.text))!;
    // No posted-only JOIN: the denominator is every review for the location.
    expect(avgQuery.text).not.toMatch(/JOIN\s+responses/i);
    expect(avgQuery.text).not.toContain("'posted'");
  });

  it('loadPastRepliesPageView returns each orphan review exactly once as recover and never as generate', async () => {
    // F3: before the single-query merge, an orphan review matched BOTH the
    // (now LEFT-joined) main query and the separate un-offset orphan query, so
    // it rendered twice — once as `generate`, once as `recover` — on every page.
    const { view, calls } = await loadView({
      main: [
        listRow({
          review_id: 'rev-orphan',
          is_orphan: true,
          orphan_failed_response_id: 'fail-9',
          orphan_posting_error: 'post_after_delete_failed_timeout',
          superseded_text: 'original',
        }),
        listRow({ review_id: 'rev-plain' }),
      ],
      unansweredTotal: 2,
      answeredTotal: 0,
    });

    const orphanOccurrences = allRows(view!).filter((row) => row.review_id === 'rev-orphan');
    expect(orphanOccurrences).toHaveLength(1);
    expect(orphanOccurrences[0]!.row_action).toBe('recover');
    expect(orphanOccurrences[0]!.row_action).not.toBe('generate');
    // …and the separate orphan query is gone (mainQuery asserts exactly one).
    mainQuery(calls);
  });

  it('consecutive Reviews-list pages are disjoint and each contains at most PAGE_SIZE unique reviews, including orphan recovery rows', async () => {
    const pageOne = Array.from({ length: PAGE_SIZE }, (_unused, index) =>
      listRow({
        review_id: `p1-${index}`,
        is_orphan: index === 0,
        orphan_failed_response_id: index === 0 ? 'fail-p1' : null,
        orphan_posting_error: index === 0 ? 'post_after_delete_failed_http_400' : null,
        review_date: new Date(Date.UTC(2026, 5, 1) - index * 86_400_000),
      }),
    );
    const pageTwo = Array.from({ length: 10 }, (_unused, index) =>
      listRow({ review_id: `p2-${index}`, review_date: new Date(Date.UTC(2026, 3, 1) - index * 86_400_000) }),
    );

    const first = await loadView({ main: pageOne, unansweredTotal: 60, answeredTotal: 0 }, 1);
    const second = await loadView({ main: pageTwo, unansweredTotal: 60, answeredTotal: 0 }, 2);

    const firstIds = allRows(first.view!).map((row) => row.review_id);
    const secondIds = allRows(second.view!).map((row) => row.review_id);

    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(new Set(secondIds).size).toBe(secondIds.length);
    expect(firstIds.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(secondIds.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);

    // Orphans are now INSIDE the LIMIT/OFFSET window rather than merged
    // un-offset into every page (F3 / Task 4 Step 2a). The OFFSET is pinned
    // POSITIONALLY — it is the last of the trailing `LIMIT ${PAGE_SIZE} OFFSET
    // ${offset}` binds — rather than by membership: on page 2 the OFFSET equals
    // PAGE_SIZE, so `toContain(PAGE_SIZE)` is satisfied by the LIMIT bind alone
    // and passes even with the OFFSET dropped entirely.
    const firstBinds = mainQuery(first.calls).values;
    const secondBinds = mainQuery(second.calls).values;
    expect(firstBinds.at(-2)).toBe(PAGE_SIZE);
    expect(firstBinds.at(-1)).toBe(0);
    expect(secondBinds.at(-2)).toBe(PAGE_SIZE);
    expect(secondBinds.at(-1)).toBe(PAGE_SIZE);
  });

  it('Reviews-list pagination uses review_id as a deterministic tie-breaker when review dates are equal', async () => {
    // F7: without `, r.id DESC` two reviews sharing a review_date can swap
    // between pages, so a row is shown twice and another never at all.
    const sameInstant = new Date('2026-05-05T10:00:00.000Z');
    const { view, calls } = await loadView({
      main: [
        listRow({ review_id: 'rev-b', review_date: sameInstant }),
        listRow({ review_id: 'rev-a', review_date: sameInstant }),
      ],
      unansweredTotal: 2,
      answeredTotal: 0,
    });

    expect(mainQuery(calls).text).toMatch(/ORDER BY[\s\S]*r\.review_date DESC\s*,\s*r\.id DESC/i);
    expect(allRows(view!)).toHaveLength(2);
  });

  it('an orphan row keeps its failed_response_id and superseded text after the single-query merge', async () => {
    // Round-2 Defect A. `PastReplyCard` renders the recovery badge from the
    // server-derived `recover` state (PastReplyCard.tsx:314) and gates the
    // recovery ACTIONS on `row.failed_response_id` (:388, :442). The deleted
    // `toOrphanCardRow` fed both from the orphan query's columns; post-F3
    // they must come from the orphan_sidecar / orphan_superseded LATERALs.
    const { view } = await loadView({
      main: [listRow({
        review_id: 'rev-orphan',
        is_orphan: true,
        orphan_failed_response_id: 'fail-42',
        orphan_posting_error: 'post_after_delete_failed_retry_exhausted',
        superseded_text: 'The reply the owner approved before the failed edit',
      })],
      unansweredTotal: 1,
      answeredTotal: 0,
    });

    const row = view!.unansweredRows[0]!;
    expect(row.failed_response_id).toBe('fail-42');
    // The old mapper set BOTH — /retry and /restore-original address the failed
    // response by id.
    expect(row.response_id).toBe('fail-42');
    expect(row.failed_posting_error).toBe('post_after_delete_failed_retry_exhausted');
    expect(row.approved_text).toBe('The reply the owner approved before the failed edit');
    // An orphan has no live posted reply, so posted_at must be null on the wire.
    expect(row.posted_at).toBeNull();
    expect(row.version).toBeNull();
  });
});

// ── provenanceBadge (D-E) ─────────────────────────────────────────────────────

describe('provenanceBadge', () => {
  it('provenanceBadge returns posted-before-joining for an ingested reply predating activation', () => {
    expect(
      provenanceBadge(
        {
          external_reply_ingested_at: '2026-03-05T00:00:00.000Z',
          approval_method: null,
          review_date: '2026-01-15T00:00:00.000Z',
        },
        ACTIVATED,
      ),
    ).toBe('posted_before_joining');
  });

  it('provenanceBadge returns replied-on-google for an ingested reply dated after activation', () => {
    // The owner replied in Google's own UI while subscribed — a different fact
    // from "we imported your history", and the fourth badge D-E widened S3 with.
    expect(
      provenanceBadge(
        {
          external_reply_ingested_at: '2026-04-10T00:00:00.000Z',
          approval_method: null,
          review_date: '2026-04-01T00:00:00.000Z',
        },
        ACTIVATED,
      ),
    ).toBe('replied_on_google');
  });

  it('provenanceBadge returns auto-approved for an auto_policy reply', () => {
    expect(
      provenanceBadge(
        {
          external_reply_ingested_at: null,
          approval_method: APPROVAL_METHOD.AUTO_POLICY,
          review_date: '2026-04-01T00:00:00.000Z',
        },
        ACTIVATED,
      ),
    ).toBe('auto_approved');
  });

  it('provenanceBadge returns owner-approved for an owner-approved reply', () => {
    expect(
      provenanceBadge(
        {
          external_reply_ingested_at: null,
          approval_method: APPROVAL_METHOD.OWNER,
          review_date: '2026-04-01T00:00:00.000Z',
        },
        ACTIVATED,
      ),
    ).toBe('owner_approved');
  });
});

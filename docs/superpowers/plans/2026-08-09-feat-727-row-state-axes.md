# #727 Row-State Axes + Action Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #723's locked axes + action projection for the Reviews
list — `reply_state` + `row_action` on the wire, `draft_state` server-internal —
so an answered review with a moderation-held replacement draft stops rendering
the ordinary Regenerate control (invariant #4 as a structural property).

**Architecture:** Deepen the existing `src/lib/past-replies/replies-view.ts`
module: replace the six-valued `deriveRowState` collapse with `deriveAxes`
(facts → the two orthogonal axes) + `deriveRowAction` (total projection over the
3×4 cross-product). The wire shape swaps `row_state` for two typed fields;
`PastReplyCard.ReplySide` stays a pure adapter switching on `row_action` with a
`never`-typed default. No new seams, no DB changes — the query already selects
both facts.

**Tech Stack:** TypeScript, React (client component), vitest + fast-check +
@testing-library/react, Postgres.js (live-DB integration suite).

**Authoritative inputs:** intake
`docs/superpowers/plans/feat-727-row-state-axes-intake.json` · locked decision:
#723 resolution comment (cross-product table) · prototype (never merges):
branch `prototype/723-row-state-axes`,
`src/lib/past-replies/prototype-723-row-state-axes.ts` · deviations log:
`docs/superpowers/plans/feat-727-row-state-axes-deviations.md` (orphan×held
refinement + ADR number 0018 + round-1 review deltas).

**The locked derivation (single source for every task):**

| cell (reply×draft) | group | reply panel | `row_action` |
|---|---|---|---|
| none×none | Unanswered | review only | `generate` |
| none×generating | Unanswered | review only | `generating` |
| none×ready | Unanswered | review only | `draft_ready` |
| none×held | Unanswered | review only + "Reply on hold" panel | `none` |
| posted×none | Answered | live reply + badge | `regenerate` |
| posted×generating | Answered | live reply + badge | `regenerate` |
| posted×ready | Answered | live reply + badge | `regenerate` |
| **posted×held** | Answered | **live reply + badge (stays visible)** | **`none` (silent — the one behavioural delta)** |
| orphan×none | Unanswered | superseded text + error | `recover` |
| orphan×generating | Unanswered | superseded text + error | `recover` |
| orphan×ready | Unanswered | superseded text + error | `recover` |
| orphan×held | Unanswered | superseded text + error | `recover` (recovery addresses the incident, not the draft) |

**File map:**

- `src/lib/past-replies/replies-view.ts` — the model (T1 skeleton → T2 real →
  T3 deletes the old enum)
- `src/lib/past-replies/load-replies.ts` — comment sweep only (T3)
- `src/components/dashboard/reviews/PastReplyCard.tsx` — wire type (T2), render
  (T3)
- `src/components/dashboard/reviews/InlineGeneratePanel.tsx`,
  `useInlineGenerate.ts` — comment sweep (T3)
- Tests: `src/lib/past-replies/__tests__/replies-view.test.ts` (T1/T2/T3),
  `reviews-list.test.ts` (T3), `load-replies.integration.test.ts` (T1 todo →
  T2 body), `src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx`
  (T1 todos → T3 bodies), `src/components/dashboard/__tests__/PastReplyCard.test.tsx`,
  `src/app/(authenticated)/dashboard/reviews/history/__tests__/PastRepliesClient.test.tsx`,
  `src/components/dashboard/reviews/edit-reply/__tests__/useEditReplyDraft.test.tsx`,
  `src/components/dashboard/reviews/__tests__/useInlineGenerate.test.tsx`
  (T2 add-only fixture sweep; T3 delete sweep)
- `CONTEXT.md`, `docs/adr/0018-row-state-axes-projection.md` (T4)

**Task order:** T1 alone first (enforcement spot check), then T2, then T3 ∥ T4
(disjoint file sets, both blocked on T2). Every commit typechecks; the suite is
fully green after T3.

---

### Task 1: EVAL — the spec as failing tests + compiling skeletons

**Files:**
- Modify: `src/lib/past-replies/replies-view.ts` (types + throwing skeletons ONLY)
- Modify: `src/lib/past-replies/__tests__/replies-view.test.ts`
- Modify: `src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx`
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`

- [ ] **Step 1: Add the axis types and throwing skeletons to `replies-view.ts`**

Append after the existing `deriveRowState` (do NOT touch it yet — it stays the
live derivation until Task 3):

```ts
/**
 * Axis A — the Posted-reply axis (#723/#727): what exists on Google for this
 * review. Owns the Unanswered/Answered grouping and the reply panel.
 */
export type ReplyState = 'none' | 'posted' | 'orphan';

/**
 * Axis B — the Replacement-draft axis: where the replacement workflow stands.
 * SERVER-INTERNAL — it never crosses the wire (invariant #4 as structure: the
 * client cannot leak what it never receives). Intra-axis precedence: a settled
 * response row outranks an in-flight outbox row (held > ready > generating >
 * none), same rationale as the pre-#727 single enum.
 */
export type DraftState = 'none' | 'generating' | 'ready' | 'held';

/**
 * The Action slot — the single affordance the card renders, derived from the
 * full 3×4 cross-product. A held draft never projects an affordance of its
 * own: none/posted×held → 'none'; orphan×held keeps 'recover' because the
 * affordance addresses the orphan incident, not the draft (#723 table).
 */
export type RowAction =
  | 'generate'
  | 'generating'
  | 'draft_ready'
  | 'regenerate'
  | 'recover'
  | 'none';

/** Same facts as deriveRowState → the two axes. Implemented in #727 Task 2. */
export function deriveAxes(r: {
  response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}): { reply: ReplyState; draft: DraftState } {
  throw new Error(`unimplemented (#727 Task 2): ${JSON.stringify(r)}`);
}

/** (reply, draft) → the Action slot. Total over all 12 cells. #727 Task 2. */
export function deriveRowAction(reply: ReplyState, draft: DraftState): RowAction {
  throw new Error(`unimplemented (#727 Task 2): ${reply}×${draft}`);
}
```

- [ ] **Step 2: Add the model tests to `replies-view.test.ts`**

Add `import fc from 'fast-check';` (match the import style of
`src/lib/reviews/__tests__/sentiment.test.ts`), extend the existing
`../replies-view` import with `deriveAxes, deriveRowAction`, and append the
shared cell vocabulary + a facts builder (mirrors the prototype's `factsFor` —
the derivation-facts half of a `ReviewRow`; combine with the file's existing
`ReviewRow` fixture builder for wire-level tests):

```ts
const REPLY_STATES = ['none', 'posted', 'orphan'] as const;
const DRAFT_STATES = ['none', 'generating', 'ready', 'held'] as const;
const ROW_ACTIONS = [
  'generate', 'generating', 'draft_ready', 'regenerate', 'recover', 'none',
] as const;
// Every action that would surface or spend a draft. 'recover' is deliberately
// absent: it addresses the orphan incident, not the draft (#723 table).
const DRAFT_AFFORDANCES = ['generate', 'generating', 'draft_ready', 'regenerate'] as const;

/** Derivation facts that produce exactly the (reply, draft) cell. */
function factsFor(reply: ReplyState, draft: DraftState) {
  return {
    response_id: reply === 'posted' ? 'resp-1' : null,
    is_orphan: reply === 'orphan',
    draft_response_id: draft === 'ready' || draft === 'held' ? 'draft-1' : null,
    draft_held: draft === 'held',
    generation_in_flight: draft === 'generating',
  };
}
```

Then the model describes:

```ts
describe('the two-axis model invariants (#727)', () => {
  const anyReply = fc.constantFrom(...REPLY_STATES);
  const anyDraft = fc.constantFrom(...DRAFT_STATES);

  it('never offers a draft affordance for a held draft in any reply state (invariant #4)', () => {
    fc.assert(
      fc.property(anyReply, (reply) => {
        const action = deriveRowAction(reply, 'held');
        expect(DRAFT_AFFORDANCES).not.toContain(action);
        expect(action).toBe(reply === 'orphan' ? 'recover' : 'none');
      }),
    );
  });

  it('derives a defined action for every cell of the 3x4 cross-product', () => {
    fc.assert(
      fc.property(anyReply, anyDraft, (reply, draft) => {
        expect(ROW_ACTIONS).toContain(deriveRowAction(reply, draft));
      }),
    );
  });
});

describe('deriveAxes (#727)', () => {
  it('maps every cell of the 3x4 cross-product onto the two axes', () => {
    for (const reply of REPLY_STATES) {
      for (const draft of DRAFT_STATES) {
        expect(deriveAxes(factsFor(reply, draft))).toEqual({ reply, draft });
      }
    }
  });

  it('a settled ready or held response outranks an in-flight generation', () => {
    // draft_response_id + generation_in_flight can coexist (the outbox row has
    // not been reaped yet) — the settled response row is the fact that wins.
    expect(deriveAxes({ ...factsFor('none', 'ready'), generation_in_flight: true }).draft).toBe('ready');
    expect(deriveAxes({ ...factsFor('none', 'held'), generation_in_flight: true }).draft).toBe('held');
    expect(deriveAxes({ ...factsFor('posted', 'held'), generation_in_flight: true }).draft).toBe('held');
    expect(deriveAxes({ ...factsFor('orphan', 'ready'), generation_in_flight: true }).draft).toBe('ready');
  });
});

describe('deriveRowAction cells (#727)', () => {
  it('withdraws Regenerate from an answered row whose replacement draft is moderation-held (posted x held)', () => {
    expect(deriveRowAction('posted', 'held')).toBe('none');
  });

  it('keeps Regenerate for an answered row with a pending or in-flight replacement (posted x ready, posted x generating)', () => {
    expect(deriveRowAction('posted', 'none')).toBe('regenerate');
    expect(deriveRowAction('posted', 'ready')).toBe('regenerate');
    expect(deriveRowAction('posted', 'generating')).toBe('regenerate');
  });

  it('dominates recovery over every draft state on an orphan row', () => {
    for (const draft of DRAFT_STATES) {
      expect(deriveRowAction('orphan', draft)).toBe('recover');
    }
  });
});
```

Then the two wire-level pins, reusing the file's existing `ReviewRow` fixture
builder (adapt `build(...)` to its actual name/defaults; orphan cells also need
`orphan_failed_response_id` set so `toCardRow`'s recovery mapping holds):

```ts
it('groups by the posted-reply axis — the Answered set is exactly the rows with a live posted reply', () => {
  // ALL 12 cells, so a predicate that wrongly ejects posted×generating or
  // posted×ready from Answered — or admits a none/orphan cell — fails here.
  const rows = REPLY_STATES.flatMap((reply) =>
    DRAFT_STATES.map((draft) =>
      build({
        review_id: `r-${reply}-${draft}`,
        ...factsFor(reply, draft),
        orphan_failed_response_id: reply === 'orphan' ? 'f-1' : null,
      }),
    ),
  );
  const { unansweredRows, answeredRows } = groupReplies(rows, null, true);
  expect(answeredRows.map((r) => r.review_id).sort()).toEqual(
    DRAFT_STATES.map((d) => `r-posted-${d}`).sort(),
  );
  expect(unansweredRows).toHaveLength(8);
  expect(answeredRows.length + unansweredRows.length).toBe(12);
});

it('never carries draft state or held onto the wire shape', () => {
  const LIVE_TEXT = 'live posted reply text';
  const card = toCardRow(
    build({
      response_id: 'resp-1',
      approved_text: LIVE_TEXT,
      draft_response_id: 'd-1',
      draft_held: true,
    }),
    null,
    true,
  );
  // EXACT allowlist, not a blacklist: any new wire key — an alias like
  // `has_held_draft`, a nested draft object — fails until deliberately added
  // here. RED until Task 3 (row_state is still emitted today, and the old
  // enum put the literal 'held' on the wire for none×held).
  expect(Object.keys(card).sort()).toEqual(
    [
      'approval_method', 'approved_text', 'canEdit', 'external_reply_ingested_at',
      'failed_posting_error', 'failed_response_id', 'posted_at',
      'provenance_badge', 'reply_state', 'response_id', 'review_content_hash',
      'review_date', 'review_id', 'review_text', 'reviewer_name', 'row_action',
      'star_rating', 'version',
    ],
  );
  // The value surface: the LIVE reply is what crosses. (The held draft's TEXT
  // structurally cannot appear here — ReviewRow never selects it; the
  // serialized-value pin lives in the integration suite where the text exists.)
  expect(card.approved_text).toBe(LIVE_TEXT);
});
```

- [ ] **Step 3: Add the card-level and integration todos (titles verbatim from the intake)**

In `past-reply-card-states.test.tsx`, inside the existing
`describe('PastReplyCard row states')`:

```ts
it.todo('keeps the live posted reply and provenance badge visible for an answered row with a held replacement draft');
it.todo('renders no Regenerate button, no counter, and no held indication for an answered row with a held replacement draft');
it.todo('renders the live posted reply with Regenerate for an answered row without a held replacement draft');
it.todo('renders the held panel with no draft text and no affordance for an unanswered review with a held draft');
it.todo('renders the locked presentation for every cell of the 3x4 cross-product');
it.todo('keeps the delete-failed recovery control while withdrawing Regenerate for an answered row with a held replacement draft');
```

In `load-replies.integration.test.ts`, inside the `describeWithDb` block:

```ts
it.todo('returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held');
it.todo('distinguishes an open-held replacement from unflagged and closed replacements');
```

- [ ] **Step 4: Run and verify the red state**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
Expected: the seven `deriveAxes`/`deriveRowAction` tests FAIL with
`unimplemented (#727 Task 2)`; the grouping pin PASSES (regression pin — the
row set is unchanged by design); `never carries draft state or held onto the
wire shape` FAILS on `row_state` in the allowlist; all pre-existing tests PASS.

Run: `pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/past-replies src/components/dashboard/reviews/__tests__
git commit -m "test(#727): eval — two-axis model spec as failing tests + skeletons"
```

---

### Task 2: The model — axes, projection, wire fields (server slice)

**Files:**
- Modify: `src/lib/past-replies/replies-view.ts`
- Modify: `src/components/dashboard/reviews/PastReplyCard.tsx` (`PastReplyRow` type only)
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
- Modify (add-only fixture sweep): `past-reply-card-states.test.tsx`,
  `PastReplyCard.test.tsx`, `PastRepliesClient.test.tsx`,
  `useEditReplyDraft.test.tsx`, `reviews-list.test.ts`, `replies-view.test.ts`

- [ ] **Step 1: Implement `deriveAxes` and `deriveRowAction`**

Replace the two throwing bodies:

```ts
export function deriveAxes(r: {
  response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}): { reply: ReplyState; draft: DraftState } {
  // is_orphan already encodes resp.id IS NULL (load-replies, F3), so
  // orphan/posted exclusivity holds by construction of the row source.
  const reply: ReplyState = r.is_orphan ? 'orphan' : r.response_id !== null ? 'posted' : 'none';
  const draft: DraftState =
    r.draft_response_id !== null
      ? r.draft_held
        ? 'held'
        : 'ready'
      : r.generation_in_flight
        ? 'generating'
        : 'none';
  return { reply, draft };
}

export function deriveRowAction(reply: ReplyState, draft: DraftState): RowAction {
  switch (reply) {
    case 'orphan':
      // Recovery dominates EVERY draft state (#723 locked call): the
      // affordance addresses the orphan incident, never the draft — a held
      // draft stays invisible, and #726 owns the server-side hold checks the
      // recovery drawer could reach.
      return 'recover';
    case 'posted':
      // held withdraws the drawer (invariant #4); a pending or in-flight
      // replacement keeps Regenerate — the drawer itself resumes it.
      return draft === 'held' ? 'none' : 'regenerate';
    case 'none':
      switch (draft) {
        case 'none':
          return 'generate';
        case 'generating':
          return 'generating';
        case 'ready':
          return 'draft_ready';
        case 'held':
          // Invariant #4: no text, no affordance. The card reconstructs the
          // "Reply on hold" panel from (none, none) — held never crosses the wire.
          return 'none';
      }
  }
}
```

(No `default` branches — TypeScript's exhaustiveness over the narrowed unions
is the totality proof; `noImplicitReturns` fails the build if a cell goes
missing.)

- [ ] **Step 2: Put the two fields on the wire**

In `PastReplyCard.tsx`, extend the `PastReplyRow` interface (keep `row_state`
for now — Task 3 deletes it) and the type-only import:

```ts
import type { ProvenanceBadge, ReplyState, ReviewRowState, RowAction } from '@/lib/past-replies/replies-view';
```

```ts
  /**
   * The Posted-reply axis (#727): what exists on Google. Owns the
   * Unanswered/Answered grouping and which reply panel renders. Typed as the
   * exported union end-to-end — the wire boundary carries the contract.
   */
  reply_state: ReplyState;
  /**
   * The Action slot (#727): the single affordance this card renders, derived
   * server-side from the full (reply_state × draft_state) cross-product. The
   * Replacement-draft axis itself NEVER crosses the wire (invariant #4): a
   * held replacement projects to 'none' here, so this component cannot leak
   * what it never receives.
   */
  row_action: RowAction;
```

In `replies-view.ts`, update `toCardRow` to derive and emit both (the
`row_state` line stays until Task 3):

```ts
  const { reply, draft } = deriveAxes(r);
  const rowState = deriveRowState(r); // transitional — deleted in #727 Task 3
  const isOrphan = reply === 'orphan';
```

and in the returned object add, next to `row_state: rowState,`:

```ts
    reply_state: reply,
    row_action: deriveRowAction(reply, draft),
```

- [ ] **Step 3: Add-only fixture sweep (typecheck stays green THIS task)**

The two new fields are REQUIRED, so every literal constructing
`PastReplyRow`/`ReviewsListRow` now fails typecheck until it carries them. Run
`pnpm typecheck` and fix every error by ADDING the pair per this table —
`row_state` stays untouched (Task 3 deletes it):

| existing `row_state` | add `reply_state` | add `row_action` |
|---|---|---|
| `'generate'` | `'none'` | `'generate'` |
| `'generating'` | `'none'` | `'generating'` |
| `'draft_ready'` | `'none'` | `'draft_ready'` |
| `'held'` | `'none'` | `'none'` |
| `'regenerate'` | `'posted'` | `'regenerate'` |
| `'recover'` | `'orphan'` | `'recover'` |

Known files: `past-reply-card-states.test.tsx`, `PastReplyCard.test.tsx`,
`PastRepliesClient.test.tsx`, `useEditReplyDraft.test.tsx:25`, plus any mocked
view rows in `reviews-list.test.ts` typed as `ReviewsListRow`. The typechecker
enumerates the definitive list.

- [ ] **Step 4: Flip the grouping predicate to the Posted-reply axis**

In `groupReplies`, replace the two filters:

```ts
    unansweredRows: cards.filter((c) => c.reply_state !== 'posted').sort(sortByDateDesc),
    answeredRows: cards.filter((c) => c.reply_state === 'posted').sort(sortByDateDesc),
```

and update the doc comment's "the predicate is the row state" sentence to:
"The predicate is the Posted-reply axis: `posted` is the only state with a live
reply on Google, so everything else — including orphan `recover` rows (D-G) and
held rows — groups under Unanswered. The row set is identical to the pre-#727
`regenerate` grouping (pinned by test)."

- [ ] **Step 5: Run the model tests green**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
Expected: everything PASSES except `never carries draft state or held onto the
wire shape` (still red — the allowlist rejects `row_state`, which Task 3
deletes; leave it red).

Run: `pnpm typecheck` — Expected: PASS.

- [ ] **Step 6: Fill the two integration-test bodies**

In `load-replies.integration.test.ts`: the suite's local `ReviewsListView`
interface swaps `row_state: string` for `reply_state: string; row_action:
string` on both row arrays. Add fixture ids next to the existing ones:

```ts
const REVIEW_HELD_REPLACEMENT = randomUUID();
const RESPONSE_HELD_POSTED = randomUUID();
const RESPONSE_HELD_DRAFT = randomUUID();
const REVIEW_READY_CONTROL = randomUUID();
const RESPONSE_READY_POSTED = randomUUID();
const RESPONSE_READY_DRAFT = randomUUID();
const REVIEW_CLOSED_CONTROL = randomUUID();
const RESPONSE_CLOSED_POSTED = randomUUID();
const RESPONSE_CLOSED_DRAFT = randomUUID();
const HELD_DRAFT_TEXT = 'held replacement draft SECRET sentinel';
```

Add seed helpers. Column notes: `flagged_responses.api_cost_id` is nullable
(migration 051) and deliberately omitted; the status values are spelled as the
literals `'open'` / a non-open disposition — `src/lib/moderation/held-draft.ts`
is the semantic owner of the open-flag predicate and the loader's LATERAL
spells `f.status = 'open'` inline the same way (D6); verify the exact non-open
disposition value against the `flagged_responses` status CHECK in the schema
(migrations 050/051) before finalizing:

```ts
async function seedReplacementDraft(
  reviewId: string,
  draftId: string,
  responseText: string,
): Promise<void> {
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      response_language, version, status
    ) VALUES (
      ${draftId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      ${responseText}, ${responseText}, 'en', 2, 'pending_approval'
    )
  `;
}

async function seedFlag(reviewId: string, draftId: string, status: string): Promise<void> {
  await sql()`
    INSERT INTO flagged_responses (
      id, response_id, account_id, business_id, review_id,
      source, reason, severity, status
    ) VALUES (
      ${randomUUID()}::uuid, ${draftId}::uuid, ${tenant!.accountId}::uuid,
      ${businessId}::uuid, ${reviewId}::uuid,
      'local_regex', 'reviews-list integration fixture hold', 'high', ${status}
    )
  `;
}
```

In `beforeAll`, after the existing seeds (all three controls rate 3 so the
existing `avgStarRating` assertion stays 3 — (5+4+2+1+3+3+3)/7; dates sort them
after the existing answered rows):

```ts
await seedReview(REVIEW_HELD_REPLACEMENT, 3, '2026-02-01T00:00:00Z', REVIEW_STATUS.POSTED);
await seedPostedResponse(RESPONSE_HELD_POSTED, REVIEW_HELD_REPLACEMENT);
await seedReplacementDraft(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, HELD_DRAFT_TEXT);
await seedFlag(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, 'open');

// Negative control 1: identical shape, NO flag → the draft is ready, not held.
await seedReview(REVIEW_READY_CONTROL, 3, '2026-01-15T00:00:00Z', REVIEW_STATUS.POSTED);
await seedPostedResponse(RESPONSE_READY_POSTED, REVIEW_READY_CONTROL);
await seedReplacementDraft(REVIEW_READY_CONTROL, RESPONSE_READY_DRAFT, 'ready replacement draft');

// Negative control 2: identical shape, flag exists but is NOT open.
await seedReview(REVIEW_CLOSED_CONTROL, 3, '2026-01-10T00:00:00Z', REVIEW_STATUS.POSTED);
await seedPostedResponse(RESPONSE_CLOSED_POSTED, REVIEW_CLOSED_CONTROL);
await seedReplacementDraft(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, 'closed-flag replacement draft');
await seedFlag(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, '<non-open disposition from schema>');
```

Update the existing test's now-changed denominators and tails: `answeredRows`
id array becomes `[REVIEW_ANSWERED_NEW, REVIEW_ANSWERED_OLD,
REVIEW_HELD_REPLACEMENT, REVIEW_READY_CONTROL, REVIEW_CLOSED_CONTROL]`,
`answeredTotal` 5, `totalPages` over 7, `avgStarRating` stays 3, and the final
row-state assertions become:

```ts
expect(view!.unansweredRows.every((row) => row.row_action === 'generate')).toBe(true);
expect(view!.answeredRows.map((row) => row.row_action)).toEqual([
  'regenerate', 'regenerate', 'none', 'regenerate', 'regenerate',
]);
```

Replace the two `it.todo`s with:

```ts
it('returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held', async () => {
  const view = (await loadPastRepliesPageView(sql(), {
    accountId: tenant!.accountId,
    locationId: businessId,
    page: 1,
  })) as unknown as ReviewsListView | null;

  const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
  // The posted-reply axis owns grouping: the row stays Answered.
  expect(heldRow).toBeDefined();
  expect(heldRow!.reply_state).toBe('posted');
  // The action slot withdraws Regenerate (invariant #4, the #710-item-1 bug cell).
  expect(heldRow!.row_action).toBe('none');
  // The draft axis never crosses the wire — by key OR by value: the held
  // draft's text must not appear anywhere in the serialized page view.
  const keys = Object.keys(heldRow!);
  expect(keys).not.toContain('draft_held');
  expect(keys).not.toContain('draft_response_id');
  expect(JSON.stringify(view)).not.toContain(HELD_DRAFT_TEXT);
});

it('distinguishes an open-held replacement from unflagged and closed replacements', async () => {
  const view = (await loadPastRepliesPageView(sql(), {
    accountId: tenant!.accountId,
    locationId: businessId,
    page: 1,
  })) as unknown as ReviewsListView | null;

  const actionFor = (id: string) =>
    view!.answeredRows.find((row) => row.review_id === id)?.row_action;
  // Only the OPEN flag holds; an unflagged or closed-flag replacement keeps
  // Regenerate — the withdrawal tracks flagged_responses.status = 'open'
  // exactly (src/lib/moderation/held-draft.ts semantics).
  expect(actionFor(REVIEW_HELD_REPLACEMENT)).toBe('none');
  expect(actionFor(REVIEW_READY_CONTROL)).toBe('regenerate');
  expect(actionFor(REVIEW_CLOSED_CONTROL)).toBe('regenerate');
});
```

In `afterAll`, add `await sql()\`DELETE FROM flagged_responses WHERE
business_id = ${businessId}::uuid\`` BEFORE the responses DELETE (FK); the
existing business-scoped responses/reviews DELETEs already cover the new rows.

- [ ] **Step 7: Run the integration suite against the live DB**

Run: `TEST_DATABASE_POOL_URL=<from .env.local> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts`
Expected: PASS (all tests). If the DB container is behind migrations head the
suite fails loudly with the `pnpm test:db:setup` message — run that once and
retry; NEVER apply DDL from the suite.

- [ ] **Step 8: Run the whole affected area + typecheck, then commit**

Run: `pnpm vitest run src/lib/past-replies src/components/dashboard src/app && pnpm typecheck`
Expected: PASS except the deliberately-red wire-leak allowlist pin (Task 3).

```bash
git add -A src/
git commit -m "feat(#727): two-axis model + action projection on the wire (server slice)"
```

---

### Task 3: The render slice — card switches to the action slot; the old enum dies

**Files:**
- Modify: `src/components/dashboard/reviews/PastReplyCard.tsx`
- Modify: `src/lib/past-replies/replies-view.ts` (delete `ReviewRowState`,
  `deriveRowState`, `row_state`)
- Modify: `src/lib/past-replies/load-replies.ts` (comments only)
- Modify: `src/components/dashboard/reviews/InlineGeneratePanel.tsx`,
  `src/components/dashboard/reviews/useInlineGenerate.ts` (comments only)
- Modify (delete-only fixture sweep + new bodies): `replies-view.test.ts`,
  `reviews-list.test.ts`, `past-reply-card-states.test.tsx`,
  `PastReplyCard.test.tsx`, `PastRepliesClient.test.tsx`,
  `useEditReplyDraft.test.tsx`, `useInlineGenerate.test.tsx`

- [ ] **Step 1: Rewrite `ReplySide` to dispatch on the typed action slot**

Replace the whole function (drop the `const state = row.row_state as
ReviewRowState` cast — `row.row_action` is already the union). The
`'regenerate'`, `'recover'`, `'draft_ready'`, `'generating'`/`'generate'`
branches keep their existing JSX verbatim (only the switch discriminant
changes, and `resumeGenerating={row.row_action === 'generating'}`). The new
`'none'` case:

```tsx
    case 'none':
      // The withdrawn Action slot — only held cells project it (#727). WHICH
      // panel renders is owned by the Posted-reply axis.
      return row.reply_state === 'posted' ? (
        // posted×held: the live reply the owner is entitled to see stays
        // visible; the withdrawal is SILENT — no button, no counter, no lock,
        // no held indication (explaining it would be the notification
        // invariant #4 forbids: held, not notified). RecoveryControl
        // self-gates on a delete_failed sidecar and stays: recovery addresses
        // the failed response, not the held draft.
        <div className="pr-side pr-side-reply">
          <ReplyEyebrow />
          <ReplyBody row={row} query={query} />
          <Provenance row={row} isImported={isImported} />
          <RecoveryControl
            row={row}
            editRepliesEnabled={editRepliesEnabled}
            onRecoveryClick={onRecoveryClick}
          />
        </div>
      ) : (
        // none×held: today's held posture, reconstructed from the two wire
        // fields — the held value itself never crosses the wire (#723; owner
        // call 2026-08-09). No draft text, no affordance, no cross-link; the
        // owner's only path back is an admin disposition at /admin/flagged.
        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="shield" size={12} /> Reply on hold
          </div>
          <p className="pr-body italic">
            We are double-checking this draft before anything is posted.
          </p>
          <div className="pr-prov">
            <span className="pr-prov-badge pr-prov-held">
              <Icon name="clock" size={10} /> Under review
            </span>
          </div>
        </div>
      );
```

Delete the old `case 'held':` branch (its JSX moved above). Keep the
`never`-typed default (now over `RowAction`). Update the `ReplySide` doc
comment: six states → "the Action slot is the whole affordance contract; the
Posted-reply axis picks the panel where the slot is withdrawn". In
`Provenance`, replace `row.row_state === 'recover'` with
`row.reply_state === 'orphan'` (comment: the axis IS orphan-ness, server-derived).

- [ ] **Step 2: Delete the old enum from the model**

In `PastReplyCard.tsx`: delete the `row_state` member (and its doc comment)
from `PastReplyRow`; drop `ReviewRowState` from the type import. In
`replies-view.ts`: delete `ReviewRowState`, `deriveRowState`, the
`row_state: ReviewRowState;` member of `ReviewsListRow`, and the transitional
`const rowState`/`row_state: rowState,` lines in `toCardRow` (its `isOrphan`
already reads the axis). Move the precedence rationale from `deriveRowState`'s
doc comment into `deriveAxes`/`deriveRowAction` docs where still true.

- [ ] **Step 3: Delete-only fixture sweep + comment sweep for the dead name**

Delete every `row_state: '...'` property from test fixtures (the pairs were
added in Task 2; TypeScript excess-property errors enumerate the sites). Then
`rg -n "row_state|deriveRowState|ReviewRowState" src/` must return NO matches —
tests included (`useInlineGenerate.test.tsx` and `useInlineGenerate.ts` carry
comment references). Known comment sites: `load-replies.ts` (`ReviewRow` doc at
the top, `PastRepliesPageView` doc, the invariant-#4 LATERAL comment naming
`deriveRowState`/`held state` — re-point at `deriveAxes`/`deriveRowAction` and
the `'none'` projection), `InlineGeneratePanel.tsx:32` and
`useInlineGenerate.ts:27` (`row_state:'generating'` → `row_action:'generating'`).

In `reviews-list.test.ts`: re-target its mocked-view `row_state` assertions to
`reply_state`/`row_action`, and DELETE the
`describe('deriveRowState precedence')` block (lines 484–509) — every behavior
it owned is re-owned by Task 1's model tests (the invariant-#4 fall-through
pin by the held property + none×held cell; the precedence ladder by the
deriveAxes precedence test + the cell tests).

- [ ] **Step 4: Fill the six card-test todos**

In `past-reply-card-states.test.tsx`, using the file's existing render helpers
and an answered fixture with `approved_text` and an
`approval_method: 'owner'`-derived badge (adapt helper/fixture names and
copy-matchers to the file's actual helpers — exact-string matchers where a
regex would collide, e.g. /generate/i matching "Regenerate"):

```tsx
it('renders the live posted reply with Regenerate for an answered row without a held replacement draft', () => {
  renderCard({ reply_state: 'posted', row_action: 'regenerate' }, { editRepliesEnabled: true });
  expect(screen.getByText(FIXTURE_APPROVED_TEXT)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
});

it('keeps the live posted reply and provenance badge visible for an answered row with a held replacement draft', () => {
  renderCard({ reply_state: 'posted', row_action: 'none' }, { editRepliesEnabled: true });
  expect(screen.getByText(FIXTURE_APPROVED_TEXT)).toBeInTheDocument();
  expect(screen.getByText('You approved')).toBeInTheDocument();
});

it('renders no Regenerate button, no counter, and no held indication for an answered row with a held replacement draft', () => {
  const { unmount } = renderCard(
    { reply_state: 'posted', row_action: 'none' },
    { editRepliesEnabled: true, regenBudget: { used: 1, limit: 3, remaining: 2 } },
  );
  // NO buttons of any name — not just none called Regenerate.
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText(/of 3 today/)).not.toBeInTheDocument();
  expect(screen.queryByText(/reply on hold/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/under review/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
  unmount();
  // canEdit false must not resurrect the "Editing unavailable" lock either —
  // the lock explains an affordance slot that is withdrawn.
  renderCard(
    { reply_state: 'posted', row_action: 'none', canEdit: false },
    { editRepliesEnabled: true },
  );
  expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('renders the held panel with no draft text and no affordance for an unanswered review with a held draft', () => {
  renderCard({ reply_state: 'none', row_action: 'none', approved_text: null, response_id: null });
  expect(screen.getByText(/reply on hold/i)).toBeInTheDocument();
  expect(screen.getByText(/under review/i)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /draft ready/i })).not.toBeInTheDocument();
});

it('keeps the delete-failed recovery control while withdrawing Regenerate for an answered row with a held replacement draft', () => {
  renderCard(
    {
      reply_state: 'posted',
      row_action: 'none',
      failed_response_id: 'fail-1',
      failed_posting_error: 'delete_failed_boom',
    },
    { editRepliesEnabled: true },
  );
  // Recovery addresses the failed response, not the held draft (#726 owns the
  // server-side hold checks) — it is the ONLY control on the card.
  expect(screen.getByRole('button', { name: /needs attention/i })).toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByText(/reply on hold|under review/i)).not.toBeInTheDocument();
});

it('renders the locked presentation for every cell of the 3x4 cross-product', () => {
  // The end-to-end oracle: raw facts → toCardRow → render → the sole
  // permitted affordance. factsFor/expected mirror the #723 table verbatim.
  const CELLS: Array<[ReplyState, DraftState, RowAction]> = [
    ['none', 'none', 'generate'],
    ['none', 'generating', 'generating'],
    ['none', 'ready', 'draft_ready'],
    ['none', 'held', 'none'],
    ['posted', 'none', 'regenerate'],
    ['posted', 'generating', 'regenerate'],
    ['posted', 'ready', 'regenerate'],
    ['posted', 'held', 'none'],
    ['orphan', 'none', 'recover'],
    ['orphan', 'generating', 'recover'],
    ['orphan', 'ready', 'recover'],
    ['orphan', 'held', 'recover'],
  ];
  for (const [reply, draft, action] of CELLS) {
    const row = toCardRow(buildReviewRow(factsFor(reply, draft)), null, true);
    expect(row.reply_state).toBe(reply);
    expect(row.row_action).toBe(action);
    const { unmount } = render(
      <PastReplyCard row={row} isImported={false} editRepliesEnabled />,
    );
    assertOnlyAffordance(action); // per-action query map, exact strings
    unmount();
  }
});
```

`assertOnlyAffordance` is a local helper mapping each `RowAction` to the
queries proving that affordance — and only it — rendered: `generate` →
the InlineGeneratePanel's Generate button; `generating` → its in-flight
indicator and no button; `draft_ready` → the Needs Action link and no button;
`regenerate` → the Regenerate button; `recover` → the needs-attention button;
`none` → no button and no link at all. Import `factsFor` (export it from
`replies-view.test.ts` or duplicate the 10-line builder locally — prefer a
tiny local duplicate over a cross-test-file import if the repo has no
precedent for one) plus a `buildReviewRow` completing the remaining `ReviewRow`
fields (orphan cells need `orphan_failed_response_id`/`orphan_posting_error`
set and `superseded_text`).

The existing held-state test at `past-reply-card-states.test.tsx:188` ("renders
a moderation-held draft as held…") is superseded by the none×held test above —
delete it and let the new title own the behavior (net-negative bias).

- [ ] **Step 5: Run everything green**

Run: `pnpm vitest run src/lib/past-replies src/components/dashboard src/app`
Expected: PASS, including the Task 1 wire-leak allowlist pin (`row_state` is
gone).
Run: `pnpm typecheck && pnpm lint` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/
git commit -m "feat(#727): card renders the action slot; six-valued row_state deleted"
```

---

### Task 4: CONTEXT.md rewrite + ADR 0018 (docs — parallel with Task 3 after Task 2)

**Files:**
- Modify: `CONTEXT.md` (the **Reviews list** bullet)
- Create: `docs/adr/0018-row-state-axes-projection.md`

- [ ] **Step 1: Rewrite the Reviews list glossary entry**

In the CONTEXT.md **Reviews list** bullet, replace the sentence beginning "As
built, every affordance is one server-derived `ReviewRowState`…" through
"…surfaces neither its text nor any button." with:

> As built (#727), every affordance derives from two orthogonal axes modelled
> server-side (ADR 0018; replaces #678's six-valued `row_state` precedence
> chain `recover → regenerate → held → draft_ready → generating → generate`):
> the **Posted-reply axis** (`reply_state`: `none` / `posted` / `orphan`) —
> what exists on Google for the review; owns the Unanswered/Answered grouping
> and the reply panel — and the server-internal **Replacement-draft axis**
> (`draft_state`: `none` / `generating` / `ready` / `held`, intra-axis
> precedence held > ready > generating > none), which **never crosses the
> wire**. The card receives only `reply_state` plus the **Action slot**
> (`row_action`: `generate` / `generating` / `draft_ready` / `regenerate` /
> `recover` / `none`) — the single affordance derived from the full 3×4
> cross-product (`deriveAxes` + `deriveRowAction`,
> `src/lib/past-replies/replies-view.ts`). A held draft never projects an
> affordance of its own (invariant #4 as structure): `none`×held and
> `posted`×held project `row_action 'none'` — a posted row keeps its live
> Google reply visible and silently withdraws Regenerate — while `orphan`×held
> keeps `recover`, because recovery addresses the orphan incident, not the
> draft. The `held` value itself never reaches the browser: the card
> reconstructs the "Reply on hold" panel for an unanswered held row from
> `reply_state 'none'` + `row_action 'none'`.

Keep every other sentence of the entry (surface description, Needs Action
cross-link, per-action risk split, provenance-badge tail, _Avoid_ list) intact;
extend the trailing attribution with `; remodelled at #727 per #723`.

- [ ] **Step 2: Write ADR 0018**

Create `docs/adr/0018-row-state-axes-projection.md` following the structure of
`docs/adr/0017-persist-boundary-freshness-gate.md` (read it for the house
format: Status/Context/Decision/Consequences). Content requirements:

- **Context**: #678 shipped `deriveRowState`'s six-valued enum; posted-status
  and replacement-draft-status are orthogonal, so the collapse made posted×held
  return `regenerate` and render the drawer affordance (the #710 item-1 hole).
  #678's adversarial review had already REJECT/REMODEL'ed a 7th
  mutually-exclusive state.
- **Decision**: axes + action projection (#723 HITL): both axes modelled
  server-side; the wire carries `reply_state` + `row_action` only; the draft
  axis is server-internal. The projection is not a re-collapse — the
  cross-product is fully modelled where the decision is made; the information
  loss at the wire is deliberate and invariant-#4-required.
- **The orphan×held refinement**: the locked table gives orphan×held
  `recover` — the invariant is "a held draft never projects an affordance of
  its own", not "held → none everywhere" (deviations log 2026-08-09).
- **Alternatives rejected**: both axes raw on the wire (invariant #4 becomes
  client discipline); single enum with a 7th value / total dominance function
  (re-collapses orthogonal axes; already REJECT/REMODEL'ed at #678).
- **Consequences**: grouping predicate `reply_state === 'posted'` (identical
  row set); `row_action 'none'` inferable as "probably held" — accepted, a
  fake affordance that errors would be worse; posted×held withdrawal is silent
  (explaining it is the notification invariant #4 forbids); none×held keeps
  today's "Reply on hold" panel reconstructed client-side (owner call
  2026-08-09); **accepted transient**: while `InlineGeneratePanel` is polling,
  a generation that settles moderation-held reports `idle` (#672's locked
  draft-status design — held is deliberately indistinguishable at that API,
  for exactly the never-crosses-the-wire reason), so the panel re-offers
  Generate until the next server render reprojects the row to none×held; the
  Generate route refuses the spend (partial unique index + non-terminal
  exclusion), so the window costs nothing and leaks nothing.

- [ ] **Step 3: Verify and commit**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
(unchanged — docs task; a green run proves no accidental source edits).

```bash
git add CONTEXT.md docs/adr/0018-row-state-axes-projection.md
git commit -m "docs(#727): CONTEXT.md Reviews list rewrite + ADR 0018 (axes + action projection)"
```

---

## Review appendix — round 1 (codex 019fe619-0605-7cd1-bff7-f1a1dda1a2d4, VERDICT: REVISE)

Accepted and folded in: T2 typecheck ordering (fixture sweep split add-only/T2,
delete-only/T3) · direct `deriveAxes` 12-cell + settled-outranks-in-flight
tests · full-matrix grouping pin · exact-allowlist wire test + live-text value
pin (unit) and held-sentinel serialization pin (integration) · 12-cell render
oracle · posted×held + delete-failed sidecar test · canEdit:false no-lock
variant · integration open/unflagged/closed controls · corrected
flagged_responses fixture guidance (literal status values; `api_cost_id`
nullable-and-omitted; `persist.ts` declares its own private constant — do not
import from it) · `describe` range fix (484–509) · test files included in the
dead-name sweep.

Rejected with reasoning:
- **Held generation settles → panel re-offers Generate** (round-1 BLOCKER):
  the draft-status route returning `idle` for a held response is #672's locked
  design, documented in CONTEXT.md ("a moderation-held response returns
  `{ status: 'idle' }` and never its text"). Distinguishing held at that API
  would put the held fact on the wire — the exact thing #723 forbids. The
  transient window is now documented as an ADR 0018 consequence; the Generate
  route already refuses the spend. Changing the polling contract is a map-level
  question for #710, not this ticket.
- **Drawer-open-across-refresh reprojection sync**: adding client state-sync
  behavior is new scope; the defense for that race is #726's server-side hold
  gates, which exist precisely because "a server gate cannot depend on a client
  affordance". Surfaced for #710 charting if wanted.
- **`expectTypeOf` compile-time key-exclusion test**: marginal over the
  runtime exact-allowlist (any new wire key fails it), and would introduce a
  test pattern the repo does not use.

## Self-review notes

- Every intake `tests_to_add` title (17 after the round-1 additions) appears
  verbatim in T1/T2/T3 steps.
- Names consistent across tasks: `deriveAxes`, `deriveRowAction`, `ReplyState`,
  `DraftState`, `RowAction`, `reply_state`, `row_action`, `factsFor`.
- The grouping pin passes from T1 on (row set unchanged by design); the
  wire-leak allowlist pin is deliberately red T1→T3 — stated in all three tasks
  so no one "fixes" it early.
- `load-replies.ts` needs no query change (both facts already selected); only
  comments move. If a subagent believes a SELECT change is needed, that is a
  deviation — log it, don't improvise.
- Blocking edges: T1 → T2 → T3; T4 after T2, parallel with T3 (disjoint files).

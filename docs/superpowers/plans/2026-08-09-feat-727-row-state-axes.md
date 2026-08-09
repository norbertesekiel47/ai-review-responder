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
refinement + ADR number 0018).

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
  `src/components/dashboard/reviews/edit-reply/__tests__/useEditReplyDraft.test.tsx`
  (T3 fixture sweep)
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
`../replies-view` import with `deriveAxes, deriveRowAction`, and append:

```ts
const REPLY_STATES = ['none', 'posted', 'orphan'] as const;
const DRAFT_STATES = ['none', 'generating', 'ready', 'held'] as const;
const ROW_ACTIONS = [
  'generate', 'generating', 'draft_ready', 'regenerate', 'recover', 'none',
] as const;
// Every action that would surface or spend a draft. 'recover' is deliberately
// absent: it addresses the orphan incident, not the draft (#723 table).
const DRAFT_AFFORDANCES = ['generate', 'generating', 'draft_ready', 'regenerate'] as const;

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

Then add two wire-level pins to the file, reusing the file's existing
`ReviewRow` fixture builder (see the current `toCardRow` / `groupReplies`
describes for the builder's name and defaults — adapt the two bodies below to
it rather than inventing a second builder):

```ts
it('groups by the posted-reply axis — the Answered set is exactly the rows with a live posted reply', () => {
  // Build one row per: never-replied, posted, posted+held draft (draft_response_id
  // set + draft_held true + response_id set), orphan (is_orphan true), held
  // draft only, draft-ready only. Answered must be exactly the two posted rows
  // — including the posted×held one — regardless of draft facts.
  const rows = [
    build({ review_id: 'r-none' }),
    build({ review_id: 'r-posted', response_id: 'resp-1' }),
    build({ review_id: 'r-posted-held', response_id: 'resp-2', draft_response_id: 'd-1', draft_held: true }),
    build({ review_id: 'r-orphan', is_orphan: true, orphan_failed_response_id: 'f-1' }),
    build({ review_id: 'r-held', draft_response_id: 'd-2', draft_held: true }),
    build({ review_id: 'r-ready', draft_response_id: 'd-3', draft_held: false }),
  ];
  const { unansweredRows, answeredRows } = groupReplies(rows, null, true);
  expect(answeredRows.map((r) => r.review_id).sort()).toEqual(['r-posted', 'r-posted-held']);
  expect(unansweredRows.map((r) => r.review_id).sort()).toEqual(['r-held', 'r-none', 'r-orphan', 'r-ready']);
});

it('never carries draft state or held onto the wire shape', () => {
  const card = toCardRow(
    build({ response_id: 'resp-1', draft_response_id: 'd-1', draft_held: true }),
    null,
    true,
  );
  const keys = Object.keys(card);
  // row_state is in this list on purpose: the old enum put the literal string
  // 'held' on the wire for none×held; Task 3 removes it. RED until Task 3.
  for (const leaked of [
    'draft_response_id', 'draft_held', 'draft_state',
    'generation_in_flight', 'is_orphan', 'row_state',
  ]) {
    expect(keys).not.toContain(leaked);
  }
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
```

In `load-replies.integration.test.ts`, inside the `describeWithDb` block:

```ts
it.todo('returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held');
```

- [ ] **Step 4: Run and verify the red state**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
Expected: the five `deriveRowAction` tests FAIL with `unimplemented (#727 Task
2)`; `never carries draft state or held onto the wire shape` FAILS on
`row_state`; `groups by the posted-reply axis…` PASSES (regression pin — the
row set is unchanged by design); all pre-existing tests PASS.

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

- [ ] **Step 3: Flip the grouping predicate to the Posted-reply axis**

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

- [ ] **Step 4: Run the model tests green**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
Expected: everything PASSES except `never carries draft state or held onto the
wire shape` (still red on `row_state` — that is Task 3's cue, leave it red).

Run: `pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Fill the integration-test body**

In `load-replies.integration.test.ts`: the suite's local `ReviewsListView`
interface swaps `row_state: string` for `reply_state: string; row_action:
string` on both row arrays. Add fixture ids next to the existing ones:

```ts
const REVIEW_HELD_REPLACEMENT = randomUUID();
const RESPONSE_HELD_POSTED = randomUUID();
const RESPONSE_HELD_DRAFT = randomUUID();
```

Add a seed helper (verify the exact NOT-NULL column set against
`.claude/reference/migrations-log.md` / the schema before finalizing — the
flagged_responses column list below mirrors
`worker/jobs/response-generation/persist.ts:599`; import the open-status
constant from the module `persist.ts` imports it from rather than the literal):

```ts
async function seedHeldReplacement(reviewId: string, postedId: string, draftId: string): Promise<void> {
  await seedPostedResponse(postedId, reviewId);
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      response_language, version, status
    ) VALUES (
      ${draftId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Held replacement draft', 'Held replacement draft', 'en', 2, 'pending_approval'
    )
  `;
  await sql()`
    INSERT INTO flagged_responses (
      id, response_id, account_id, business_id, review_id,
      source, reason, severity, status
    ) VALUES (
      ${randomUUID()}::uuid, ${draftId}::uuid, ${tenant!.accountId}::uuid,
      ${businessId}::uuid, ${reviewId}::uuid,
      'local_regex', 'reviews-list integration fixture hold', 'high', ${FLAGGED_RESPONSE_STATUS_OPEN}
    )
  `;
}
```

In `beforeAll`, after the existing seeds (star rating 3 keeps the existing
`avgStarRating` assertion at 3; the 2026-02 date sorts it LAST in Answered):

```ts
await seedReview(REVIEW_HELD_REPLACEMENT, 3, '2026-02-01T00:00:00Z', REVIEW_STATUS.POSTED);
await seedHeldReplacement(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_POSTED, RESPONSE_HELD_DRAFT);
```

Update the existing test's now-changed denominators and tails:
`answeredRows` id array gains `REVIEW_HELD_REPLACEMENT` third, `answeredTotal`
becomes 3, `totalPages` computes over 5, `avgStarRating` stays 3
((5+4+2+1+3)/5), and the final two row-state assertions become:

```ts
expect(view!.unansweredRows.every((row) => row.row_action === 'generate')).toBe(true);
expect(view!.answeredRows.map((row) => row.row_action)).toEqual(['regenerate', 'regenerate', 'none']);
```

Replace the `it.todo` with:

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
  // The draft axis never crosses the wire.
  const keys = Object.keys(heldRow!);
  expect(keys).not.toContain('draft_held');
  expect(keys).not.toContain('draft_response_id');
});
```

Extend the `afterAll` cleanup only if the existing business-scoped DELETEs do
not already cover the new rows (they do: both new responses and the review
carry `business_id = businessId`; `flagged_responses` needs its own DELETE —
add `await sql()\`DELETE FROM flagged_responses WHERE business_id =
${businessId}::uuid\`` BEFORE the responses DELETE to satisfy the FK).

- [ ] **Step 6: Run the integration suite against the live DB**

Run: `TEST_DATABASE_POOL_URL=<from .env.local> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts`
Expected: PASS (both tests). If the DB container is behind migrations head the
suite fails loudly with the `pnpm test:db:setup` message — run that once and
retry; NEVER apply DDL from the suite.

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/past-replies src/components/dashboard/reviews/PastReplyCard.tsx
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
- Modify (fixture/assertion sweep): `replies-view.test.ts`,
  `reviews-list.test.ts`, `past-reply-card-states.test.tsx`,
  `PastReplyCard.test.tsx`, `PastRepliesClient.test.tsx`,
  `useEditReplyDraft.test.tsx`

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

- [ ] **Step 3: Comment sweep for the dead name**

`rg -n "row_state|deriveRowState|ReviewRowState" src/ --glob '!**/__tests__/**'`
must return only `reply_state`/`row_action` matches after this step. Known
sites: `load-replies.ts` (`ReviewRow` doc at the top, `PastRepliesPageView`
doc, the invariant-#4 LATERAL comment naming `deriveRowState`/`held state` —
re-point at `deriveAxes`/`deriveRowAction` and the `'none'` projection),
`InlineGeneratePanel.tsx:32` and `useInlineGenerate.ts:27`
(`row_state:'generating'` → `row_action:'generating'`).

- [ ] **Step 4: Fixture/assertion sweep (mechanical mapping)**

Every fixture constructing `PastReplyRow`/`ReviewsListRow` replaces
`row_state: 'X'` per this table (TypeScript missing-property errors enumerate
every site):

| old `row_state` | `reply_state` | `row_action` |
|---|---|---|
| `'generate'` | `'none'` | `'generate'` |
| `'generating'` | `'none'` | `'generating'` |
| `'draft_ready'` | `'none'` | `'draft_ready'` |
| `'held'` | `'none'` | `'none'` |
| `'regenerate'` | `'posted'` | `'regenerate'` |
| `'recover'` | `'orphan'` | `'recover'` |

Files: `past-reply-card-states.test.tsx`, `PastReplyCard.test.tsx`,
`PastRepliesClient.test.tsx`, `useEditReplyDraft.test.tsx:25`,
`replies-view.test.ts` (existing `toCardRow`/`groupReplies` assertions on
`row_state` re-target `reply_state`/`row_action`), `reviews-list.test.ts`
(mocked-view assertions on `row_state`). In `reviews-list.test.ts`, DELETE the
`describe('deriveRowState precedence')` block (:484-512) — its two behaviors
are owned by Task 1's model tests ("never falls through to generate for a
moderation-held draft" is subsumed by the invariant-#4 property + the
`none×held → 'none'` cell, which the partial unique index rationale comment
moves onto).

- [ ] **Step 5: Fill the four card-test todos**

In `past-reply-card-states.test.tsx`, using the file's existing render helpers
and an answered fixture with `approved_text` and an
`approval_method: 'owner'`-derived badge (adapt helper names to the file):

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
  renderCard(
    { reply_state: 'posted', row_action: 'none' },
    { editRepliesEnabled: true, regenBudget: { used: 1, limit: 3, remaining: 2 } },
  );
  expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/of 3 today/)).not.toBeInTheDocument();
  expect(screen.queryByText(/reply on hold/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/under review/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/editing unavailable/i)).not.toBeInTheDocument();
});

it('renders the held panel with no draft text and no affordance for an unanswered review with a held draft', () => {
  renderCard({ reply_state: 'none', row_action: 'none', approved_text: null, response_id: null });
  expect(screen.getByText(/reply on hold/i)).toBeInTheDocument();
  expect(screen.getByText(/under review/i)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /draft ready/i })).not.toBeInTheDocument();
});
```

The existing held-state test at `past-reply-card-states.test.tsx:188` ("renders
a moderation-held draft as held…") is superseded by the last test above —
delete it and let the new title own the behavior (net-negative bias). Verify
`RegenBudgetStatus`'s field names against `src/lib/costs/tracker.ts` before
writing the counter fixture.

- [ ] **Step 6: Run everything green**

Run: `pnpm vitest run src/lib/past-replies src/components/dashboard src/app`
Expected: PASS, including the Task 1 wire-leak pin (`row_state` is gone).
Run: `pnpm typecheck && pnpm lint` — Expected: PASS.

- [ ] **Step 7: Commit**

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
  2026-08-09).

- [ ] **Step 3: Verify and commit**

Run: `pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts`
(unchanged — docs task; a green run proves no accidental source edits).

```bash
git add CONTEXT.md docs/adr/0018-row-state-axes-projection.md
git commit -m "docs(#727): CONTEXT.md Reviews list rewrite + ADR 0018 (axes + action projection)"
```

---

## Self-review notes

- Every intake `tests_to_add` title appears verbatim in T1/T2/T3 steps (12/12).
- Names consistent across tasks: `deriveAxes`, `deriveRowAction`, `ReplyState`,
  `DraftState`, `RowAction`, `reply_state`, `row_action`.
- The `groups by the posted-reply axis…` pin passes from T1 on (row set
  unchanged by design); the wire-leak pin is deliberately red T1→T3 — stated in
  both tasks so no one "fixes" it early.
- `load-replies.ts` needs no query change (both facts already selected); only
  comments move. If a subagent believes a SELECT change is needed, that is a
  deviation — log it, don't improvise.
- Blocking edges: T1 → T2 → T3; T4 after T2, parallel with T3 (disjoint files).

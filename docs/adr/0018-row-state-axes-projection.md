# ADR 0018 — Reviews-list row state as two axes + an action projection

## Status

Accepted — 2026-08-09 (issue #727, decision ticket #723 of map #710 item 1;
HITL owner sign-off on the locked cross-product table). **Replaces** #678's
six-valued `ReviewRowState` enum and its `deriveRowState` precedence chain.
Numbering note: #723's resolution comment says "ADR 0017", but 0017 was taken
by #724's persist-boundary freshness gate after that comment was written — see
the feat-727 deviations log.

## Context

#678 shipped the Reviews list with one server-derived row state:
`deriveRowState` (`src/lib/past-replies/replies-view.ts`) collapsed every
per-row fact into a single six-valued enum — precedence
`recover → regenerate → held → draft_ready → generating → generate` — and the
card rendered that state without computing anything.

The collapse was the defect. Two of the facts it flattened are **orthogonal**:
whether a reply exists on Google (none / posted / orphan) and where a
replacement draft stands (none / generating / ready / held). A single total
order over one enum cannot express both axes at once, so the chain had to pick
a winner per row — and `response_id !== null` was tested **before**
`draft_held`, so a posted reply with a moderation-held replacement draft
returned `regenerate` and rendered the `EditReplyDrawer` affordance. That is
the map #710 item-1 hole: an affordance whose flow reaches a draft that
invariant #4 says must surface neither its text nor any button. The `held`
enum value only ever protected the *unanswered* branch; the posted branch
never consulted it.

This was not a novel discovery at #723. #678's own adversarial review had
already returned REJECT/REMODEL on the proposed fix of that era — a **7th
mutually-exclusive state** — precisely because adding values to a collapsed
enum re-commits the modelling error: every new combination of the two axes
demands another value and another precedence argument.

## Decision

**Model both axes server-side; project a single action onto the wire** (#723,
HITL owner sign-off):

1. `deriveAxes` (`src/lib/past-replies/replies-view.ts`) derives the
   **Posted-reply axis** (`reply_state`: `none` / `posted` / `orphan`) and the
   **Replacement-draft axis** (`draft_state`: `none` / `generating` / `ready`
   / `held`, intra-axis precedence held > ready > generating > none) from the
   same row-source facts `deriveRowState` read.
2. `deriveRowAction` maps the full 3×4 cross-product to the **Action slot**
   (`row_action`: `generate` / `generating` / `draft_ready` / `regenerate` /
   `recover` / `none`) — the single affordance the card renders.
3. **The wire carries `reply_state` + `row_action` only.** The draft axis is
   server-internal; `held` in particular never reaches the browser. Grouping
   (Unanswered/Answered) and the reply panel key off `reply_state`; the
   affordance keys off `row_action`; nothing client-side ever re-derives
   either.

### The projection is not a re-collapse

Superficially, `row_action` looks like the old enum with different plumbing.
The difference is **where** the information loss happens. `deriveRowState`
lost the cross-product *at the decision* — the precedence chain never saw
posted×held as a distinct cell, so it could not rule on it. `deriveRowAction`
is total over all 12 cells: every combination is decided explicitly where the
facts live, and only then is the result projected down to what the card needs.
The information loss at the wire is deliberate and invariant-#4-required — the
client cannot leak what it never receives. A held draft's existence, text, and
status stay on the server; the card gets an action, not a diagnosis.

### The invariant, stated precisely: orphan×held keeps `recover`

The locked table gives orphan×held → `recover`, not `none`. #723's resolution
prose ("held → `none` in EVERY reply_state") was summary shorthand and loses
to the reacted-to table (deviations log, 2026-08-09). The invariant is:

> **A held draft never projects an affordance of its own.**

`none`×held and `posted`×held project `row_action 'none'` because the only
affordances on offer there (Generate / the drawer) act on the draft. `recover`
is not a draft affordance — it addresses the orphan incident (a failed repost
with no live reply). The held draft stays invisible either way; #726 owns the
server-side hold checks the recovery drawer's discard path could reach.

Dominance is a claim about the **affordance**, not about execution. `/retry`
and `/restore-original` reject with `409 newer_draft_exists` while ANY
non-terminal sibling exists — and a held draft (`pending_approval`) is
non-terminal — so on an orphan×held row the recovery control renders but
executing it waits on the admin disposition of the hold. That 409 is the
migration-029 unique-index protection working as designed, not a defect of
this projection. The cell is also all but unreachable: the only charted
producer of orphan×held (#723's "Generate API on an orphan" leak) was closed
post-#723 by `on-demand-generate`'s orphan refusal
(`orphan_recovery_pending`). Remodelling recovery availability as a
capability-projected axis was reviewed and deferred as a map #710 question
(recorded in `docs/reviews/feat-727-row-state-axes/adversarial-approach.md`).

## Alternatives considered

- **Both axes raw on the wire** (`reply_state` + `draft_state`). Rejected:
  the moment `held` crosses the wire, invariant #4 stops being structure and
  becomes client discipline — every present and future consumer of the payload
  (the card, devtools, logging, any component someone adds next quarter) must
  be audited forever to not surface it. The projection makes the leak
  impossible rather than forbidden.
- **A single enum with a 7th value (or a total dominance function over one
  enum).** Rejected: re-collapses orthogonal axes into one order, which is the
  defect being fixed — and #678's adversarial review had already
  REJECT/REMODEL'ed exactly this shape. Each future combination would demand
  another value; the 3×4 table has no such growth mode.

## Consequences

- **Grouping predicate** becomes `reply_state === 'posted'`
  (`groupReplies`). The row set is identical to the old `regenerate`-based
  grouping — orphans and held rows group under Unanswered as before — and a
  test pins the equivalence.
- **`row_action 'none'` is weakly inferable.** An observant owner who knows
  the product can read an unanswered row with no Generate button as "probably
  held". Accepted: the alternative — projecting a fake affordance whose
  invocation errors — is strictly worse, and the inference exposes no text
  and no confirmation.
- **The posted×held withdrawal is silent.** The row keeps its live Google
  reply visible and simply offers no Regenerate; nothing explains why.
  Deliberate: an explanation *is* the notification invariant #4 forbids —
  "held, not notified" applies to the list surface exactly as it does to the
  notification pipeline.
- **`none`×held keeps today's "Reply on hold" panel**, reconstructed
  client-side from `reply_state 'none'` + `row_action 'none'` (owner call,
  2026-08-09). The panel communicates that a hold exists without carrying the
  `held` value or the draft.
- **Accepted transient — the polling window.** While `InlineGeneratePanel` is
  polling `draft-status`, a generation that settles moderation-held reports
  `{ status: 'idle' }` — #672's locked draft-status design, where held is
  deliberately indistinguishable from no-draft at that API for exactly the
  never-crosses-the-wire reason. The panel therefore re-offers Generate until
  the next server render reprojects the row to none×held. The window costs
  nothing and leaks nothing: the Generate route refuses the spend (the partial
  unique index, migrations 023+026+029, plus the non-terminal exclusion
  rejects a second live draft) and the response never includes the held text.
  Raised in the plan's round-1 codex review; documented here as a consequence
  rather than "fixed", because the fix would be un-locking #672.

## Addendum (2026-08-09, #731 implementation) — the reply-facts split is safe because of a type

`toCardRow` now dispatches its seven axis-dependent fields to two private
mappers (`orphanReplyFacts` / `liveReplyFacts`) instead of resolving each with
its own `isOrphan ? … : …` ternary. The **Posted-reply axis** therefore has a
second consumer: it already chose the **Action slot**, and it now also selects
the *source* of the card's reply fields (`orphan_*` LATERALs vs `resp.*` +
`fail_sidecar`). One axis, one dispatch, two decisions — no new model.

This **reverses a #678 round-2 decision.** Defect A merged the then-separate
`toOrphanCardRow` back into `toCardRow` because the split had dropped
`failed_response_id`, and since `AnsweredControls` and `RecoveryControl` gate the
recovery *actions* on that field rather than on the badge, recovery became
silently unreachable — a defect no test caught because the card still *rendered*
correctly.

The reversal is safe now for a reason that did not exist then, and it is not
"we will be more careful": both mappers return
`Required<Pick<ReviewsListRow, …>>`. `version`, `failed_response_id` and
`failed_posting_error` are **optional** on `PastReplyRow`, so a bare `Pick<>`
would reproduce Defect A exactly. `Required<>` strips the `?`, making an omitted
field a compile error rather than something review has to notice.

That guarantee was **confirmed empirically, not asserted**: deleting the
`failed_response_id` line from `orphanReplyFacts` produces
`error TS2741: Property 'failed_response_id' is missing …` at
`replies-view.ts(257,3)` — the compiler names the exact field Defect A lost.
(The mapper's own doc comment and commit `ee5c6b8f`'s message both say TS2739;
that was a pre-observation guess. TS2741 is the single-missing-property code
actually emitted — TS2739 is its multi-property sibling.)

Consequence for future edits: **adding a field to the card that depends on the
Posted-reply axis means adding it to `ReplyFacts`**, which then forces both
mappers to answer for it. A field added only to the object literal in
`toCardRow` is axis-independent by construction — if it is not, the type will
not stop you, so keep the distinction deliberate.

The mappers are deliberately **not exported**. They are an internal seam; every
test reaches them through `toCardRow`, so the pinned card key set (18 keys) and
the behaviour contract stay the test surface rather than the refactor's shape.

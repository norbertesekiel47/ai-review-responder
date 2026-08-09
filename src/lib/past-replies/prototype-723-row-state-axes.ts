/**
 * PROTOTYPE — THROWAWAY (#723). Never import from production code.
 *
 * Run: pnpm tsx src/lib/past-replies/prototype-723-row-state-axes.ts
 *
 * QUESTION: `deriveRowState` collapses two orthogonal axes (posted-reply
 * status × replacement-draft status) into one six-valued enum, and the
 * collapse loses information — a posted reply with a moderation-held
 * replacement draft returns 'regenerate' and offers the drawer (invariant #4
 * hole, #710 item 1). Does modelling the axes separately, with the draft axis
 * projected into a single server-derived action slot, define every cell of
 * the 3×4 cross-product safely — including the cells the current enum makes
 * invisible?
 *
 * The implementation lands in #727; this file lands on a throwaway branch.
 */

// ---------------------------------------------------------------------------
// The two axes (pure model — the bit that would lift into replies-view.ts)
// ---------------------------------------------------------------------------

/** Axis A — what exists on Google for this review. Owns grouping + reply panel. */
type ReplyState = 'none' | 'posted' | 'orphan';

/**
 * Axis B — where the replacement workflow stands. Server-internal: it never
 * crosses the wire; the card sees only its projection into RowAction.
 * Intra-axis precedence (a settled response row outranks an in-flight outbox
 * row — same rationale as today's deriveRowState): held > ready > generating > none.
 */
type DraftState = 'none' | 'generating' | 'ready' | 'held';

/**
 * The single affordance the card renders — the wire field replacing
 * `row_state`, alongside `reply_state`. `held` always projects to 'none':
 * invariant #4 as a structural property (the wire cannot carry what the card
 * must not render).
 */
type RowAction =
  | 'generate' // InlineGeneratePanel
  | 'generating' // in-flight indicator, no button
  | 'draft_ready' // cross-link to Needs Action
  | 'regenerate' // EditReplyDrawer (drawer itself resumes in-flight/pending attempts)
  | 'recover' // /retry + /restore-original
  | 'none'; // no affordance (today: only held cells produce this)

interface RowFacts {
  response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}

/** Same inputs as today's deriveRowState → the two axes. */
function deriveAxes(r: RowFacts): { reply: ReplyState; draft: DraftState } {
  // is_orphan already encodes resp.id IS NULL (load-replies F3), so
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

interface CellPresentation {
  group: 'Unanswered' | 'Answered';
  replyPanel: string; // what the owner sees about the Google side
  action: RowAction;
  note: string;
}

/** Total over the full 3×4 cross-product — every cell defined, none accidental. */
function derivePresentation(reply: ReplyState, draft: DraftState): CellPresentation {
  switch (reply) {
    case 'none': {
      const panel = 'review only';
      switch (draft) {
        case 'none':
          return { group: 'Unanswered', replyPanel: panel, action: 'generate', note: '' };
        case 'generating':
          return { group: 'Unanswered', replyPanel: panel, action: 'generating', note: '' };
        case 'ready':
          return { group: 'Unanswered', replyPanel: panel, action: 'draft_ready', note: 'cross-link; draft text never in the list' };
        case 'held':
          return { group: 'Unanswered', replyPanel: panel, action: 'none', note: 'invariant #4: no draft text, no button, no explanation' };
      }
      break;
    }
    case 'posted': {
      const panel = 'live reply + provenance badge';
      switch (draft) {
        case 'none':
          return { group: 'Answered', replyPanel: panel, action: 'regenerate', note: '' };
        case 'generating':
          return { group: 'Answered', replyPanel: panel, action: 'regenerate', note: 'drawer resumes the in-flight attempt' };
        case 'ready':
          return { group: 'Answered', replyPanel: panel, action: 'regenerate', note: 'drawer offers Resume/Discard of pending replacement' };
        case 'held':
          return { group: 'Answered', replyPanel: panel, action: 'none', note: 'THE BUG CELL: live reply stays visible; held replacement invisible; Regenerate withdrawn (unique index forbids a 2nd draft, and the drawer would reach held content)' };
      }
      break;
    }
    case 'orphan': {
      const panel = 'superseded text + posting error';
      switch (draft) {
        case 'none':
          return { group: 'Unanswered', replyPanel: panel, action: 'recover', note: '' };
        case 'generating':
          return { group: 'Unanswered', replyPanel: panel, action: 'recover', note: 'generation settles in background → orphan×ready' };
        case 'ready':
          return { group: 'Unanswered', replyPanel: panel, action: 'recover', note: 'OPEN CELL — recovery dominates; pending draft stays reachable via Needs Action. Alternative: draft_ready dominance' };
        case 'held':
          return { group: 'Unanswered', replyPanel: panel, action: 'recover', note: 'held draft invisible; recovery unaffected (#726 owns the discard hold-check server-side)' };
      }
      break;
    }
  }
  throw new Error(`unreachable cell ${reply}×${draft}`);
}

// ---------------------------------------------------------------------------
// Today's collapse, copied verbatim for the delta column (throwaway dup)
// ---------------------------------------------------------------------------

function currentDeriveRowState(r: RowFacts): string {
  if (r.is_orphan) return 'recover';
  if (r.response_id !== null) return 'regenerate';
  if (r.draft_response_id !== null) return r.draft_held ? 'held' : 'draft_ready';
  if (r.generation_in_flight) return 'generating';
  return 'generate';
}

// ---------------------------------------------------------------------------
// Renderer: the full cross-product as a markdown table
// ---------------------------------------------------------------------------

/** How each cell arises (reachability is part of the reaction material). */
const REACHABILITY: Record<`${ReplyState}×${DraftState}`, string> = {
  'none×none': 'never replied',
  'none×generating': 'Generate clicked / live-ingest job in flight',
  'none×ready': 'draft awaiting owner in Needs Action',
  'none×held': 'live-ingest (or Generate) draft flagged high-severity',
  'posted×none': 'the ordinary answered row',
  'posted×generating': 'Regenerate attempt in flight',
  'posted×ready': 'pending replacement from the edit-existing-reply flow',
  'posted×held': 'replacement draft flagged high-severity while old reply live',
  'orphan×none': 'delete succeeded, repost failed',
  'orphan×generating': 'Generate API on an orphan (no orphan exclusion in the route tx — leak, see findings)',
  'orphan×ready': 'that generation settled',
  'orphan×held': 'that generation settled flagged',
};

function factsFor(reply: ReplyState, draft: DraftState): RowFacts {
  return {
    response_id: reply === 'posted' ? 'resp-1' : null,
    is_orphan: reply === 'orphan',
    draft_response_id: draft === 'ready' || draft === 'held' ? 'draft-1' : null,
    draft_held: draft === 'held',
    generation_in_flight: draft === 'generating',
  };
}

function main(): void {
  const replies: ReplyState[] = ['none', 'posted', 'orphan'];
  const drafts: DraftState[] = ['none', 'generating', 'ready', 'held'];

  const header =
    '| cell (reply×draft) | reached by | group | reply panel | action slot | today | delta |\n' +
    '|---|---|---|---|---|---|---|';
  const lines: string[] = [header];

  for (const reply of replies) {
    for (const draft of drafts) {
      const facts = factsFor(reply, draft);
      const axes = deriveAxes(facts);
      if (axes.reply !== reply || axes.draft !== draft) {
        throw new Error(`deriveAxes not faithful for ${reply}×${draft}`);
      }
      const p = derivePresentation(reply, draft);
      const today = currentDeriveRowState(facts);
      const delta =
        p.action === today || (p.action === 'none' && today === 'held')
          ? p.action === 'none' && today === 'held'
            ? 'same render, held leaves the wire'
            : '—'
          : `**${today} → ${p.action}**`;
      lines.push(
        `| ${reply}×${draft} | ${REACHABILITY[`${reply}×${draft}`]} | ${p.group} | ${p.replyPanel} | \`${p.action}\`${p.note ? ` — ${p.note}` : ''} | \`${today}\` | ${delta} |`,
      );
    }
  }

  console.log(lines.join('\n'));
}

main();

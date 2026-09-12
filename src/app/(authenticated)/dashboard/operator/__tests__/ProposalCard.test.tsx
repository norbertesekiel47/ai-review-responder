// @vitest-environment jsdom
// The card contracts (spec §3.3). Every assertion reads from a stored-row
// fixture, never from prose, and never from the browser's location selector.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import { ProposalCard } from '../ProposalCard';
import { RequestedCapabilityCard } from '../RequestedCapabilityCard';
import {
  AFFECTS_FUTURE_DRAFTS,
  APPLY,
  CANNOT_DO_YET,
  NOT_NOW,
  PROPOSAL_LABEL_APPLIED,
  PROPOSAL_LABEL_PENDING,
  PROPOSAL_STALE,
  REFRESH_PLAN,
} from '../wording';

const SALON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAFE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACTOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PROPOSAL = '99999999-9999-4999-8999-999999999999';
const DESCRIBE = 'Set the reply tone to "warm and brief"';

const VOICE_BEFORE = {
  tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [],
};
const VOICE_AFTER = { ...VOICE_BEFORE, tone: 'warm and brief' };

const labels: Record<string, string> = { [SALON]: 'Salon', [CAFE]: 'Cafe' };
const locationLabel = (id: string) => labels[id] ?? 'this location';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    turnId: TURN,
    operation: 'set_tone',
    contractVersion: 1,
    labelKind: 'fact' as const,
    locationId: SALON,
    status: 'pending' as const,
    rationale: 'You asked for warmer replies.',
    input: { tone: 'warm and brief' },
    before: VOICE_BEFORE,
    after: VOICE_AFTER,
    describe: DESCRIBE,
    preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
    receipt: null,
    appliedAt: null,
    failureReason: null,
    ...overrides,
  };
}

const RECEIPT = {
  version: 1 as const,
  operation: 'set_tone',
  scope: { accountId: ACCOUNT, locationId: SALON },
  before: VOICE_BEFORE,
  after: VOICE_AFTER,
  differsFromPreview: false,
  effectiveNow: true as const,
  affects: 'future_drafts' as const,
  remainingBlocked: [],
  appliedAt: '2026-09-12T10:00:00.000Z',
  actorUserId: ACTOR,
  actorName: 'Ada Owner',
  ownerText: 'Make my replies warmer.',
  turnId: TURN,
  versionToken: {
    before: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
    after: { businessId: SALON, updatedAt: '2026-09-12 10:00:00.222222+00' },
  },
};

/**
 * Test fixture narrowing. The literals above are the WIRE shape the route
 * returns, and the overrides are open records, so the cast happens ONCE here
 * rather than at every call site.
 */
const asProposal = (value: Record<string, unknown>) => value as unknown as ProposalView;

function renderCard(overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const handlers = { onApply: vi.fn(), onDecline: vi.fn(), onRefreshPlan: vi.fn() };
  const utils = render(
    <ProposalCard
      proposal={asProposal(proposal(overrides))}
      turnLocationId={SALON}
      locationLabel={locationLabel}
      scopeMoved={false}
      busy={false}
      error={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

describe('ProposalCard', () => {
  it('proposal card renders the target from the stored location and shows Prepared for the location when the selector moved', () => {
    const { unmount } = renderCard();
    // The target names the STORED location, and the card states what the
    // change affects (spec §8.4).
    expect(screen.getByText('Salon')).toBeInTheDocument();
    expect(screen.getByText(AFFECTS_FUTURE_DRAFTS)).toBeInTheDocument();
    // Exact before and after of the FULL voice state (spec §3.3, §6.1).
    //
    // The EXACT string, not a substring. The headline already quotes the same
    // value — `Set the reply tone to "warm and brief"` — so a regex matches
    // the h2 as well and the assertion passes with no diff rendered at all,
    // which is the one thing this line exists to prove.
    expect(screen.getByText('warm and brief')).toBeInTheDocument();
    // No note while the selector still points at the turn's location.
    expect(screen.queryByText(/^Prepared for/)).not.toBeInTheDocument();
    unmount();

    // The selector moved to the Cafe. The card STILL names the Salon — the
    // target comes from the stored row, never from the browser (§3.3) — and
    // adds the note, worded exactly as D4 fixes it.
    renderCard({}, { scopeMoved: true });
    expect(screen.getByText('Prepared for Salon')).toBeInTheDocument();
    expect(screen.queryByText('Cafe')).not.toBeInTheDocument();
  });

  it('proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch', async () => {
    const user = userEvent.setup();
    const pending = renderCard();
    // THE §1 LABEL BEFORE APPLY. The fixture is a `fact`, so the card says
    // what kind of thing it is — not just what it does.
    expect(screen.getByText(PROPOSAL_LABEL_PENDING.fact)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: APPLY }));
    expect(pending.onApply).toHaveBeenCalledTimes(1);
    expect(pending.onApply.mock.calls[0]![0].id).toBe(PROPOSAL);
    await user.click(screen.getByRole('button', { name: NOT_NOW }));
    expect(pending.onDecline).toHaveBeenCalledTimes(1);
    pending.unmount();

    // APPLIED: the Receipt replaces the buttons and the label becomes applied.
    const applied = renderCard({
      status: 'applied',
      receipt: RECEIPT,
      appliedAt: '2026-09-12T10:00:00.000Z',
    });
    // THE APPLIED HALF of the §1 contract, in place of the bare word
    // "Applied": the owner reads what the card now IS.
    expect(screen.getByText(PROPOSAL_LABEL_APPLIED.fact)).toBeInTheDocument();
    expect(screen.queryByText('Applied')).not.toBeInTheDocument();
    expect(screen.queryByText(PROPOSAL_LABEL_PENDING.fact)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: APPLY })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NOT_NOW })).not.toBeInTheDocument();
    // The Receipt's own fields: the actual after, the verbatim owner text and
    // the turn id as correlation id (spec §6.5).
    expect(screen.getByText('Make my replies warmer.')).toBeInTheDocument();
    expect(screen.getByText(TURN)).toBeInTheDocument();
    expect(screen.getByText(/effective now/i)).toBeInTheDocument();
    // …and the rest of the server-written record: WHAT ran, WHO ran it, and
    // WHEN, printed from the Receipt's own instant rather than from a clock
    // read while rendering. The change is named in PLAIN WORDS — the same
    // describer the heading carries, never the catalog id — and the actor is a
    // PERSON, never the uuid the row stores.
    //
    // SCOPED TO THE RECEIPT'S OWN RECORD, not counted across the document. A
    // document-wide count of two passes when the heading renders the sentence
    // twice and the Receipt renders it not at all, and breaks on any layout
    // that legitimately repeats it — neither of which is the claim. The claim
    // is that THIS row, the one labelled `Change`, carries the describer.
    const facts = screen.getByText('Applied at').closest('dl')!;
    expect(within(facts).getByText('Change').nextElementSibling!.textContent).toBe(DESCRIBE);
    expect(screen.queryByText('set_tone')).not.toBeInTheDocument();
    expect(screen.getByText('Ada Owner')).toBeInTheDocument();
    expect(screen.queryByText(ACTOR)).not.toBeInTheDocument();
    expect(screen.getByText('Applied at').nextElementSibling!.querySelector('time'))
      .toHaveAttribute('datetime', RECEIPT.appliedAt);
    applied.unmount();

    // A Receipt written with no actor name — the row's name was null, or the
    // Receipt predates the field — still names a person, not a key.
    const unnamed = renderCard({
      status: 'applied',
      receipt: { ...RECEIPT, actorName: null },
      appliedAt: '2026-09-12T10:00:00.000Z',
    });
    expect(screen.getByText('Account owner')).toBeInTheDocument();
    expect(screen.queryByText(ACTOR)).not.toBeInTheDocument();
    unnamed.unmount();

    // A `rule` card carries the OTHER pair, before and after.
    const proposedRule = renderCard({ labelKind: 'rule' });
    expect(screen.getByText(PROPOSAL_LABEL_PENDING.rule)).toBeInTheDocument();
    proposedRule.unmount();
    const activeRule = renderCard({ labelKind: 'rule', status: 'applied', receipt: null });
    expect(screen.getByText(PROPOSAL_LABEL_APPLIED.rule)).toBeInTheDocument();
    activeRule.unmount();

    // STALE: the sentence, and a Refresh plan action that posts a new turn
    // from the original instruction (spec §3.3).
    const stale = renderCard({ status: 'stale', failureReason: 'version_mismatch' });
    expect(screen.getByText(PROPOSAL_STALE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: APPLY })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: REFRESH_PLAN }));
    expect(stale.onRefreshPlan).toHaveBeenCalledTimes(1);
    stale.unmount();

    // contract_changed also offers Refresh plan — a fresh plan is exactly the
    // fix — but says the plan must be prepared again, not that settings moved.
    const changed = renderCard({ status: 'rejected', failureReason: 'contract_changed' });
    expect(screen.getByText(/must be prepared again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REFRESH_PLAN })).toBeInTheDocument();
    expect(screen.queryByText(PROPOSAL_STALE)).not.toBeInTheDocument();
    changed.unmount();

    // THE REMAINING STATUSES. Every terminal state gets a sentence and none of
    // them an action: a card that fell through to a blank body would leave the
    // owner with a headline and no idea what became of it.
    const terminal: Array<[Record<string, unknown>, string | RegExp]> = [
      [{ status: 'rejected', failureReason: null }, 'Not applied'],
      [{ status: 'superseded', failureReason: null }, 'Replaced by a newer plan'],
      [{ status: 'failed', failureReason: 'write_failed' }, /could not save that change/i],
    ];
    for (const [overrides, sentence] of terminal) {
      const { unmount } = renderCard(overrides);
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: APPLY })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: REFRESH_PLAN })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('proposal previews expose exact fact replacements before approval', () => {
    // SAME LENGTH, DIFFERENT CONTENT. A count renders "Avoid 2" on both sides
    // and the owner approves a swap they never read — and the catalog
    // describer says only "Keep 2 thing(s) out of every reply"
    // (src/lib/agents/operator/catalog.ts:157-171), so the headline cannot
    // carry it either.
    renderCard({
      operation: 'set_avoid_facts',
      describe: 'Keep 2 thing(s) out of every reply',
      input: { avoidFacts: ['shellfish', 'the old menu'] },
      before: {
        ...VOICE_BEFORE,
        tone: 'warm and brief',
        productsServices: 'haircuts and colour',
        avoidFacts: ['peanuts', 'the old menu'],
        highlightFacts: ['free parking'],
        sampleResponses: ['Thanks so much!'],
      },
      after: {
        ...VOICE_BEFORE,
        tone: 'warm and brief',
        productsServices: null,
        avoidFacts: ['shellfish', 'the old menu'],
        highlightFacts: ['free parking'],
        sampleResponses: ['Thanks so much!'],
      },
    });

    // BOTH sides of the swap are on screen, by value.
    expect(screen.getByText('peanuts')).toBeInTheDocument();
    expect(screen.getByText('shellfish')).toBeInTheDocument();
    // The item that did NOT change appears on both sides and is not flagged.
    expect(screen.getAllByText('the old menu')).toHaveLength(2);
    for (const node of screen.getAllByText('the old menu')) {
      expect(node).not.toHaveClass('op-changed');
    }
    // The changed items ARE flagged, and not by colour alone — the class
    // carries a weight as well.
    expect(screen.getByText('peanuts')).toHaveClass('op-changed');
    expect(screen.getByText('shellfish')).toHaveClass('op-changed');

    // A CLEARED scalar is not silently "Not set" on both sides.
    expect(screen.getByText('haircuts and colour')).toBeInTheDocument();
    expect(screen.getByText('Cleared')).toBeInTheDocument();
    // …and exactly ONCE: "Cleared" is a statement about a removal, so it
    // belongs to the AFTER column of one and nowhere else (RB2-07).
    expect(screen.queryAllByText('Cleared')).toHaveLength(1);

    // And the two fields this operation does NOT touch are still shown, as
    // values, so "full effective state" means what §6.1 says it means.
    expect(screen.getAllByText('free parking')).toHaveLength(2);
    expect(screen.getAllByText('Thanks so much!')).toHaveLength(2);
    expect(screen.getAllByText('warm and brief')).toHaveLength(2);

    // Nothing is applied yet: the buttons are still the only way forward.
    expect(screen.getByRole('button', { name: APPLY })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: NOT_NOW })).toBeInTheDocument();
  });
});

describe('RequestedCapabilityCard', () => {
  it('requested capability card has no Apply button', () => {
    render(<RequestedCapabilityCard request="Stop replying on weekends" />);
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
    expect(screen.getByText(CANNOT_DO_YET)).toBeInTheDocument();
    // A separate KIND, not a Proposal with no button: the two travel under
    // separate response keys so a renderer cannot grow an Apply onto one.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

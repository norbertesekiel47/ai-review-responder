// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { OwnerConversationTurn } from '@/lib/agents/operator/reads';
import { renderSegments } from '@/lib/agents/operator/render';
import { TURN_STATUS, type StoredSegment } from '@/lib/agents/operator/schema';
import { TurnBody } from '../TurnBody';
import { CANNOT_DO_YET } from '../wording';

const LOCATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TURN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function renderStoredTurn(
  segments: StoredSegment[],
  unsupported: OwnerConversationTurn['unsupported'] = [],
) {
  const rendered = renderSegments(segments, { locations: [] });
  const turn: OwnerConversationTurn = {
    id: TURN,
    sequence: 1,
    status: TURN_STATUS.COMPLETED,
    failureReason: null,
    locationId: LOCATION,
    ownerText: 'Please change how replies work.',
    // Use the same pure read-path renderer as a resumed conversation GET.
    segments: rendered,
    refused: rendered.filter((segment) => segment.type === 'refusal'),
    proposals: [],
    unsupported,
  };
  return render(
    <TurnBody
      turn={turn}
      locationLabel={() => 'Salon'}
      currentScope={LOCATION}
      onChooseLocation={vi.fn()}
      onApply={vi.fn()}
      onDecline={vi.fn()}
      onRefreshPlan={vi.fn()}
      cardBusyId={null}
      cardErrors={{}}
    />,
  );
}

describe('stored Operator refusal cards', () => {
  it.each([
    ['invented_business_fact', 'inventing or claiming unverified business facts'],
    ['customer_data_exposure', 'exposing private customer information'],
    ['reviewer_disparagement', 'insulting, threatening or disparaging reviewers'],
    ['review_incentive', 'offering incentives in exchange for reviews'],
    ['review_edit_pressure', 'pressuring reviewers to edit or delete their reviews'],
    ['competitor_review_reply', 'replying to reviews on a competitor’s business profile'],
  ] as const)('renders the stored %s decision with its server-owned rule and no actions', (reason, clause) => {
    renderStoredTurn([{ type: 'refusal', reason, subjectId: SUBJECT }]);

    const card = screen.getByRole('group', { name: 'Policy refused' });
    expect(within(card).getByRole('heading', { name: 'RepWorth will not do this' })).toBeInTheDocument();
    expect(within(card).getByText(/RepWorth rules prohibit/)).toHaveTextContent(clause);
    expect(within(card).getByText('Nothing changed.')).toBeInTheDocument();
    // This rules out Apply, Decline/Not now, and any accidental new action.
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).queryByText(CANNOT_DO_YET)).not.toBeInTheDocument();
  });

  it('keeps multiple refusal cards at their stored positions between other segments', () => {
    const { container } = renderStoredTurn([
      { type: 'text', text: 'Here is what I can help with.' },
      { type: 'refusal', reason: 'review_incentive', subjectId: SUBJECT },
      { type: 'text', text: 'There is another part of your request.' },
      { type: 'refusal', reason: 'customer_data_exposure', subjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { type: 'question', text: 'Would you like to change your reply tone?' },
    ]);

    const children = Array.from(container.children);
    expect(children).toHaveLength(5);
    expect(children[0]).toHaveTextContent('Here is what I can help with.');
    expect(children[1]).toBe(screen.getAllByRole('group', { name: 'Policy refused' })[0]);
    expect(children[1]).toHaveTextContent('offering incentives in exchange for reviews');
    expect(children[2]).toHaveTextContent('There is another part of your request.');
    expect(children[3]).toBe(screen.getAllByRole('group', { name: 'Policy refused' })[1]);
    expect(children[3]).toHaveTextContent('exposing private customer information');
    expect(children[4]).toHaveTextContent('Would you like to change your reply tone?');
  });

  it('keeps a requested capability distinct from a policy refusal in the same turn', () => {
    renderStoredTurn(
      [{ type: 'refusal', reason: 'review_edit_pressure', subjectId: SUBJECT }],
      [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', request: 'Schedule a weekly report', context: 'Owner requested scheduling.' }],
    );

    const refusal = screen.getByRole('group', { name: 'Policy refused' });
    const unsupported = screen.getByRole('heading', { name: 'Schedule a weekly report' }).closest('section');
    expect(unsupported).not.toBeNull();
    expect(unsupported).toHaveTextContent(CANNOT_DO_YET);
    expect(refusal).not.toContainElement(unsupported);
    expect(unsupported).not.toHaveTextContent('RepWorth will not do this');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

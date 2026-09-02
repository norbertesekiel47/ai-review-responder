// @vitest-environment jsdom
//
// EditReplyDrawer shell + DrawerStateBody — one assertion set per DrawerState
// kind, with the hook mocked so each arm renders deterministically. The state
// machine itself is covered by edit-reply/__tests__/useEditReplyDraft.test.tsx;
// this suite pins that every state kind renders its panel and wires its
// actions, which is exactly the surface the drawer owns.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';

const { useEditReplyDraftMock, machine } = vi.hoisted(() => {
  const machine = {
    state: { kind: 'initial' } as { kind: string; [key: string]: unknown },
    isClosePending: false,
    tryClose: vi.fn(),
    actions: {
      startManualEdit: vi.fn(),
      startRegenerate: vi.fn(),
      submitManual: vi.fn(),
      publishExisting: vi.fn(),
      cancelDraft: vi.fn(),
      retryPosting: vi.fn(),
      resumeExistingDraft: vi.fn(),
      discardExistingDraft: vi.fn(),
      restoreOriginal: vi.fn(),
      resumePolling: vi.fn(),
      editFurther: vi.fn(),
      reset: vi.fn(),
    },
  };
  return { useEditReplyDraftMock: vi.fn(() => machine), machine };
});

vi.mock('@/components/dashboard/reviews/edit-reply/useEditReplyDraft', () => ({
  useEditReplyDraft: useEditReplyDraftMock,
}));
vi.mock('@/components/dashboard/reviews/edit-reply/useFocusTrap', () => ({
  useFocusTrap: () => ({ panelRef: { current: null } }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { closeBlockedReason, EditReplyDrawer } from '@/components/dashboard/reviews/EditReplyDrawer';

// jsdom has no <dialog> top-layer implementation. The stubs must still toggle
// the `open` attribute: without it the UA styles keep the dialog display:none
// and every role query inside it comes back empty.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  machine.isClosePending = false;
  vi.clearAllMocks();
});

const row: PastReplyRow = {
  review_id: 'rev-1',
  review_text: 'Lovely stay, will return.',
  review_date: '2026-08-01',
  reviewer_name: 'Dana',
  star_rating: 5,
  response_id: 'resp-1',
  approved_text: 'Thank you, Dana!',
  approval_method: 'owner',
  posted_at: '2026-08-02',
  external_reply_ingested_at: null,
  reply_state: 'posted',
  row_action: 'regenerate',
};

function renderDrawer(state: typeof machine.state, canEdit = true) {
  machine.state = state;
  return render(
    <EditReplyDrawer open={true} onClose={vi.fn()} row={row} canEdit={canEdit} />,
  );
}

describe('EditReplyDrawer shell', () => {
  it('always shows the review snapshot and the current Google reply', () => {
    renderDrawer({ kind: 'initial' });
    expect(screen.getByText('Customer review')).toBeInTheDocument();
    expect(screen.getByText('Lovely stay, will return.')).toBeInTheDocument();
    expect(screen.getByText('Current Google reply')).toBeInTheDocument();
    expect(screen.getByText('Thank you, Dana!')).toBeInTheDocument();
  });

  it('routes backdrop and close-button clicks through tryClose (the draft guard)', () => {
    renderDrawer({ kind: 'initial' });
    fireEvent.click(screen.getByLabelText('Close drawer'));
    fireEvent.click(screen.getByLabelText('Close'));
    expect(machine.tryClose).toHaveBeenCalledTimes(2);
  });

  // UX audit D15: the blocked-close reason is visible text, not a tooltip.
  it('disables close and shows the blocked reason as visible text while a draft is in flight', () => {
    machine.isClosePending = true;
    renderDrawer({ kind: 'creating_draft' });
    const close = screen.getByLabelText('Close (disabled while draft is being created)');
    expect(close).toBeDisabled();
    expect(close).not.toHaveAttribute('title');
    expect(screen.getByRole('status')).toHaveTextContent('Hang on — setting up your draft.');
  });

  it('explains the regenerating wait in plain language, with no worker jargon', () => {
    machine.isClosePending = true;
    renderDrawer({ kind: 'regenerating', outboxId: 'ob-1' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Still writing your reply — this usually takes under a minute.',
    );
    expect(screen.queryByText(/worker|polling/i)).toBeNull();
    expect(closeBlockedReason('preview')).toBeUndefined();
  });
});

describe('DrawerStateBody arms', () => {
  it('initial + canEdit shows the disclosure and both entry actions', () => {
    renderDrawer({ kind: 'initial' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit manually' }));
    expect(machine.actions.startManualEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate with AI' }));
    expect(machine.actions.startRegenerate).toHaveBeenCalled();
  });

  it('initial without canEdit renders no entry actions', () => {
    renderDrawer({ kind: 'initial' }, false);
    expect(screen.queryByRole('button', { name: 'Edit manually' })).toBeNull();
  });

  it('editing renders the manual editor prefilled and wires cancel + submit', () => {
    renderDrawer({ kind: 'editing', text: 'Draft text', draftResponseId: 'd-1' });
    expect(screen.getByDisplayValue('Draft text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(machine.actions.cancelDraft).toHaveBeenCalledWith('d-1');
    fireEvent.click(screen.getByRole('button', { name: 'Update on Google' }));
    expect(machine.actions.submitManual).toHaveBeenCalledWith('Draft text', 'd-1');
  });

  it('creating_draft and regenerating show the generation notice', () => {
    renderDrawer({ kind: 'creating_draft' });
    expect(screen.getByText(/Generating a fresh draft/)).toBeInTheDocument();
    renderDrawer({ kind: 'regenerating', outboxId: 'ob-1' });
    expect(screen.getAllByText(/Generating a fresh draft/).length).toBeGreaterThan(0);
  });

  it('regenerate_poll_error explains the paused close in owner terms and offers Check again', () => {
    renderDrawer({ kind: 'regenerate_poll_error', outboxId: 'ob-1', message: 'Polling hiccup.' });
    expect(screen.getByText('Polling hiccup.')).toBeInTheDocument();
    expect(screen.getByText(/closing is paused until the draft arrives/i)).toBeInTheDocument();
    expect(screen.queryByText(/worker/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(machine.actions.resumePolling).toHaveBeenCalled();
  });

  it('preview wires publish-as-is, edit-further, and discard', () => {
    renderDrawer({ kind: 'preview', draftResponseId: 'd-2', text: 'Fresh draft' });
    expect(screen.getByText('Fresh draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update on Google' }));
    expect(machine.actions.publishExisting).toHaveBeenCalledWith('d-2');
    fireEvent.click(screen.getByRole('button', { name: 'Edit further' }));
    expect(machine.actions.editFurther).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(machine.actions.cancelDraft).toHaveBeenCalledWith('d-2');
  });

  it('publishing shows the posting notice', () => {
    renderDrawer({ kind: 'publishing' });
    expect(screen.getByText('Posting to Google…')).toBeInTheDocument();
  });

  it('recovery hides Restore for delete_failed_* and wires both CTAs for orphans', () => {
    const first = renderDrawer({ kind: 'recovery', failedResponseId: 'f-1', failedPostingError: 'delete_failed_timeout' });
    expect(screen.queryByRole('button', { name: /restore/i })).toBeNull();
    first.unmount();

    renderDrawer({
      kind: 'recovery',
      failedResponseId: 'f-1',
      failedPostingError: 'post_after_delete_failed_timeout',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry posting' }));
    expect(machine.actions.retryPosting).toHaveBeenCalledWith('f-1');
    fireEvent.click(screen.getByRole('button', { name: 'Restore original' }));
    expect(machine.actions.restoreOriginal).toHaveBeenCalledWith('f-1');
  });

  it('review_changed renders the changed-review panel', () => {
    renderDrawer({ kind: 'review_changed', currentText: 'The review says something new now.' });
    expect(screen.getByText('The review says something new now.')).toBeInTheDocument();
  });

  it('draft_conflict renders the existing draft and wires resume/discard', () => {
    const existing = { responseId: 'r-9', text: 'Parked draft', isEdited: false, status: 'draft' };
    renderDrawer({ kind: 'draft_conflict', existing });
    expect(screen.getByText('Parked draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(machine.actions.resumeExistingDraft).toHaveBeenCalledWith(existing);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(machine.actions.discardExistingDraft).toHaveBeenCalledWith('r-9');
  });

  it('error offers Try again wired to reset, as tappable .btn controls (UX audit D13)', () => {
    renderDrawer({ kind: 'error', message: 'Something broke.' });
    expect(screen.getByText('Something broke.')).toBeInTheDocument();
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgain).toHaveClass('btn');
    // The header has its own icon Close; the panel's text Close is the .btn one.
    const panelClose = screen.getAllByRole('button', { name: 'Close' }).find((button) => button.textContent === 'Close');
    expect(panelClose).toHaveClass('btn', 'btn-tertiary');
    fireEvent.click(tryAgain);
    expect(machine.actions.reset).toHaveBeenCalled();
  });

  it('success offers Close editor', () => {
    renderDrawer({ kind: 'success', message: 'Reply updated on Google.' });
    expect(screen.getByText('Reply updated on Google.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close editor' })).toBeInTheDocument();
  });
});

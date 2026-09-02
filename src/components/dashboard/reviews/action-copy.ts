// action-copy — owner-facing copy for a failed queue action (UX audit D12).
//
// The dashboard action routes answer with machine codes (`past_due_read_only`,
// `held_for_review`, `conflict_retry`, …) or with internal sentences ("Response
// is no longer pending approval (current status: superseded)"). Neither belongs
// on an owner's screen. This maps what the server said to what the owner should
// read, and falls back to "Couldn't <verb> — try again." for anything unknown.

export type DraftAction = 'approve' | 'edit' | 'regenerate';

export interface ActionFailure {
  status: number;
  /** The server's `error` field — a code, or an internal sentence. */
  code?: string;
}

/** Result of mapping a failure: the copy, and whether the row is stale and should refetch. */
export interface ActionFailureCopy {
  message: string;
  /** True when the server says the draft already moved on — the list should refresh. */
  stale: boolean;
}

const ACTION_VERB: Record<DraftAction, string> = {
  approve: 'approve',
  edit: 'save',
  regenerate: 'regenerate',
};

const CODE_COPY: Record<string, string> = {
  past_due_read_only: 'Your account is past due — update billing to change replies.',
  subscription_inactive: "Your subscription isn't active — update billing to continue.",
  account_offboarding_blocked: "Your account is closing, so replies can't be changed.",
  no_business: "We couldn't find this location on your account.",
  held_for_review: "This reply is being checked by our team. We'll let you know when it's ready.",
  rate_limited: 'Too many requests — give it a moment and try again.',
  conflict_retry: 'Something else was updating this reply — try again.',
};

export function describeActionFailure(action: DraftAction, failure: ActionFailure): ActionFailureCopy {
  const code = failure.code ?? '';
  const known = CODE_COPY[code];
  if (known) return { message: known, stale: false };

  if (failure.status === 400) {
    // The edit route's validation: an empty or over-long reply.
    return { message: 'Your reply needs some text — up to 2000 characters.', stale: false };
  }
  if (failure.status === 401) {
    return { message: 'Your session has expired — sign in again to continue.', stale: false };
  }
  // 404 = no actionable draft; 409 = the draft is no longer pending (already
  // approved, superseded, or its location archived). Either way the row on
  // screen is stale, and the refreshed list is the honest answer.
  if (failure.status === 404 || failure.status === 409) {
    return { message: 'This reply was already handled — refreshing your queue.', stale: true };
  }

  return { message: `Couldn't ${ACTION_VERB[action]} — try again.`, stale: false };
}

// The Operator screen's VOCABULARIES: the fixed notices, the §1 proposal
// labels, the five voice-field labels, and one sentence per member of every
// token set the SERVER writes — `TURN_FAILURE_REASON`,
// `PROPOSAL_FAILURE_REASON` and the route error codes. Each map has an explicit
// fallback, so a token this file has not met yet reads as a sentence rather
// than as a blank card.
//
// It does NOT own every string on the screen: a sentence that is written once,
// beside the only markup that can render it, stays there (F4). What lives here
// is what more than one renderer has to agree on, or what a test has to name.
//
// No `'use client'`: the server page imports the title, and a directive here
// would pull the whole file across the client boundary for no reason.
// `src/components/dashboard/shell/active-nav.ts:1-13` is the in-repo precedent
// for a shared, directive-free module both sides import.
import type { LabelKind } from '@/lib/agents/operator/catalog';
import type { VoiceState } from '@/lib/agents/operator/schema';
import type { AutoApprovalReadinessBlockReason } from '@/lib/auto-approval/types';

export const OPERATOR_TITLE = 'Operator';
export const OPERATOR_SUBTITLE = 'Tell RepWorth what to change. Nothing happens until you approve it.';

export const PREPARING = 'Preparing your plan';
export const TIMEOUT_NOTICE =
  'This is taking longer than it should. Your message is safe — you can keep waiting, or start again.';
export const KEEP_WAITING = 'Keep waiting';
export const START_NEW_CONVERSATION = 'Start a new conversation';
export const NOT_AVAILABLE = 'The Operator is not available right now. Nothing was changed.';

export const ALL_LOCATIONS_HINT =
  'Pick one location to start. Each card names the scope it changes.';
export const COMPOSER_PLACEHOLDER = 'Ask for a change, or ask what needs you.';
export const SEND = 'Send';
export const SENDING = 'Sending…';
/**
 * The retry after a lost response. Deliberately NOT "Send again": the same
 * payload and the same `clientTurnKey` go back, so the server returns the
 * original turn rather than creating a second one, and the label must not
 * suggest a new message (RB-05).
 */
export const RETRY_SEND = 'Try again';

/**
 * A `status` **Reply segment**'s metric, in words, with its reporting period.
 * Total over `STATUS_METRICS` so a new metric fails typecheck here rather than
 * rendering a bare number with no noun beside it.
 */
export function statusMetricLabel(metric: string, reportingPeriodDays: number): string {
  switch (metric) {
    case 'pending_count': return 'replies are waiting for you';
    case 'drafts_waiting': return 'drafts are waiting across your locations';
    case 'posted_7d': return `replies posted in the last ${reportingPeriodDays} days`;
    default: return 'recorded';
  }
}

/** The three fixed starter messages (spec §3.1). */
export const STARTER_ACTIONS = [
  { id: 'set_up_replies', label: 'Set up replies', message: 'Help me set up how my replies should sound.' },
  { id: 'change_my_tone', label: 'Change my tone', message: 'I want to change the tone of my replies.' },
  { id: 'show_what_needs_me', label: 'Show what needs me', message: 'Show me what needs my attention right now.' },
] as const;

/**
 * One sentence per `TURN_FAILURE_REASON` member. Each key is a token
 * the worker wrote; none of these is ever a provider message or owner text.
 */
export const TURN_FAILURE_WORDING: Readonly<Record<string, string>> = {
  operator_disabled: NOT_AVAILABLE,
  unauthorized: 'Your account can no longer make changes here, so this message was not run. Nothing was changed.',
  account_offboarding: 'This account is closing, so the Operator has stopped. Nothing was changed.',
  predecessor_stalled: 'An earlier message in this conversation never finished, so this one was not run. Start a new conversation to carry on.',
  model_output_invalid: 'The answer came back in a form we could not use. Nothing was changed — try asking again in your own words.',
  budget_exceeded: 'This account has reached its daily limit for AI work. Nothing was changed — try again tomorrow.',
  exhausted: 'We tried several times and could not finish this message. Nothing was changed. Start a new conversation to try again.',
  dispatch_exhausted: 'We could not start this message after several attempts. Nothing was changed. Start a new conversation to try again.',
};

const TURN_FAILURE_FALLBACK = 'That message did not finish. Nothing was changed — try again.';

/**
 * Which failures are worth offering a fresh conversation for. These are
 * conversation-level dead ends: a stalled predecessor blocks every successor in
 * the SAME conversation, and an exhausted turn has already been retried.
 */
export const OFFERS_NEW_CONVERSATION: ReadonlySet<string> = new Set([
  'predecessor_stalled',
  'exhausted',
  'dispatch_exhausted',
]);

/**
 * THE THREE-WAY CONTRACT of spec §1, which every Proposal card carries: what
 * KIND of thing the card is, before and after it is applied.
 *
 * | before Apply     | after success   | meaning                              |
 * | Proposed rule    | Active rule     | behaviour the engine enforces        |
 * | Fact to remember | Remembered fact | context a named workflow reads       |
 *
 * The applied half replaces the bare word "Applied": §1 exists to let the
 * owner tell a rule the engine ENFORCES from a fact a workflow READS, and a
 * generic past participle answers neither question. Keyed by `LabelKind`, so a
 * third kind fails typecheck here rather than rendering an empty chip.
 */
export const PROPOSAL_LABEL_PENDING: Readonly<Record<LabelKind, string>> = {
  rule: 'Proposed rule',
  fact: 'Fact to remember',
};

export const PROPOSAL_LABEL_APPLIED: Readonly<Record<LabelKind, string>> = {
  rule: 'Active rule',
  fact: 'Remembered fact',
};

/**
 * The five voice fields, in ONE canonical order, owned HERE because two
 * renderers show them: the Proposal card's before/after diff and the Receipt's
 * before/after record. Spelling them twice let the two drift — the Receipt
 * printed "3 saved" where the card listed the sample replies, so the document
 * that §6.5 says "establishes that something changed" disagreed with the card
 * the owner had just read (F4).
 *
 * `satisfies` ties every `field` to a real `VoiceState` key while `as const`
 * keeps the literals, so a renaming of the stored shape fails typecheck here.
 */
export const VOICE_FIELD_LABELS = [
  { field: 'tone', label: 'Tone' },
  { field: 'productsServices', label: 'Products and services' },
  { field: 'avoidFacts', label: 'Keep out of replies' },
  { field: 'highlightFacts', label: 'Highlight when it fits' },
  { field: 'sampleResponses', label: 'Sample replies' },
] as const satisfies readonly { field: keyof VoiceState; label: string }[];

export const PROPOSAL_STALE =
  'Your settings changed after this plan was prepared, so it was not applied.';
export const REFRESH_PLAN = 'Refresh plan';
export const PROPOSAL_DECLINED = 'Not applied';
export const PROPOSAL_SUPERSEDED = 'Replaced by a newer plan';
export const APPLY = 'Apply';
export const NOT_NOW = 'Not now';
export const AFFECTS_FUTURE_DRAFTS =
  'Future drafts only. Existing drafts and pending approvals are not rewritten.';
export const AFFECTS_FUTURE_ELIGIBLE_REVIEWS =
  'Future eligible reviews. Drafts already granted a veto window keep it.';
export const READINESS_WORDING: Readonly<Record<AutoApprovalReadinessBlockReason, string>> = {
  auto_approval_disabled: 'Auto-reply is not enabled yet.',
  autopilot_unavailable: 'Autopilot must be available on this account before auto-reply can expand.',
  provider_moderation_disabled: 'Reply safety checks must be enabled before auto-reply can expand.',
  provider_moderation_not_validated: 'Reply safety checks have not finished verification yet.',
  subscription_not_writable: 'This account cannot change its auto-reply settings right now.',
  policy_suspended: 'Auto-reply is paused for this scope. It cannot expand while paused.',
  preview_environment: 'Auto-reply cannot expand in this preview environment.',
  impersonation_not_allowed: 'You are viewing this account as an admin, so you cannot apply changes.',
};
export const CANNOT_DO_YET = 'RepWorth cannot do this yet. Nothing changed.';

/**
 * THE TWO "THE ACTOR MAY NO LONGER WRITE" SENTENCES, named because two maps
 * have to agree on them: the stored `PROPOSAL_FAILURE_REASON` the card repaints
 * from, and the 409 `apply/route.ts` returns for the same refusal. One refusal,
 * one sentence — spelling them twice let the live answer and the stored record
 * drift apart, which is the same reason `PROPOSAL_STALE` is a constant (F4).
 */
const ACTOR_UNAUTHORIZED =
  'Your account can no longer make this change. Nothing was applied.';
const ACCOUNT_OFFBOARDING =
  'This account is closing, so changes are not accepted. Nothing was applied.';

const PROPOSAL_FAILURE_WORDING: Readonly<Record<string, string>> = {
  expansion_blocked: 'Auto-reply could not expand because a readiness check was not met. Nothing was applied.',
  location_inactive: 'That location is archived, so this change cannot be applied.',
  version_mismatch: PROPOSAL_STALE,
  contract_changed: 'RepWorth changed since this plan was prepared, so it must be prepared again. Nothing was applied.',
  unauthorized: ACTOR_UNAUTHORIZED,
  account_offboarding: ACCOUNT_OFFBOARDING,
  location_not_found: 'That location is no longer active, so the plan cannot be applied.',
  write_failed: 'We could not save that change. Nothing was applied.',
};

/** The two failure reasons a fresh plan can actually fix. */
export const OFFERS_REFRESH_PLAN: ReadonlySet<string> = new Set([
  'version_mismatch',
  'contract_changed',
]);

/**
 * The sentence for a `?locationId=` the account cannot use — archived, or
 * never theirs. Its OWN sentence, not the empty screen `conversation_not_found`
 * gets: that one is the normal state of an owner who has not spoken yet, while
 * this one is a screen whose summary, connect call to action and composer all
 * refer to a location that is gone (S7).
 */
export const LOCATION_UNAVAILABLE =
  'That location is no longer available. Pick another location.';

/** Route error codes the card and the composer have to speak. */
export const ROUTE_ERROR_WORDING: Readonly<Record<string, string>> = {
  confirmation_mismatch: 'Type the scope exactly as shown on the card, then confirm again. Nothing was applied.',
  expansion_blocked: PROPOSAL_FAILURE_WORDING.expansion_blocked!,
  location_inactive: PROPOSAL_FAILURE_WORDING.location_inactive!,
  operator_disabled: NOT_AVAILABLE,
  impersonation_not_allowed: 'You are viewing this account as an admin, so you cannot apply changes.',
  // The two 409 reasons `apply/route.ts` returns when the ACTOR can no longer
  // write. Without them the card showed the generic "try again" fallback beside
  // its own state line saying the change can never be made (S6). The SAME
  // constants the stored-reason map above reads, so the live refusal and the
  // durable record cannot disagree.
  unauthorized: ACTOR_UNAUTHORIZED,
  account_offboarding: ACCOUNT_OFFBOARDING,
  proposal_not_found: 'That plan is no longer available.',
  proposal_not_pending: 'That plan has already been decided.',
  proposal_stale: PROPOSAL_STALE,
  contract_changed: 'RepWorth changed since this plan was prepared, so it must be prepared again. Nothing was applied.',
  apply_failed: 'Something went wrong and nothing was applied. Try again.',
  decline_failed: 'Something went wrong. Try again.',
  turn_create_failed: 'We could not send that message. Nothing was changed — try again.',
  turn_key_conflict: 'That message was already sent with different wording. Start a new conversation.',
  location_not_found: 'That location is no longer active.',
  conversation_not_found: 'That conversation is no longer available.',
  forbidden: 'We could not confirm that request came from this page. Reload and try again.',
  invalid_body: 'We could not send that. Reload the page and try again.',
};

const ROUTE_ERROR_FALLBACK = 'Something went wrong. Nothing was changed — try again.';

export function routeErrorSentence(code: string | null): string {
  if (code === null) return ROUTE_ERROR_FALLBACK;
  return ROUTE_ERROR_WORDING[code] ?? ROUTE_ERROR_FALLBACK;
}

export function turnFailureSentence(reason: string | null): string {
  if (reason === null) return TURN_FAILURE_FALLBACK;
  return TURN_FAILURE_WORDING[reason] ?? TURN_FAILURE_FALLBACK;
}

export function proposalFailureSentence(reason: string | null): string {
  if (reason === null) return PROPOSAL_DECLINED;
  return PROPOSAL_FAILURE_WORDING[reason] ?? ROUTE_ERROR_FALLBACK;
}

/** D4, exactly this sentence. */
export function preparedForNote(locationLabel: string): string {
  return `Prepared for ${locationLabel}`;
}

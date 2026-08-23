'use client';

// The admin arm of the Halt latch, on /admin/businesses/[id] (#865, plan §3.4).
// Modelled on PastDueExtensionPanel: one form submit, an onChanged callback so
// the page re-reads rather than this panel guessing the new state. Since #880
// both share `useAdminActionForm` instead of each keeping a private copy of the
// same reducer — the modelling became a seam.
//
// COPY DISCIPLINE (CONTEXT.md **Halt latch**). "stop" is the ONE carved-out
// owner-facing synonym for `halt`; `pause`, `resume` and `cancel batch` are
// banned everywhere INCLUDING copy, because each implies a reversibility the
// latch does not have. Code-level names stay on the term — the mode member
// below is `haltable`, not `stoppable`.
//
// The panel, not the route, turns a refusal discriminant into a sentence. That
// is the deliberate house split (plan §3.3): the route stays an explicit
// whitelist of wire fields, and the owner-side `ApprovalPanel.refusalCopy` maps
// `not_haltable` / `not_found` to prose in the component. This file is the
// admin equivalent — `refusalCopy` below — because the alternative is what
// round 1 found: `json.status` printed verbatim, so an operator on a stale
// server-rendered page read `not_haltable` in the red paragraph.
//
// The three counts are rendered SEPARATELY and never summed. A stop cancels the
// `rendered` and `queued` rows and does NOT recall a row already `sending`; a
// single folded "live outreach" number (plan round 1, finding 8) would have
// presented the in-flight row as part of the stop's reach, which is the one
// thing the latch deliberately cannot do.

import { FormEvent, ReactNode } from 'react';
import { formatAdminDateTime } from '@/components/admin/ui/format';
import type { AdminHaltBatchResult } from '@/lib/solicitation/approval';
import type { AdminBatchSummary, HaltReason } from '@/lib/solicitation/batch-view';
import type { BatchState } from '@/lib/solicitation/outreach';
import { useAdminActionForm } from '@/hooks/useAdminActionForm';

interface SolicitationBatchPanelProps {
  accountId: string;
  businessId: string;
  /** `null` when the location has never built a batch. */
  summary: AdminBatchSummary | null;
  /** Fired after any 2xx — the panel's data is stale either way. */
  onHalted: () => void;
}

/**
 * Exhaustive over the read side's six reasons, so a reason added to
 * `HaltReason` is a compile error here rather than a blank cell. Four of the six
 * are not owner-caused, which is why none of these say "you".
 *
 * `platform_halt` and `send_window_elapsed` are the SAME 72h window (#917) and
 * the label has to keep them distinguishable at a glance: an admin scanning a
 * location's history needs to know instantly whether this cancellation was one
 * account's timing or the whole platform being stopped.
 */
const HALT_REASON_LABELS: Record<HaltReason, string> = {
  owner_veto: 'Owner stopped it inside the veto window',
  owner_halt: 'Owner stopped it',
  admin_halt: 'RepWorth support stopped it',
  send_window_elapsed: 'Send window elapsed',
  batch_expired: 'Approval window expired',
  platform_halt: 'Send window elapsed under a platform halt',
};

/**
 * Why the latch refuses, per **Batch state** — `null` for every state it
 * accepts. TOTAL over `BatchState` for the same reason `HALT_REASON_LABELS`
 * above is total over `HaltReason`: this map is a hand-mirror of
 * `adminHaltBatch`'s guard ladder in `src/lib/solicitation/approval.ts`, and a
 * state added to the union with no answer here would silently keep offering a
 * stop control whose only possible outcome is a 409. `null` is the "actionable"
 * answer, and `haltable` is DERIVED from it — one map, so the panel cannot
 * disagree with itself about which states are actionable.
 *
 * `pending` is D11 and is the non-obvious member: latching an unbuilt batch
 * satisfies migration 091's halt-consistency CHECK through its
 * `built_at IS NULL` arm, and then collides with the builder's later
 * `built_at` stamp. `halted` and `closed` are the ordinary terminal pair.
 *
 * Read TWICE: here for the render, and by `notHaltableCopy` for the server's
 * own 409 — so the two can never disagree about what a state means.
 */
const NON_ACTIONABLE_COPY: Readonly<Record<BatchState, string | null>> = {
  pending: 'This batch is still building. The stop control appears once it is built.',
  halted:
    'This batch is already stopped. There is no way back — reaching these contacts again means building a new batch.',
  closed: 'This batch is closed. Every message in it has settled.',
  built: null,
  expired: null,
  approved: null,
  veto_window: null,
  sending: null,
};

/**
 * The route's discriminant, named rather than restated. `AdminHaltWire.status`
 * is typed `AdminHaltBatchResult['status']` precisely so the wire contract stays
 * closed; taking the same type here is what makes a renamed or added status a
 * `tsc` error in the two tables below instead of a sentence claiming a stop
 * that never happened.
 */
type AdminHaltStatus = AdminHaltBatchResult['status'];

/** For a `state` this build does not know — a server deployed ahead of the
 *  browser — and for the states the panel believes are actionable but the
 *  server has just refused. It claims only what every arm has in common. */
const NOT_HALTABLE_FALLBACK =
  'This batch can no longer be stopped. Reload the page to see where it stands.';

const GENERIC_REFUSAL = 'Something went wrong. Nothing changed — try again.';

/** The gate refused before the route reached the latch. Its body carries
 *  `mfa_required` / `mfa_check_failed`, which are diagnostics, not copy. */
const REAUTH_REFUSAL =
  'Your admin session needs re-verifying. Reload the page, complete the step-up, then try again.';

/**
 * What an operator reads when the write did not settle as done. Total over the
 * route's closed discriminant, no `default`, so a fifth status has to say what
 * an operator reads. `null` marks the two statuses a 2xx carries: those
 * settled, and `successCopy` speaks for them.
 *
 * Every sentence is prose — a discriminant reaching this paragraph is the
 * round-1 defect this table exists to close.
 */
const HALT_REFUSAL_COPY: Readonly<Record<AdminHaltStatus, string | null>> = {
  halted: null,
  already_halted: null,
  // The sentence comes from the `state` the 409 carries (`notHaltableCopy`);
  // this entry is the fallback the record's total shape still requires.
  not_haltable: NOT_HALTABLE_FALLBACK,
  not_found:
    'We can no longer reach this batch. Reload the page to see where this location stands.',
};

/** A discriminant this build knows, or `null` for anything else on the wire.
 *  `in`-checking the table's OWN keys keeps `toString` and friends off the
 *  lookup path — the same trick `ApprovalPanel.toLaneStatus` uses. */
function toHaltStatus(value: unknown): AdminHaltStatus | null {
  return typeof value === 'string' && Object.hasOwn(HALT_REFUSAL_COPY, value)
    ? (value as AdminHaltStatus)
    : null;
}

/** The refused state, narrowed against the copy record's OWN keys. This is
 *  only sound because that record is TOTAL over `BatchState`. */
function toBatchState(value: unknown): BatchState | null {
  return typeof value === 'string' && Object.hasOwn(NON_ACTIONABLE_COPY, value)
    ? (value as BatchState)
    : null;
}

/** Why the server refused a stop, told from the state it returned: `pending` is
 *  still building, `closed` has settled. The operator got here from a page
 *  server-rendered before the batch moved, so every arm ends by sending them to
 *  the state that is now true. */
function notHaltableCopy(state: BatchState | null): string {
  const why = state === null ? null : NON_ACTIONABLE_COPY[state];
  return why === null ? NOT_HALTABLE_FALLBACK : `${why} Nothing changed — reload the page.`;
}

/**
 * The copy for a refusal. `httpStatus` is the last resort, for the responses
 * that never reach the domain union at all: the AAL2 gate (401/403) and
 * `internalError` (500) answer with a diagnostic in `error`, which is not a
 * sentence an operator can act on.
 */
function refusalCopy(
  status: AdminHaltStatus | null,
  state: BatchState | null,
  httpStatus: number,
): string {
  // The one refusal whose sentence depends on a second field. Branching here
  // rather than in the record keeps `HALT_REFUSAL_COPY` a flat total map.
  if (status === 'not_haltable') return notHaltableCopy(state);
  const known = status === null ? null : HALT_REFUSAL_COPY[status];
  if (known !== null) return known;
  return httpStatus === 401 || httpStatus === 403 ? REAUTH_REFUSAL : GENERIC_REFUSAL;
}

/**
 * What a 2xx announces, exhaustive over the same discriminant — and `null` for
 * a status this build cannot read. The `=== 'already_halted' ? … : …` this
 * replaces sent every other status, known or not, to "Batch stopped. 0 queued
 * message(s) cancelled." for a call that stopped nothing.
 */
function successCopy(status: AdminHaltStatus | null, cancelledCount: number): string | null {
  switch (status) {
    case 'halted':
      return `Batch stopped. ${cancelledCount} queued message(s) cancelled.`;
    case 'already_halted':
      return 'This batch was already stopped; nothing changed.';
    case 'not_haltable':
    case 'not_found':
    case null:
      // A refusal discriminant on a 2xx, or one added since this bundle
      // shipped. Either way the panel must not narrate a stop.
      return null;
  }
}

/** A 2xx whose discriminant this build cannot read. It claims nothing in either
 *  direction — the write may well have landed — and `onHalted` still fires, so
 *  the page re-reads underneath the sentence. */
const UNREADABLE_SUCCESS =
  'The server answered in a way this page does not understand. Reload to see whether the batch was stopped.';

interface HaltFields {
  note: string;
}

/** Exactly the route's `strictObject`. A fifth field is a 400, and no field of
 *  it may name the halt reason — that is fixed by the route's identity. */
interface AdminHaltRequest {
  accountId: string;
  businessId: string;
  batchId: string;
  note: string;
}

/**
 * The route's `toWire` projection, narrowed to what this panel reads. The two
 * discriminants stay `unknown` because `res.json()` is a wire read, not a typed
 * call: they are narrowed against the copy tables' own keys, so the closed
 * union is enforced AT the boundary rather than asserted over it. `error` is
 * deliberately absent — the only bodies carrying one are the gate's and
 * `internalError`'s, and neither writes operator copy.
 */
interface AdminHaltResponse {
  status?: unknown;
  state?: unknown;
  /** Whitelisted by the route on the `halted` arm only. */
  cancelledCount?: number;
}

export function SolicitationBatchPanel({
  accountId,
  businessId,
  summary,
  onHalted,
}: SolicitationBatchPanelProps) {
  // The success carries the announced outcome sentence, so `TOutcome` is
  // `string`. An unreadable 2xx is a `fail`, not a `succeed` with empty copy —
  // the panel must not claim a stop it cannot read.
  const form = useAdminActionForm<HaltFields, string>({ note: '' });
  const { note } = form.fields;
  const { error, outcome: message, busy: submitting } = form;

  if (!summary) {
    return (
      <PanelShell>
        <p className="mt-1 text-sm text-gray-700">
          No send batch on file for this location.
        </p>
      </PanelShell>
    );
  }

  // `haltable`, not `stoppable`: the copy carve-out is one word wide and does
  // not reach identifiers (CONTEXT.md **Halt latch**). Derived from the single
  // refusal map, never from a second list of states.
  const whyNotHaltable = NON_ACTIONABLE_COPY[summary.batchState];
  const haltable = whyNotHaltable === null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Cleared BEFORE validating, exactly as `submitReset` was: an empty-note
    // refusal must show while the button still reads "Stop this batch".
    form.clearOutcome();

    const trimmed = note.trim();
    if (trimmed.length === 0) {
      form.fail('Say why you are stopping this batch.');
      return;
    }
    // Unreachable — the form only renders for a haltable batch — but the body
    // needs a batch id and narrowing it here beats a non-null assertion.
    if (!summary) return;

    const body: AdminHaltRequest = {
      accountId,
      businessId,
      batchId: summary.batchId,
      note: trimmed,
    };

    await form.run(async () => {
      try {
        const res = await fetch('/api/admin/solicitation/batch/halt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as AdminHaltResponse;
        const status = toHaltStatus(json.status);

        if (!res.ok) {
          if (status === null) {
            // The gate, an internal error, or a contract newer than this bundle.
            // Worth a devtools line; never the operator's paragraph.
            console.error(`[SolicitationBatchPanel] halt refused with HTTP ${res.status}`);
          }
          form.fail(refusalCopy(status, toBatchState(json.state), res.status));
          return;
        }

        const announced = successCopy(status, json.cancelledCount ?? 0);
        if (announced === null) {
          form.fail(UNREADABLE_SUCCESS);
        } else {
          form.succeed(announced);
          form.patch({ note: '' });
        }
        onHalted();
      } catch (err) {
        console.error('[SolicitationBatchPanel] halt failed:', err);
        form.fail('Failed to stop the batch.');
      }
    });
  }

  return (
    <PanelShell>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-gray-500">State</dt>
          <dd className="font-medium text-gray-900">
            {summary.batchState.replace(/_/g, ' ')}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Built</dt>
          <dd className="text-gray-900">{formatAdminDateTime(summary.builtAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Approved</dt>
          <dd className="text-gray-900">{formatAdminDateTime(summary.approvedAt)}</dd>
        </div>
        {summary.haltedAt && (
          <div className="flex gap-1">
            <dt className="text-gray-500">Stopped</dt>
            <dd className="text-gray-900">
              {formatAdminDateTime(summary.haltedAt)}
              {summary.haltReason && ` — ${HALT_REASON_LABELS[summary.haltReason]}`}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <CountTile
          testId="admin-batch-cancellable-count"
          label="A stop cancels"
          value={summary.cancellableCount}
          hint="Rendered and queued messages."
        />
        <CountTile
          testId="admin-batch-sending-count"
          label="In flight"
          value={summary.sendingCount}
          hint="Already handed to the provider. A stop does not reach these."
        />
        <CountTile
          testId="admin-batch-sent-count"
          label="Delivered"
          value={summary.sentCount}
          hint="Already sent. Nothing can take these back."
        />
      </div>

      {!haltable ? (
        <p className="mt-4 text-sm text-gray-700">{whyNotHaltable}</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-gray-700">
            Stopping ends this batch permanently — there is no way back, and reaching
            these contacts again means building a new batch. It cancels the{' '}
            {summary.cancellableCount} rendered and queued message(s) only; the{' '}
            {summary.sendingCount} already in flight will still arrive, and the{' '}
            {summary.sentCount} already delivered are untouched.
          </p>
          <form
            onSubmit={handleSubmit}
            className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
          >
            <label className="grid gap-1 text-sm font-medium text-gray-700">
              Note (why support is stopping this batch)
              <input
                type="text"
                value={note}
                onChange={(event) => form.set('note', event.target.value)}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
                required
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Stopping…' : 'Stop this batch'}
            </button>
          </form>
        </>
      )}

      {message && <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </PanelShell>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900">Send batch</h2>
      <p className="mt-1 text-sm text-gray-500">
        This location&rsquo;s live solicitation send batch, or its most recent batch when
        none is live. Requires AAL2 and writes an account audit log entry.
      </p>
      {children}
    </section>
  );
}

/** The count and nothing else inside the test-id element — the panel must never
 *  be readable as "2 + 1 = 3 messages a stop reaches". */
function CountTile({
  testId,
  label,
  value,
  hint,
}: {
  testId: string;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div
        data-testid={testId}
        className="mt-1 text-xl font-semibold tabular-nums text-gray-900"
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-gray-500">{hint}</div>
    </div>
  );
}

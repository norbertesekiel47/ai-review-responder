'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LiveRegion } from '@/components/ui/LiveRegion';

interface Rate {
  numerator: number;
  denominator: number;
  rate: number;
}

interface FlagEvidence {
  id: string;
  businessId: string;
  reviewId: string;
  responseId: string;
  reasons: string[];
  createdAt: string;
}

interface SuspensionItem {
  policyId: string;
  accountId: string;
  accountName: string;
  locationId: string | null;
  locationName: string | null;
  scope: 'account' | 'location';
  suspendedReason: string | null;
  trigger: string | null;
  suspendedAt: string;
  governorRates: {
    edit: Rate;
    veto: Rate;
    judgeSignal: Rate;
  };
  recentFlagVerdicts: FlagEvidence[];
}

interface SuspensionListResponse {
  suspensions: SuspensionItem[];
}

interface UnsuspendResult {
  rearmed: boolean;
}

const humanize = (value: string): string => value.replaceAll('_', ' ');

const rateLabel = (label: string, rate: Rate): string =>
  `${label} ${(rate.rate * 100).toFixed(1)}% (${rate.numerator}/${rate.denominator})`;

function RecoveryForm({
  suspension,
  pending,
  onUnsuspend,
}: {
  suspension: SuspensionItem;
  pending: boolean;
  onUnsuspend: (input: { accountId: string; note: string }) => void;
}) {
  const [note, setNote] = useState('');
  const trimmedNote = note.trim();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!trimmedNote) return;
    onUnsuspend({ accountId: suspension.accountId, note: trimmedNote });
  }

  if (suspension.scope !== 'account') {
    return (
      <p className="text-xs leading-5 text-rw-ink-soft">
        Location evidence only; recover from the account-scope row.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="grid min-w-64 gap-2">
      <label
        htmlFor={`note-${suspension.policyId}`}
        className="text-xs font-semibold text-rw-ink"
      >
        Unsuspend note for {suspension.accountName}
      </label>
      <textarea
        id={`note-${suspension.policyId}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={1_000}
        rows={3}
        required
        className="min-h-20 resize-y rounded-xl border border-rw-teal-strong/30 bg-white px-3 py-2 text-sm text-rw-ink shadow-sm outline-none transition focus:border-rw-teal-strong focus:ring-2 focus:ring-rw-teal-strong/20"
      />
      <button
        type="submit"
        disabled={pending || !trimmedNote}
        aria-label={`Unsuspend ${suspension.accountName}`}
        className="min-h-11 rounded-full bg-rw-teal-strong px-4 py-2 text-sm font-semibold text-white transition hover:bg-rw-teal-strong/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Unsuspending…' : 'Unsuspend account'}
      </button>
    </form>
  );
}

async function fetchSuspensions(): Promise<SuspensionListResponse> {
  const response = await fetch('/api/admin/autonomy/suspensions');
  if (!response.ok) throw new Error(`Failed to load suspensions: ${response.status}`);
  return response.json() as Promise<SuspensionListResponse>;
}

async function requestUnsuspend(input: {
  accountId: string;
  note: string;
}): Promise<UnsuspendResult> {
  const response = await fetch('/api/admin/autonomy/unsuspend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as Partial<UnsuspendResult> & {
    error?: string;
  };
  if (!response.ok || typeof body.rearmed !== 'boolean') {
    throw new Error(body.error ?? `Unsuspend failed: ${response.status}`);
  }
  return body as UnsuspendResult;
}

function FlagEvidenceList({ verdicts }: { verdicts: FlagEvidence[] }) {
  if (verdicts.length === 0) {
    return <p className="text-xs text-rw-ink-soft">No recent flag verdicts.</p>;
  }
  return (
    <ul className="space-y-2">
      {verdicts.map((verdict) => (
        <li key={verdict.id} className="rounded-xl bg-rw-cream px-3 py-2 text-xs text-rw-ink-soft">
          <p className="font-medium text-rw-ink">
            {verdict.reasons.length > 0
              ? verdict.reasons.map(humanize).join(', ')
              : 'Flagged without categories'}
          </p>
          <p className="mt-1 font-mono">Response {verdict.responseId}</p>
          <p className="mt-1">{new Date(verdict.createdAt).toLocaleString()}</p>
        </li>
      ))}
    </ul>
  );
}

function SuspensionRow({
  item,
  pending,
  onUnsuspend,
}: {
  item: SuspensionItem;
  pending: boolean;
  onUnsuspend: (input: { accountId: string; note: string }) => void;
}) {
  return (
    <tr className="align-top">
      <td className="px-4 py-4">
        <p className="font-semibold text-rw-ink">{item.accountName}</p>
        <p className="mt-1 text-xs text-rw-ink-soft">
          {item.locationName ?? 'All locations'} · {item.scope} scope
        </p>
      </td>
      <td className="max-w-xs px-4 py-4">
        <span className="inline-flex rounded-full bg-rw-blush/45 px-2.5 py-1 text-xs font-semibold text-rw-blush-deep">
          {item.trigger ? humanize(item.trigger) : 'unknown trigger'}
        </span>
        <p className="mt-2 leading-5 text-rw-ink">{item.suspendedReason ?? 'No reason recorded.'}</p>
        <p className="mt-2 text-xs text-rw-ink-soft">
          {new Date(item.suspendedAt).toLocaleString()}
        </p>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-xs leading-6 text-rw-ink-soft">
        <p>{rateLabel('Edit', item.governorRates.edit)}</p>
        <p>{rateLabel('Veto', item.governorRates.veto)}</p>
        <p>{rateLabel('Judge', item.governorRates.judgeSignal)}</p>
      </td>
      <td className="min-w-64 px-4 py-4">
        <FlagEvidenceList verdicts={item.recentFlagVerdicts} />
      </td>
      <td className="px-4 py-4">
        <RecoveryForm suspension={item} pending={pending} onUnsuspend={onUnsuspend} />
      </td>
    </tr>
  );
}

function SuspensionTable({
  suspensions,
  pending,
  onUnsuspend,
}: {
  suspensions: SuspensionItem[];
  pending: boolean;
  onUnsuspend: (input: { accountId: string; note: string }) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-3xl border border-rw-teal-strong/15 bg-white shadow-sm">
      <table className="min-w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Suspended account and location policies with watchdog evidence and recovery controls
        </caption>
        <thead className="bg-rw-sage/45 text-xs uppercase tracking-wide text-rw-ink-soft">
          <tr>
            {['Account / location', 'Suspension', 'Current rates', 'Recent flag evidence', 'Recovery'].map((heading) => (
              <th key={heading} scope="col" className="px-4 py-3 font-semibold">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rw-teal-strong/10">
          {suspensions.map((item) => (
            <SuspensionRow key={item.policyId} item={item} pending={pending} onUnsuspend={onUnsuspend} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryResult({
  suspensions,
  loading,
  failed,
  pending,
  onUnsuspend,
}: {
  suspensions: SuspensionItem[] | undefined;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  onUnsuspend: (input: { accountId: string; note: string }) => void;
}) {
  if (loading) return <p className="text-sm text-rw-ink-soft">Loading suspensions…</p>;
  if (failed) return <p role="alert" className="rounded-2xl border border-rw-danger/30 bg-rw-blush/30 px-4 py-3 text-sm text-rw-danger">Failed to load autonomy suspensions.</p>;
  if (suspensions?.length === 0) return (
    <div className="rounded-3xl border border-rw-teal-strong/15 bg-white p-8 text-center shadow-sm">
      <p className="font-semibold text-rw-ink">No suspended policies</p>
      <p className="mt-1 text-sm text-rw-ink-soft">The autonomy watchdog has no open recovery work.</p>
    </div>
  );
  return suspensions
    ? <SuspensionTable suspensions={suspensions} pending={pending} onUnsuspend={onUnsuspend} />
    : null;
}

export function AutonomySuspensionsClient() {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [actionError, setActionError] = useState('');
  const query = useQuery<SuspensionListResponse>({
    queryKey: ['admin-autonomy-suspensions'],
    queryFn: fetchSuspensions,
    refetchInterval: 30_000,
  });
  const unsuspend = useMutation({
    mutationFn: requestUnsuspend,
    onSuccess: (result) => {
      setActionError('');
      setOutcome(result.rearmed
        ? 'Auto-posting is armed again.'
        : 'Suspension cleared; policy remains manual.');
      void queryClient.invalidateQueries({ queryKey: ['admin-autonomy-suspensions'] });
    },
    onError: (error: unknown) => {
      setOutcome('');
      setActionError(error instanceof Error ? error.message : 'Unsuspend failed.');
    },
  });
  return (
    <section aria-label="Suspended autonomy policies" className="mt-8">
      <LiveRegion message={outcome} />
      {outcome && <p className="mb-4 rounded-2xl border border-rw-teal-strong/25 bg-rw-sage/60 px-4 py-3 text-sm font-medium text-rw-ink">{outcome}</p>}
      {actionError && <p role="alert" className="mb-4 rounded-2xl border border-rw-danger/30 bg-rw-blush/30 px-4 py-3 text-sm font-medium text-rw-danger">{actionError}</p>}
      <QueryResult
        suspensions={query.data?.suspensions}
        loading={query.isLoading}
        failed={query.isError}
        pending={unsuspend.isPending}
        onUnsuspend={(input) => unsuspend.mutate(input)}
      />
    </section>
  );
}

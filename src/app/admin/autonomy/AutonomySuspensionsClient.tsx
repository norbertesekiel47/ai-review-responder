'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';

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
      <p className="text-xs leading-5 text-gray-500">
        Location evidence only; recover from the account-scope row.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="grid min-w-64 gap-2">
      <label
        htmlFor={`note-${suspension.policyId}`}
        className="text-xs font-semibold text-gray-900"
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
        className="min-h-20 resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
      />
      <button
        type="submit"
        disabled={pending || !trimmedNote}
        aria-label={`Unsuspend ${suspension.accountName}`}
        className="min-h-11 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
    return <p className="text-xs text-gray-500">No recent flag verdicts.</p>;
  }
  return (
    <ul className="space-y-2">
      {verdicts.map((verdict) => (
        <li key={verdict.id} className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
          <p className="font-medium text-gray-900">
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
        <p className="font-semibold text-gray-900">{item.accountName}</p>
        <p className="mt-1 text-xs text-gray-500">
          {item.locationName ?? 'All locations'} · {item.scope} scope
        </p>
      </td>
      <td className="max-w-xs px-4 py-4">
        <span className="inline-flex rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-800">
          {item.trigger ? humanize(item.trigger) : 'unknown trigger'}
        </span>
        <p className="mt-2 leading-5 text-gray-800">{item.suspendedReason ?? 'No reason recorded.'}</p>
        <p className="mt-2 text-xs text-gray-500">
          {new Date(item.suspendedAt).toLocaleString()}
        </p>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-xs leading-6 text-gray-500">
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
    <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <table className="min-w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Suspended account and location policies with watchdog evidence and recovery controls
        </caption>
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            {['Account / location', 'Suspension', 'Current rates', 'Recent flag evidence', 'Recovery'].map((heading) => (
              <th key={heading} scope="col" className="px-4 py-3 font-semibold">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {suspensions.map((item) => (
            <SuspensionRow key={item.policyId} item={item} pending={pending} onUnsuspend={onUnsuspend} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryResult({
  data,
  loading,
  failed,
  onRetry,
  pending,
  onUnsuspend,
}: {
  data: SuspensionListResponse | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  pending: boolean;
  onUnsuspend: (input: { accountId: string; note: string }) => void;
}) {
  // Non-blanking error pattern (matches Jobs/Overview/Costs/Notifications/
  // Flagged): a full-screen ErrorState only when there's no cached data yet;
  // a failed background refetch keeps the table on screen with an inline
  // "Last refresh failed" notice instead of discarding it.
  if (loading && !data) return <TableSkeleton />;
  if (failed && !data) {
    return (
      <ErrorState
        title="Couldn't load autonomy suspensions"
        detail="GET /api/admin/autonomy/suspensions failed"
        onRetry={onRetry}
      />
    );
  }
  if (!data) return null;

  return (
    <>
      {failed && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/autonomy/suspensions failed — showing the last loaded data."
            onRetry={onRetry}
          />
        </div>
      )}
      {data.suspensions.length === 0 ? (
        <EmptyState
          title="No suspended policies"
          detail="The autonomy watchdog has no open recovery work."
        />
      ) : (
        <SuspensionTable suspensions={data.suspensions} pending={pending} onUnsuspend={onUnsuspend} />
      )}
    </>
  );
}

export function AutonomySuspensionsClient({
  initialData,
}: {
  initialData?: SuspensionListResponse;
}) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [actionError, setActionError] = useState('');
  const query = useQuery<SuspensionListResponse>({
    queryKey: ['admin-autonomy-suspensions'],
    queryFn: fetchSuspensions,
    refetchInterval: 30_000,
    staleTime: 30_000,
    initialData,
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
    <section aria-label="Suspended autonomy policies">
      <LiveRegion message={outcome} />
      {outcome && (
        <p className="mb-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {outcome}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {actionError}
        </p>
      )}
      <QueryResult
        data={query.data}
        loading={query.isLoading}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        pending={unsuspend.isPending}
        onUnsuspend={(input) => unsuspend.mutate(input)}
      />
    </section>
  );
}

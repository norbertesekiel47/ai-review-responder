'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage({ aal2: true }), matching
// GET /api/admin/offboardings' requireAdminWithAal2.

import { type Dispatch, type FormEvent, type SetStateAction, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminOffboarding,
  AdminOffboardingProvider,
  AdminOffboardingsList,
} from '@/lib/admin/offboardings-service';
import { PaginationFooter, serverPaginationFooterState } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDateTime } from '@/components/admin/ui/format';

import { OFFBOARDINGS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';
export { PAGE_SIZE };

// Mirrors GET /api/admin/offboardings' body: the list + total come from
// AdminOffboardingsList (single owner: offboardings-service.ts); limit/offset
// are request-echo fields the route adds on top.
type OffboardingsData = AdminOffboardingsList & { limit: number; offset: number };

type Provider = AdminOffboardingProvider;

interface DispositionFormState {
  provider: Provider;
  resourceType: string;
  resourceReference: string;
  reason: string;
  ticket: string;
}

type DispositionMutate = (input: { offboardingId: string; form: DispositionFormState }) => void;

const emptyDispositionForm: DispositionFormState = {
  provider: 'zernio',
  resourceType: '',
  resourceReference: '',
  reason: '',
  ticket: '',
};

const STEP_LABELS: Record<keyof AdminOffboarding['providerSteps'], string> = {
  stripe: 'Stripe',
  zernioAccounts: 'Zernio accounts',
  zernioProfiles: 'Zernio profiles',
  locationArchival: 'Locations',
  jobTerminalization: 'Jobs',
};

const PROVIDER_LABELS: Record<Provider, string> = {
  stripe: 'Stripe',
  zernio: 'Zernio',
  google: 'Google',
  supabase_auth: 'Supabase Auth',
  other: 'Other',
};

export function OffboardingsClient({ initialData }: { initialData: OffboardingsData }) {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [forms, setForms] = useState<Record<string, DispositionFormState>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<OffboardingsData>({
    queryKey: ['admin-offboardings', offset],
    queryFn: async () => {
      const res = await fetch(`/api/admin/offboardings?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to fetch offboardings: ${res.status}`);
      return res.json() as Promise<OffboardingsData>;
    },
    refetchInterval: 30_000,
    staleTime: 30_000,
    initialData: offset === 0 ? initialData : undefined,
  });

  const disposition = useMutation({
    mutationFn: async ({ offboardingId, form }: { offboardingId: string; form: DispositionFormState }) => {
      const res = await fetch(`/api/admin/offboardings/${offboardingId}/provider-disposition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          resourceType: form.resourceType,
          resourceReference: form.resourceReference,
          reason: form.reason,
          ticket: form.ticket.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Disposition failed: ${res.status}`);
      }
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: (_, { offboardingId }) => {
      setActionError(null);
      setForms((current) => ({ ...current, [offboardingId]: emptyDispositionForm }));
      void queryClient.invalidateQueries({ queryKey: ['admin-offboardings'] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Provider disposition failed');
    },
  });

  return (
    <>
      {actionError && (
        <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load offboardings"
          detail="GET /api/admin/offboardings failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/offboardings failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <OffboardingsContent
            data={data}
            offset={offset}
            onOffsetChange={setOffset}
            forms={forms}
            setForms={setForms}
            onDispose={disposition.mutate}
            disposing={disposition.isPending}
          />
        </>
      ) : null}
    </>
  );
}

function OffboardingsContent({
  data,
  offset,
  onOffsetChange,
  forms,
  setForms,
  onDispose,
  disposing,
}: {
  data: OffboardingsData;
  offset: number;
  onOffsetChange: (offset: number) => void;
  forms: Record<string, DispositionFormState>;
  setForms: Dispatch<SetStateAction<Record<string, DispositionFormState>>>;
  onDispose: DispositionMutate;
  disposing: boolean;
}) {
  // The route is offset-based; the shared footer is page-based. Convert at this
  // boundary only — `offset` stays the state shape AND the query key. Replaces
  // the old `offset > 0 || visibleCount === PAGE_SIZE` heuristic, which ignored
  // the `total` it already had and dead-ended on a short last page.
  const page = Math.floor(offset / PAGE_SIZE);
  const footer = serverPaginationFooterState({
    page,
    pageSize: PAGE_SIZE,
    rowsOnPage: data.offboardings.length,
    totalRows: data.total,
  });

  return (
    <>
      {data.offboardings.length === 0 ? (
        <EmptyState
          title="No active offboardings"
          detail="Nothing is scheduled, tearing down, or stuck right now."
        />
      ) : (
        <div className="space-y-4">
          {data.offboardings.map((item) => (
            <OffboardingCard
              key={item.id}
              item={item}
              form={forms[item.id] ?? emptyDispositionForm}
              setForms={setForms}
              onDispose={onDispose}
              disposing={disposing}
            />
          ))}
        </div>
      )}

      {footer.show && (
        <div className="mt-6">
          <PaginationFooter
            page={page}
            pageCount={footer.pageCount}
            label={footer.label}
            onPageChange={(nextPage) => onOffsetChange(nextPage * PAGE_SIZE)}
          />
        </div>
      )}
    </>
  );
}

function OffboardingCard({
  item,
  form,
  setForms,
  onDispose,
  disposing,
}: {
  item: AdminOffboarding;
  form: DispositionFormState;
  setForms: Dispatch<SetStateAction<Record<string, DispositionFormState>>>;
  onDispose: DispositionMutate;
  disposing: boolean;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{item.accountName}</h2>
            <ToneBadge label={item.mode} tone="neutral" />
            <ToneBadge label={item.status} tone={item.status === 'failed' ? 'danger' : 'neutral'} />
            {item.failedStep && <ToneBadge label={`failed: ${item.failedStep}`} tone="danger" />}
            {item.isStuck && <ToneBadge label="stuck" tone="warning" />}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Account {shortId(item.accountId)} · Offboarding {shortId(item.id)} · Retries {item.retryCount}
          </p>
        </div>
        <div className="text-right text-xs text-gray-500">
          <div>Requested {formatAdminDateTime(item.requestedAt)}</div>
          <div>Subscription {item.subscriptionStatus.replace(/_/g, ' ')}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <DueDate label="Access ends" value={item.accessEndsAt} />
            <DueDate label="Teardown started" value={item.teardownStartedAt} />
            <DueDate label="Teardown completed" value={item.teardownCompletedAt} />
            <DueDate label="Purge after" value={item.purgeAfter} />
            <DueDate label="Purge started" value={item.purgeStartedAt} />
            <DueDate label="Purge cancelled" value={item.purgeCancelledAt} />
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Provider Steps
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.entries(item.providerSteps) as Array<[keyof AdminOffboarding['providerSteps'], string]>).map(
                ([key, value]) => (
                  <span key={key} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700">
                    {STEP_LABELS[key]}: <span className="font-medium">{value.replace(/_/g, ' ')}</span>
                  </span>
                ),
              )}
            </div>
          </div>

          {item.lastError && (
            <div className="rounded border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="font-semibold">Last error:</span> {item.lastError}
            </div>
          )}

          {item.providerDispositions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Provider Dispositions
              </h3>
              <div className="mt-2 space-y-2">
                {item.providerDispositions.map((entry) => (
                  <div
                    key={`${entry.provider}-${entry.resource_type}-${entry.recorded_at}`}
                    className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
                  >
                    <div className="font-medium">
                      {PROVIDER_LABELS[entry.provider]} · {entry.resource_type}
                    </div>
                    <div>{entry.scrubbed_resource_reference}</div>
                    <div>{entry.reason}</div>
                    <div className="text-gray-500">
                      {formatAdminDateTime(entry.recorded_at)}
                      {entry.ticket ? ` · ${entry.ticket}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <form
          className="rounded border border-gray-200 bg-gray-50 p-4"
          onSubmit={(event) => submitDisposition(event, item.id, form, onDispose)}
        >
          <h3 className="text-sm font-semibold text-gray-900">Record Provider Disposition</h3>
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-medium text-gray-700">
              Provider
              <select
                value={form.provider}
                onChange={(event) => updateForm(setForms, item.id, { provider: event.target.value as Provider })}
                className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                {(Object.keys(PROVIDER_LABELS) as Provider[]).map((provider) => (
                  <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>
                ))}
              </select>
            </label>
            <TextInput
              label="Resource Type"
              value={form.resourceType}
              onChange={(resourceType) => updateForm(setForms, item.id, { resourceType })}
            />
            <TextInput
              label="Scrubbed Reference"
              value={form.resourceReference}
              onChange={(resourceReference) => updateForm(setForms, item.id, { resourceReference })}
            />
            <TextInput
              label="Ticket"
              value={form.ticket}
              onChange={(ticket) => updateForm(setForms, item.id, { ticket })}
              required={false}
            />
            <label className="block text-xs font-medium text-gray-700">
              Reason
              <textarea
                required
                value={form.reason}
                onChange={(event) => updateForm(setForms, item.id, { reason: event.target.value })}
                className="mt-1 block min-h-20 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={disposing}
            className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Record
          </button>
        </form>
      </div>
    </section>
  );
}

function submitDisposition(
  event: FormEvent<HTMLFormElement>,
  offboardingId: string,
  form: DispositionFormState,
  mutate: DispositionMutate,
) {
  event.preventDefault();
  mutate({ offboardingId, form });
}

function updateForm(
  setForms: Dispatch<SetStateAction<Record<string, DispositionFormState>>>,
  offboardingId: string,
  patch: Partial<DispositionFormState>,
) {
  setForms((current) => ({
    ...current,
    [offboardingId]: {
      ...(current[offboardingId] ?? emptyDispositionForm),
      ...patch,
    },
  }));
}

function TextInput({
  label,
  value,
  onChange,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block text-xs font-medium text-gray-700">
      {label}
      <input
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900"
      />
    </label>
  );
}

/**
 * Tone-keyed presentational badge — NOT a status→color map, and deliberately not
 * the shared `StatusBadge` primitive: the caller picks the tone from offboarding
 * semantics (a `failed` status, a stuck lifecycle, a mode label). Renamed from
 * `StatusBadge` because that name shadowed the shared component.
 */
function ToneBadge({ label, tone }: { label: string; tone: 'neutral' | 'warning' | 'danger' }) {
  const classes = {
    neutral: 'bg-gray-100 text-gray-700',
    warning: 'bg-yellow-100 text-yellow-800',
    danger: 'bg-red-100 text-red-700',
  }[tone];
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${classes}`}>
      {label.replace(/_/g, ' ')}
    </span>
  );
}

function DueDate({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded border border-gray-200 bg-white px-3 py-2">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 text-sm text-gray-900">{formatAdminDateTime(value)}</div>
    </div>
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

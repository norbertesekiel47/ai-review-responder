'use client';

import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminNotificationsData } from '@/lib/admin/notifications-service';
import { CHANNEL_IDS, type ChannelId } from '@/lib/notifications/channels/types';
import { StatusBadge, statusLabel, type DeliveryStatus } from '@/components/admin/ui/StatusBadge';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { FILTER_SELECT_CLASS } from '@/components/admin/ui/FilterBar';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDateTime } from '@/components/admin/ui/format';

// Mirrors src/app/api/admin/notifications/route.ts's NotifData exactly: the
// delivery log + businesses dropdown come from AdminNotificationsData (single
// owner: notifications-service.ts); limit/offset are request-echo fields the
// route adds on top.
type NotifData = AdminNotificationsData & { limit: number; offset: number };

type Delivery = NotifData['notifications'][number];
type BusinessOption = NotifData['businesses'][number];

import { NOTIFICATIONS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

/** Above this many businesses the picker becomes a type-to-search combobox (X17). */
export const BUSINESS_PICKER_COMBOBOX_THRESHOLD = 50;

/** Channel option labels, one per member of the single owner `CHANNEL_IDS`. */
const CHANNEL_LABELS: Record<ChannelId, string> = {
  email: 'Email',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['delivered', 'failed', 'pending'];

function deliveryStatus(d: Delivery): DeliveryStatus {
  if (d.deliveredAt) return 'delivered';
  if (d.failedAt) return 'failed';
  return 'pending';
}

const columns: DataTableColumn<Delivery>[] = [
  { key: 'business', header: 'Business', render: (d) => <span className="font-medium text-gray-800">{d.businessName}</span> },
  { key: 'channel', header: 'Channel', render: (d) => <span className="capitalize text-gray-700">{d.channel}</span> },
  { key: 'recipient', header: 'Recipient', render: (d) => <span className="font-mono text-xs text-gray-500">{d.recipient}</span> },
  { key: 'template', header: 'Template', render: (d) => <span className="text-gray-700">{d.template}</span> },
  { key: 'sent', header: 'Sent', render: (d) => <span className="whitespace-nowrap text-gray-600">{formatAdminDateTime(d.sentAt)}</span> },
  {
    key: 'status',
    header: 'Status',
    render: (d) => {
      const status = deliveryStatus(d);
      return (
        <span className="block">
          <StatusBadge vocab="delivery" value={status} />
          {/* The failure reason is the one fact a failed row is opened for, so
              it is a visible line — not a hover title, which never reaches touch
              or a screen reader (X18). */}
          {status === 'failed' && d.failureReason && (
            <span className="mt-1 block max-w-xs break-words text-xs text-red-700">{d.failureReason}</span>
          )}
        </span>
      );
    },
  },
];

/**
 * The business filter. A `<select>` up to BUSINESS_PICKER_COMBOBOX_THRESHOLD
 * entries; past that a `<datalist>`-backed input — the browser's own
 * type-to-filter combobox, keyboard- and screen-reader-native, with no list
 * library to carry. Both emit the business ID; the input resolves an exact
 * name match to its id and treats anything else as "no business filter".
 */
function BusinessPicker({
  businesses,
  value,
  onChange,
}: {
  businesses: BusinessOption[];
  value: string;
  onChange: (businessId: string) => void;
}) {
  const listId = useId();
  const selected = businesses.find((b) => b.id === value);
  const [typed, setTyped] = useState(selected?.name ?? '');

  if (businesses.length <= BUSINESS_PICKER_COMBOBOX_THRESHOLD) {
    return (
      <select
        aria-label="Business"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={FILTER_SELECT_CLASS}
      >
        <option value="">All Businesses</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    );
  }

  // Controlled by `typed`; a Reset from the parent (value → '') clears the box
  // through the `selected`-derived key on the parent side, see `pickerKey`.
  return (
    <>
      <input
        type="text"
        role="combobox"
        aria-label="Business"
        aria-expanded="false"
        aria-controls={listId}
        aria-autocomplete="list"
        list={listId}
        value={typed}
        placeholder={`Type a business name (${businesses.length})…`}
        onChange={(e) => {
          const next = e.target.value;
          setTyped(next);
          const match = businesses.find((b) => b.name === next);
          onChange(match ? match.id : '');
        }}
        className={`${FILTER_SELECT_CLASS} min-w-64`}
      />
      <datalist id={listId}>
        {businesses.map((b) => (
          <option key={b.id} value={b.name} />
        ))}
      </datalist>
    </>
  );
}

function NotificationsContent({
  data,
  page,
  onPageChange,
  businessId,
  onBusinessIdChange,
  channel,
  onChannelChange,
  status,
  onStatusChange,
  onReset,
  pickerKey,
}: {
  data: NotifData;
  page: number;
  onPageChange: (page: number) => void;
  businessId: string;
  onBusinessIdChange: (v: string) => void;
  channel: string;
  onChannelChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
  onReset: () => void;
  pickerKey: number;
}) {
  return (
    <>
      {/* Filters toolbar — three selects don't fit FilterBar's search box, so
          they stay a plain toolbar row (spec §5 exception). */}
      <div className="flex flex-wrap items-center gap-3">
        <BusinessPicker key={pickerKey} businesses={data.businesses} value={businessId} onChange={onBusinessIdChange} />

        <select
          aria-label="Channel"
          value={channel}
          onChange={(e) => onChannelChange(e.target.value)}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">All Channels</option>
          {CHANNEL_IDS.map((id) => (
            <option key={id} value={id}>
              {CHANNEL_LABELS[id]}
            </option>
          ))}
        </select>

        <select
          aria-label="Status"
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          className={FILTER_SELECT_CLASS}
        >
          <option value="">All Statuses</option>
          {DELIVERY_STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel('delivery', value)}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-gray-900"
        >
          Reset
        </button>
      </div>

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={data.notifications}
          rowKey={(d) => d.id}
          serverPagination={{
            page,
            pageSize: PAGE_SIZE,
            totalRows: data.total,
            onPageChange,
          }}
          emptyState={<EmptyState title="No notification deliveries found" />}
        />
      </div>
    </>
  );
}

interface NotificationFilters {
  businessId: string;
  channel: string;
  status: string;
}

/** The GET `src/app/api/admin/notifications/route.ts` parses — only present filters are sent. */
async function fetchNotificationsPage(page: number, filters: NotificationFilters): Promise<NotifData> {
  const sp = new URLSearchParams();
  sp.set('limit', String(PAGE_SIZE));
  sp.set('offset', String(page * PAGE_SIZE));
  if (filters.businessId) sp.set('business_id', filters.businessId);
  if (filters.channel) sp.set('channel', filters.channel);
  if (filters.status) sp.set('status', filters.status);

  const res = await fetch(`/api/admin/notifications?${sp.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch notifications: ${res.status}`);
  return res.json() as Promise<NotifData>;
}

export function NotificationsClient({ initialData }: { initialData: NotifData }) {
  const [page, setPage] = useState(0);
  const [businessId, setBusinessId] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  // Bumped on Reset so the combobox's typed text remounts empty.
  const [pickerKey, setPickerKey] = useState(0);

  const noFilters = businessId === '' && channel === '' && status === '';

  const { data, isLoading, isError, refetch } = useQuery<NotifData>({
    queryKey: ['admin-notifications', page, businessId, channel, status],
    queryFn: () => fetchNotificationsPage(page, { businessId, channel, status }),
    staleTime: 30_000,
    initialData: page === 0 && noFilters ? initialData : undefined,
  });

  function handleFilterChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setPage(0);
    };
  }

  function handleReset() {
    setBusinessId('');
    setChannel('');
    setStatus('');
    setPage(0);
    setPickerKey((k) => k + 1);
  }

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  if (isLoading && !data) return <TableSkeleton />;
  if (isError && !data) {
    return (
      <ErrorState
        title="Couldn't load notifications"
        detail="GET /api/admin/notifications failed"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return null;

  return (
    <>
      {isError && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/notifications failed — showing the last loaded data."
            onRetry={() => void refetch()}
          />
        </div>
      )}
      <NotificationsContent
        data={data}
        page={page}
        onPageChange={setPage}
        businessId={businessId}
        onBusinessIdChange={handleFilterChange(setBusinessId)}
        channel={channel}
        onChannelChange={handleFilterChange(setChannel)}
        status={status}
        onStatusChange={handleFilterChange(setStatus)}
        onReset={handleReset}
        pickerKey={pickerKey}
      />
    </>
  );
}

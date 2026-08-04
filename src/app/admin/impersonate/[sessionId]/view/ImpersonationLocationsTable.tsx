'use client';

import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState } from '@/components/admin/ui/states';

/**
 * Plain, already-serialized row shape. The view page derives `state` server-side
 * so no `Date` (nor any locale formatting) crosses the RSC boundary — the
 * convention #2 trap that only bites on first paint.
 */
export interface ImpersonationLocationRow {
  id: string;
  name: string;
  displayLabel: string | null;
  state: string;
}

const COLUMNS: DataTableColumn<ImpersonationLocationRow>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (row) => row.displayLabel ?? row.name,
    render: (row) => (
      <>
        <div className="font-medium text-gray-900">{row.displayLabel ?? row.name}</div>
        {row.displayLabel && <div className="text-xs text-gray-500">{row.name}</div>}
      </>
    ),
  },
  {
    key: 'id',
    header: 'Location ID',
    render: (row) => <span className="font-mono text-xs text-gray-600">{row.id}</span>,
    className: 'font-mono',
  },
  {
    key: 'state',
    header: 'State',
    sortValue: (row) => row.state,
    render: (row) => (
      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
        {row.state}
      </span>
    ),
  },
];

/**
 * Client boundary for the read-only locations table: `DataTable` takes render
 * callbacks, which cannot cross the RSC boundary from the (server-only) view
 * page. No `rowHref` — there is nothing to link to inside a read-only session.
 */
export function ImpersonationLocationsTable({ locations }: { locations: ImpersonationLocationRow[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={locations}
      rowKey={(row) => row.id}
      emptyState={<EmptyState title="No locations found for this account." />}
    />
  );
}

'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
  /** Extra cell classes, e.g. 'text-right'. */
  className?: string;
}

interface ServerPagination {
  page: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** When set, each row gets a trailing "View →" link column. */
  rowHref?: (row: T) => string;
  pageSize?: number;
  emptyState: ReactNode;
  /** Controlled mode: rows are ONE server page; the caller owns fetching. Client-side sort stays within the page. */
  serverPagination?: ServerPagination;
}

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export function DataTable<T>({ columns, rows, rowKey, rowHref, pageSize = 20, emptyState, serverPagination }: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const sortValue = columns.find((col) => col.key === sort.key)?.sortValue;
    if (!sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = sortValue(a);
      const bValue = sortValue(b);
      if (aValue === bValue) return 0;
      return aValue < bValue ? -dir : dir;
    });
  }, [rows, sort, columns]);

  const pageCount = serverPagination
    ? Math.max(1, Math.ceil(serverPagination.totalRows / serverPagination.pageSize))
    : Math.max(1, Math.ceil(sorted.length / pageSize));
  // Clamped in BOTH modes: server mode's `page` is caller-controlled state that
  // can point past the last valid page (e.g. the 30s poll shrinks totalRows
  // while the admin sits on a later page) — display math must never assume
  // it's in range.
  const currentPage = Math.min(serverPagination ? serverPagination.page : page, pageCount - 1);
  const visible = serverPagination ? sorted : sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function toggleSort(key: string) {
    if (!serverPagination) setPage(0);
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  function goToPage(nextPage: number) {
    if (serverPagination) {
      serverPagination.onPageChange(nextPage);
    } else {
      setPage(nextPage);
    }
  }

  // True empty: the uncontrolled path's original early return (byte-identical
  // behavior), extended to server mode's true-empty case (totalRows === 0). A
  // server-mode page that returned zero rows because the CALLER'S page number
  // ran past a shrunk totalRows is NOT true-empty — it still needs the footer
  // below so Previous stays reachable.
  if (rows.length === 0 && (!serverPagination || serverPagination.totalRows === 0)) {
    return <>{emptyState}</>;
  }

  const showFooter = serverPagination
    ? serverPagination.totalRows > rows.length || pageCount > 1
    : pageCount > 1;

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      {rows.length === 0 ? (
        emptyState
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            {/* Sticky within the overflow-x-auto wrapper above; only pins visually
                once a consumer bounds this container's height (e.g. max-h-*) —
                Phase 2 decides that per page. */}
            <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
              <tr>
                {/* Header cell: sort button + optional direction indicator drives this
                    callback's cyclomatic/cognitive score. No second column shape exists
                    to justify decomposing further; consumer lands in Phase 2 (admin page
                    migrations). */}
                {/* fallow-ignore-next-line complexity */}
                {columns.map((col) => (
                  <th
                    key={col.key}
                    aria-sort={
                      col.sortValue && sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={`px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 ${col.className ?? ''}`}
                  >
                    {col.sortValue ? (
                      <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-gray-900">
                        {col.header}
                        {sort?.key === col.key && <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                ))}
                {rowHref && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={rowKey(row)} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  {columns.map((col) => (
                    <td key={col.key} className={`px-3 py-2 text-gray-900 ${col.className ?? ''}`}>
                      {col.render(row)}
                    </td>
                  ))}
                  {rowHref && (
                    <td className="px-3 py-2 text-right">
                      <Link href={rowHref(row)} className="text-xs text-gray-500 hover:text-gray-900">
                        View →
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showFooter && (
        <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
          <span>
            {serverPagination
              ? rows.length > 0
                ? (() => {
                    const start = currentPage * serverPagination.pageSize + 1;
                    const end = Math.min(start + rows.length - 1, serverPagination.totalRows);
                    return `Showing ${start}–${end} of ${serverPagination.totalRows}`;
                  })()
                : `No rows on this page (${serverPagination.totalRows} total)`
              : `Page ${currentPage + 1} of ${pageCount}`}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => goToPage(currentPage - 1)}
              className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => goToPage(currentPage + 1)}
              className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

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
  /**
   * Bounds the scrolling body (any CSS length, e.g. `'70vh'`). The header is
   * `sticky` but only pins once SOMETHING bounds this container's height — with
   * no bound the table grows with its rows and the header scrolls away with
   * them (X30). Pass it on tables whose rows can be tall (expandable errors)
   * or long (a full page of 50); leave it off for a short audit table.
   */
  maxHeight?: string;
}

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface ServerPaginationFooterState {
  pageCount: number;
  label: string;
  show: boolean;
}

function pageCountOf(totalRows: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalRows / pageSize));
}

/**
 * Server-pagination footer math, shared by DataTable's controlled mode and by
 * card-list pages (OffboardingsClient) that paginate
 * server-side without a table. Single owner so the "Showing a–b of N" string
 * and the empty-page-with-rows-behind-you guard cannot drift between call
 * sites.
 *
 * `page` means different things at the two kinds of call site, and a page past
 * the end recovers by a DIFFERENT mechanism at each — do not generalise one to
 * the other:
 *
 *   - DataTable passes its ALREADY-CLAMPED `currentPage`. `{page: 2,
 *     pageSize: 20, totalRows: 10, rows: []}` arrives here as page 0 with
 *     `pageCount` 1, so `show` is FALSE and no footer renders at all. Its
 *     recovery is the clamp-pushback effect below (`onPageChange(clamped)`),
 *     which converges the caller's own state — never `page > 0`.
 *   - Card lists pass their raw, unclamped page index. The same skew arrives
 *     here as page 2, `show` is true via `page > 0`, and the footer that
 *     renders keeps Previous live so the reader can walk back by hand.
 *
 * TWO GUARDS, both from CF-2, both against count⇄list skew (the count query and
 * the row query are separate reads, and a 30s poll can land between them):
 *
 *   1. `show` requires a page to actually be reachable from another page —
 *      `pageCount > 1 || page > 0`. The old rule `totalRows > rowsOnPage` fired
 *      on a SINGLE-page result whose list came back short (`{page: 0,
 *      pageSize: 50, rowsOnPage: 3, totalRows: 10}`), rendering a footer that
 *      claimed 7 more rows with Previous AND Next both disabled — a dead end
 *      with nothing to click.
 *   2. A `page` past the end makes `start > totalRows`, which used to print the
 *      inverted `Showing 101–90 of 90`. That page genuinely holds no rows, so
 *      it takes the honest empty label. What is left to click then depends on
 *      which of the two callers it came from — see above.
 */
export function serverPaginationFooterState({
  page,
  pageSize,
  rowsOnPage,
  totalRows,
}: {
  page: number;
  pageSize: number;
  rowsOnPage: number;
  totalRows: number;
}): ServerPaginationFooterState {
  const pageCount = pageCountOf(totalRows, pageSize);
  const start = page * pageSize + 1;
  const end = Math.min(start + rowsOnPage - 1, totalRows);
  const hasRenderableRange = rowsOnPage > 0 && start <= totalRows;
  return {
    pageCount,
    label: hasRenderableRange
      ? `Showing ${start}–${end} of ${totalRows}`
      : `No rows on this page (${totalRows} total)`,
    show: pageCount > 1 || page > 0,
  };
}

/** The footer chrome itself. Callers decide whether to render it (see `show`). */
export function PaginationFooter({
  page,
  pageCount,
  label,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  label: string;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
      <span>{label}</span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
          className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Client-side sort within the rows given (a whole list, or one server page). */
function useSortedRows<T>(rows: T[], columns: DataTableColumn<T>[], sort: SortState | null): T[] {
  return useMemo(() => {
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
}

/**
 * Both modes render the SAME footer component; only the label and the
 * visibility rule differ. `serverPaginationFooterState` owns the server-mode
 * rule so card-list pages cannot drift from this table.
 */
function footerStateFor({
  serverPagination,
  currentPage,
  pageCount,
  rowsOnPage,
}: {
  serverPagination: ServerPagination | undefined;
  currentPage: number;
  pageCount: number;
  rowsOnPage: number;
}): ServerPaginationFooterState {
  if (serverPagination) {
    return serverPaginationFooterState({
      page: currentPage,
      pageSize: serverPagination.pageSize,
      rowsOnPage,
      totalRows: serverPagination.totalRows,
    });
  }
  return { pageCount, label: `Page ${currentPage + 1} of ${pageCount}`, show: pageCount > 1 };
}

/**
 * True empty: the uncontrolled path's original early return (byte-identical
 * behavior), extended to server mode's true-empty case (totalRows === 0). A
 * server-mode page that returned zero rows because the CALLER'S page number
 * ran past a shrunk totalRows is NOT true-empty — it still needs the footer
 * so Previous stays reachable.
 */
function isTrueEmpty(rowsOnPage: number, serverPagination: ServerPagination | undefined): boolean {
  return rowsOnPage === 0 && (!serverPagination || serverPagination.totalRows === 0);
}

/**
 * CF-2: clamping for DISPLAY is not enough. The caller still holds the
 * out-of-range page number, so it keeps refetching an empty page, and once
 * `pageCount` collapses to 1 the footer disappears (nothing is reachable) —
 * leaving no control that can put the caller back in range. Push the clamp
 * back so the caller's state converges. Idempotent: after the caller adopts
 * it the condition is false, and a caller that ignores it re-renders no more
 * than it already would.
 */
function useServerPageClampPushback(serverPagination: ServerPagination | undefined, pageCount: number) {
  const serverPage = serverPagination?.page;
  const serverOnPageChange = serverPagination?.onPageChange;
  const clampedServerPage = serverPage === undefined ? 0 : Math.min(serverPage, pageCount - 1);
  useEffect(() => {
    if (serverPage === undefined || serverOnPageChange === undefined) return;
    if (serverPage > clampedServerPage) serverOnPageChange(clampedServerPage);
  }, [serverPage, clampedServerPage, serverOnPageChange]);
}

function DataTableHead<T>({
  columns,
  sort,
  onToggleSort,
  hasLinkColumn,
}: {
  columns: DataTableColumn<T>[];
  sort: SortState | null;
  onToggleSort: (key: string) => void;
  hasLinkColumn: boolean;
}) {
  return (
    /* Sticky within the scroll wrapper; pins visually only when the consumer
       passes `maxHeight` (X30) — otherwise the wrapper is as tall as the table
       and there is nothing to stick against. */
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
            // 11px / gray-600, not 10px / gray-500: uppercase tracking at
            // 10px on the gray-50 header was below AA contrast (X31).
            className={`px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-600 ${col.className ?? ''}`}
          >
            {col.sortValue ? (
              <button type="button" onClick={() => onToggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-gray-900">
                {col.header}
                {sort?.key === col.key && <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </button>
            ) : (
              col.header
            )}
          </th>
        ))}
        {hasLinkColumn && <th className="px-3 py-2" />}
      </tr>
    </thead>
  );
}

function DataTableBody<T>({
  columns,
  rows,
  rowKey,
  rowHref,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref: ((row: T) => string) | undefined;
}) {
  return (
    <tbody>
      {rows.map((row) => (
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
  );
}

/** The scroll wrapper + table. `maxHeight` bounds it so the sticky head pins (X30). */
function DataTableGrid<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  sort,
  onToggleSort,
  maxHeight,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref: ((row: T) => string) | undefined;
  sort: SortState | null;
  onToggleSort: (key: string) => void;
  maxHeight: string | undefined;
}) {
  return (
    <div
      className={maxHeight ? 'overflow-auto' : 'overflow-x-auto'}
      style={maxHeight ? { maxHeight } : undefined}
      data-testid="data-table-scroll"
    >
      <table className="w-full text-left text-sm">
        <DataTableHead columns={columns} sort={sort} onToggleSort={onToggleSort} hasLinkColumn={rowHref !== undefined} />
        <DataTableBody columns={columns} rows={rows} rowKey={rowKey} rowHref={rowHref} />
      </table>
    </div>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  pageSize = 20,
  emptyState,
  serverPagination,
  maxHeight,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);

  const sorted = useSortedRows(rows, columns, sort);

  const pageCount = serverPagination
    ? pageCountOf(serverPagination.totalRows, serverPagination.pageSize)
    : pageCountOf(sorted.length, pageSize);
  // Clamped in BOTH modes: server mode's `page` is caller-controlled state that
  // can point past the last valid page (e.g. the 30s poll shrinks totalRows
  // while the admin sits on a later page) — display math must never assume
  // it's in range.
  const currentPage = Math.min(serverPagination ? serverPagination.page : page, pageCount - 1);
  const visible = serverPagination ? sorted : sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  useServerPageClampPushback(serverPagination, pageCount);

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

  if (isTrueEmpty(rows.length, serverPagination)) {
    return <>{emptyState}</>;
  }

  const footer = footerStateFor({ serverPagination, currentPage, pageCount, rowsOnPage: rows.length });

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      {rows.length === 0 ? (
        emptyState
      ) : (
        <DataTableGrid
          columns={columns}
          rows={visible}
          rowKey={rowKey}
          rowHref={rowHref}
          sort={sort}
          onToggleSort={toggleSort}
          maxHeight={maxHeight}
        />
      )}
      {footer.show && (
        <PaginationFooter
          page={currentPage}
          pageCount={footer.pageCount}
          label={footer.label}
          onPageChange={goToPage}
        />
      )}
    </div>
  );
}

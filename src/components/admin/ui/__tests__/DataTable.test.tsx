// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, serverPaginationFooterState, type DataTableColumn } from '../DataTable';
import { EmptyState } from '../states';

interface Row { id: string; name: string; spend: number }

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'spend', header: 'Spend', render: (r) => `$${r.spend}`, sortValue: (r) => r.spend },
];

const rows: Row[] = [
  { id: '1', name: 'Bravo', spend: 30 },
  { id: '2', name: 'Alpha', spend: 10 },
  { id: '3', name: 'Charlie', spend: 20 },
];

function names(): string[] {
  // First cell of each body row.
  return screen.getAllByRole('row').slice(1).map((row) => (row as HTMLTableRowElement).cells[0]?.textContent ?? '');
}

describe('DataTable', () => {
  it('renders rows in given order by default', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyState={<EmptyState title="none" />} />);
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('sorts by column on header click, toggling direction', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyState={<EmptyState title="none" />} />);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('paginates and navigates pages', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={2} emptyState={<EmptyState title="none" />} />);
    expect(names()).toEqual(['Bravo', 'Alpha']);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(names()).toEqual(['Charlie']);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('resets to page 1 when sorting from a later page', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={2} emptyState={<EmptyState title="none" />} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(names()).toEqual(['Alpha', 'Bravo']);
  });

  it('renders the empty state when there are no rows', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyState={<EmptyState title="No rows yet" />} />);
    expect(screen.getByText('No rows yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a View link per row when rowHref is provided', () => {
    render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} rowHref={(r) => `/admin/businesses/${r.id}`} emptyState={<EmptyState title="none" />} />,
    );
    const links = screen.getAllByRole('link', { name: 'View →' });
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', '/admin/businesses/1');
  });

  it('server pagination: renders given rows as-is with Showing footer and controlled navigation', async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 1, pageSize: 3, totalRows: 8, onPageChange }}
      />,
    );
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(screen.getByText('Showing 4–6 of 8')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('server pagination: disables Previous on first page and Next on last page', () => {
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 0, pageSize: 3, totalRows: 8, onPageChange: () => {} }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    rerender(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 2, pageSize: 3, totalRows: 8, onPageChange: () => {} }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('server pagination: a shrunk page (rows empty, totalRows > 0) still shows the empty state with a reachable Previous', async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="No rows yet" />}
        serverPagination={{ page: 2, pageSize: 3, totalRows: 8, onPageChange }}
      />,
    );
    expect(screen.getByText('No rows yet')).toBeInTheDocument();
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toBeEnabled();
    await userEvent.click(previous);
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('server pagination: a true-empty result (totalRows === 0) renders the bare empty state with no footer', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="No rows yet" />}
        serverPagination={{ page: 0, pageSize: 3, totalRows: 0, onPageChange: () => {} }}
      />,
    );
    expect(screen.getByText('No rows yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  // CF-2. A DataTable whose caller sits on a page that `totalRows` has shrunk
  // past used to display-clamp silently: the footer's own buttons were both
  // dead and the caller kept refetching an empty page with no way back.
  it('server pagination: pushes the clamp back to the caller when its page runs past the end', () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="No rows yet" />}
        serverPagination={{ page: 2, pageSize: 20, totalRows: 10, onPageChange }}
      />,
    );
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('server pagination: leaves an in-range caller page alone', () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 1, pageSize: 3, totalRows: 8, onPageChange }}
      />,
    );
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

describe('serverPaginationFooterState (CF-2)', () => {
  it('keeps today’s label and visibility for an ordinary middle page', () => {
    expect(serverPaginationFooterState({ page: 1, pageSize: 3, rowsOnPage: 3, totalRows: 8 })).toEqual({
      pageCount: 3,
      label: 'Showing 4–6 of 8',
      show: true,
    });
  });

  it('hides the footer when a short list on a single page has nowhere to go', () => {
    // Count/list skew: `totalRows` says 10, the page returned 3, and pageSize 50
    // means there is no second page. The old rule showed a footer advertising 7
    // unreachable rows with Previous AND Next both disabled.
    expect(serverPaginationFooterState({ page: 0, pageSize: 50, rowsOnPage: 3, totalRows: 10 })).toEqual({
      pageCount: 1,
      label: 'Showing 1–3 of 10',
      show: false,
    });
  });

  it('never inverts the range when the caller page runs past totalRows', () => {
    // Previously `Showing 101–90 of 90`.
    const state = serverPaginationFooterState({ page: 2, pageSize: 50, rowsOnPage: 5, totalRows: 90 });
    expect(state.label).toBe('No rows on this page (90 total)');
    expect(state.show).toBe(true); // Previous stays reachable
    expect(state.pageCount).toBe(2);
  });

  it('keeps the empty-page-with-rows-behind-you footer', () => {
    expect(serverPaginationFooterState({ page: 2, pageSize: 50, rowsOnPage: 0, totalRows: 120 })).toEqual({
      pageCount: 3,
      label: 'No rows on this page (120 total)',
      show: true,
    });
  });
});

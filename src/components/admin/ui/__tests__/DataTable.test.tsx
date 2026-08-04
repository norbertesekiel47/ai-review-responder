// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from '../DataTable';
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
});

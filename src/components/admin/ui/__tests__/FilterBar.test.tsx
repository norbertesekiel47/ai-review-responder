// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from '../FilterBar';

describe('FilterBar', () => {
  it('wires the search input and shows the row count', async () => {
    const onSearchChange = vi.fn();
    render(<FilterBar search="" onSearchChange={onSearchChange} rowCount={41} />);
    await userEvent.type(screen.getByPlaceholderText('Filter…'), 'a');
    expect(onSearchChange).toHaveBeenCalledWith('a');
    expect(screen.getByText('41 rows')).toBeInTheDocument();
  });

  it('names the search box for assistive tech and takes a noun for the count', () => {
    render(
      <FilterBar
        search=""
        onSearchChange={() => {}}
        rowCount={57}
        rowNoun="businesses"
        searchLabel="Search businesses by name"
      />,
    );
    expect(screen.getByRole('searchbox', { name: 'Search businesses by name' })).toBeInTheDocument();
    expect(screen.getByText('57 businesses')).toBeInTheDocument();
  });

  it('renders removable chips', async () => {
    const onRemove = vi.fn();
    render(
      <FilterBar
        search=""
        onSearchChange={() => {}}
        rowCount={1}
        chips={[{ id: 'days', label: '30 days', onRemove }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter 30 days' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('places filter controls between the search box and the chips (X5)', () => {
    render(
      <FilterBar
        search=""
        onSearchChange={() => {}}
        rowCount={1}
        chips={[{ id: 'status', label: 'Status: Active', onRemove: () => {} }]}
        controls={
          <select aria-label="Status">
            <option value="">All statuses</option>
          </select>
        }
      />,
    );
    const control = screen.getByRole('combobox', { name: 'Status' });
    const chip = screen.getByText('Status: Active');
    expect(control).toBeInTheDocument();
    // DOM order: search → controls → chips.
    expect(control.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

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
});

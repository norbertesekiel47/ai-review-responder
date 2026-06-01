// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListEditor } from '@/components/dashboard/settings/ListEditor';

describe('ListEditor', () => {
  it('renders one input per item and an add button', () => {
    render(
      <ListEditor items={['a', 'b']} onChange={() => {}} placeholder="" addLabel="Add" />,
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('emits new array when typing', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ListEditor items={['hello']} onChange={onChange} placeholder="" addLabel="Add" />);
    await user.type(screen.getAllByRole('textbox')[0]!, '!');
    expect(onChange).toHaveBeenCalled();
    const lastCallArgs = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCallArgs).toEqual(['hello!']);
  });

  it('removes a row on remove click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ListEditor items={['a', 'b']} onChange={onChange} placeholder="" addLabel="Add" />);
    await user.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    expect(onChange).toHaveBeenLastCalledWith(['b']);
  });

  it('keeps the remaining row value after removing the first item', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ListEditor items={['first', 'second']} onChange={onChange} placeholder="" addLabel="Add" />,
    );

    await user.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    rerender(<ListEditor items={['second']} onChange={onChange} placeholder="" addLabel="Add" />);

    expect(screen.getByRole('textbox')).toHaveValue('second');
  });

  it('appends an empty row on add click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ListEditor items={['x']} onChange={onChange} placeholder="" addLabel="Add" />);
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(onChange).toHaveBeenLastCalledWith(['x', '']);
  });
});

// @vitest-environment jsdom
// UX audit D35: the one reply textarea, with the length counter every surface shows.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReplyEditor } from '@/components/dashboard/reviews/ReplyEditor';

describe('ReplyEditor', () => {
  it('renders the textarea with the shared limit and a live counter bound via aria-describedby', () => {
    const onChange = vi.fn();
    render(<ReplyEditor id="reply-x" label="Edit reply text" value="hello" onChange={onChange} />);

    const textarea = screen.getByRole('textbox', { name: 'Edit reply text' });
    expect(textarea).toHaveAttribute('maxlength', '2000');
    expect(textarea).toHaveAttribute('aria-describedby', 'reply-x-count');
    expect(screen.getByText('5 / 2000')).toHaveAttribute('id', 'reply-x-count');

    fireEvent.change(textarea, { target: { value: 'hello there' } });
    expect(onChange).toHaveBeenCalledWith('hello there');
  });

  it('takes a surface-specific class and keeps the Console default otherwise', () => {
    const { rerender } = render(<ReplyEditor id="a" value="" onChange={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveClass('textarea');
    rerender(<ReplyEditor id="a" value="" onChange={() => {}} className="pr-gen-textarea" />);
    expect(screen.getByRole('textbox')).toHaveClass('pr-gen-textarea');
  });

  it('turns the counter to the danger token when over the limit', () => {
    render(<ReplyEditor id="a" value={'x'.repeat(2001)} onChange={() => {}} />);
    expect(screen.getByText('2001 / 2000')).toHaveStyle({ color: 'var(--rw-danger)' });
  });
});

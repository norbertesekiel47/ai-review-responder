// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManualEditor } from '../ManualEditor';

describe('ManualEditor', () => {
  it('enforces the shared 2000-character reply limit', () => {
    render(<ManualEditor initialText="draft" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '2000');
    expect(screen.getByText('5 / 2000')).toBeInTheDocument();
  });
});

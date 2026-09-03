// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrintButton } from '../PrintButton';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrintButton', () => {
  it('PrintButton invokes window.print once', () => {
    vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<PrintButton />);
    fireEvent.click(screen.getByRole('button', { name: /print/i }));
    expect(window.print).toHaveBeenCalledTimes(1);
  });
});

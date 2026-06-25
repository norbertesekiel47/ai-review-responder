// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthCardShell, authFieldClass, authPrimaryButtonClass } from '../AuthCardShell';

describe('AuthCardShell', () => {
  it('renders children inside a sage page with a white rounded island and wordmark', () => {
    const { container } = render(
      <AuthCardShell>
        <p>card body</p>
      </AuthCardShell>,
    );
    expect(screen.getByText('card body')).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.className).toContain('bg-rw-sage');
    expect(container.innerHTML).toContain('rounded-[3rem]');
  });

  it('defaults to max-w-md and supports width="sm"', () => {
    const { container, rerender } = render(<AuthCardShell>x</AuthCardShell>);
    expect(container.innerHTML).toContain('max-w-md');
    rerender(<AuthCardShell width="sm">x</AuthCardShell>);
    expect(container.innerHTML).toContain('max-w-sm');
  });

  it('exports 16px field styling (iOS zoom rule) and an accessible teal primary button', () => {
    render(
      <form>
        <input aria-label="probe" className={authFieldClass} />
        <button type="submit" className={authPrimaryButtonClass}>go</button>
      </form>,
    );
    expect(screen.getByLabelText('probe').className).toContain('text-base');
    // Accessible teal token (rw-teal-strong = #557069, ADR 0004) — white text clears WCAG AA.
    expect(screen.getByRole('button', { name: 'go' }).className).toContain('bg-rw-teal-strong');
    // never the low-contrast decoration teal (rw-teal); boundary match avoids rw-teal-strong.
    expect(screen.getByRole('button', { name: 'go' }).className).not.toMatch(/rw-teal(?![-\w])/);
  });
});

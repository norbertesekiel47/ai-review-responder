// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, resolveFieldInput } from '../Field';
import { MailIcon, LockIcon } from '../Icons';

describe('Field', () => {
  it('renders a labelled input with leading icon', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Email',
        name: 'email',
        type: 'email',
        value: '',
        onChange: () => {},
        icon: createElement(MailIcon),
        autoComplete: 'email',
      }),
    );
    expect(html).toContain('Email');
    expect(html).toContain('id="email"');
    expect(html.toLowerCase()).toContain('autocomplete="email"');
    expect(html).toContain('class="rw-input-icon"');
  });
  it('renders a Show password toggle when type is password', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Password',
        name: 'password',
        type: 'password',
        value: '',
        onChange: () => {},
        icon: createElement(LockIcon),
        autoComplete: 'current-password',
      }),
    );
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('class="rw-toggle-pwd"');
    expect(html).toContain('aria-pressed="false"');
  });
  it('programmatically associates a visible error with the input', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Email',
        name: 'email',
        type: 'email',
        value: 'bad',
        onChange: () => {},
        icon: createElement(MailIcon),
        error: 'That email looks off.',
      }),
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="email-error"');
    expect(html).toContain('aria-describedby="email-error"');
    expect(html).toContain('That email looks off.');
    expect(html).toContain('has-error');
  });
});

describe('Field — password visibility toggle', () => {
  it('reveals and re-hides the password, keeping label and pressed state in step', () => {
    render(
      createElement(Field, {
        label: 'Password',
        name: 'password',
        type: 'password',
        value: 'hunter2',
        onChange: () => {},
        icon: createElement(LockIcon),
      }),
    );
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('renders no toggle for a non-password field', () => {
    render(
      createElement(Field, {
        label: 'Email',
        name: 'email',
        type: 'email',
        value: '',
        onChange: () => {},
        icon: createElement(MailIcon),
      }),
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('resolveFieldInput', () => {
  const base = { type: 'text', showPassword: false, invalid: false, errorId: 'f-error' };

  it('is a plain valid input when nothing is wrong', () => {
    expect(resolveFieldInput(base)).toEqual({
      type: 'text',
      invalid: false,
      ariaInvalid: undefined,
      describedBy: undefined,
      className: 'rw-input ',
    });
  });

  it('links its own error line ahead of the caller\'s ids and flags the input invalid', () => {
    expect(
      resolveFieldInput({ ...base, error: 'Required', describedById: 'reqs strength' }),
    ).toEqual({
      type: 'text',
      invalid: true,
      ariaInvalid: true,
      describedBy: 'f-error reqs strength',
      className: 'rw-input has-error',
    });
  });

  it('honours a caller-owned invalid state without adding an error id', () => {
    expect(resolveFieldInput({ ...base, invalid: true, describedById: 'own-feedback' })).toMatchObject({
      invalid: true,
      ariaInvalid: true,
      describedBy: 'own-feedback',
    });
  });

  it('only a password field switches to text when revealed', () => {
    expect(resolveFieldInput({ ...base, type: 'password', showPassword: true }).type).toBe('text');
    expect(resolveFieldInput({ ...base, type: 'password', showPassword: false }).type).toBe('password');
    expect(resolveFieldInput({ ...base, type: 'email', showPassword: true }).type).toBe('email');
  });
});

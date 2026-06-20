import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field } from '../Field';
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

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLeadIntakeFieldErrorProps,
  LeadIntakeForm,
  submitLeadIntake,
  validateLeadIntakeFields,
} from '../LeadIntakeForm';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LeadIntakeForm', () => {
  it('renders waitlist copy wired to the landing source', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, { intent: 'waitlist', source: 'landing' }),
    );

    expect(html).toContain('Join waitlist');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('name="source"');
    expect(html).toContain('value="landing"');
    expect(html).not.toContain('Book a Demo');
    expect(html).not.toContain('Book My Demo');
  });

  it('renders custom demo copy wired to the book-a-demo source', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, {
        intent: 'demo',
        source: 'book-a-demo',
        tone: 'light',
        copy: {
          button: 'Request demo',
          successHeading: 'Request received.',
          successBody: 'We will reach out to coordinate a demo.',
        },
      }),
    );

    expect(html).toContain('Request demo');
    expect(html).toContain('value="demo"');
    expect(html).toContain('value="book-a-demo"');
  });

  it('submits the lead intake payload to the API route as JSON', async () => {
    const response = new Response(null, { status: 204 });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response);

    await submitLeadIntake({
      name: 'Nora Reed',
      email: 'nora@example.com',
      businessName: 'Juniper Lodge',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      intent: 'waitlist',
      source: 'landing',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/lead-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Nora Reed',
        email: 'nora@example.com',
        businessName: 'Juniper Lodge',
        googleMapsUrl: 'https://maps.google.com/?cid=123',
        intent: 'waitlist',
        source: 'landing',
      }),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error('Expected fetch init payload');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Nora Reed',
      email: 'nora@example.com',
      businessName: 'Juniper Lodge',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      intent: 'waitlist',
      source: 'landing',
    });
  });

  it('scopes validation ARIA props to the invalid client field', () => {
    expect(
      validateLeadIntakeFields({
        name: '',
        email: 'nora@example.com',
        businessName: 'Juniper Lodge',
      }),
    ).toEqual({
      message: 'Please enter your name.',
      invalidField: 'name',
    });

    expect(
      validateLeadIntakeFields({
        name: 'Nora Reed',
        email: 'not-an-email',
        businessName: 'Juniper Lodge',
      }),
    ).toEqual({
      message: 'Please enter a valid email address.',
      invalidField: 'email',
    });

    expect(
      getLeadIntakeFieldErrorProps('email', 'email', 'lead-intake-test-error'),
    ).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'lead-intake-test-error',
    });
    expect(
      getLeadIntakeFieldErrorProps('googleMapsUrl', 'email', 'lead-intake-test-error'),
    ).toEqual({});
    expect(
      getLeadIntakeFieldErrorProps('email', null, 'lead-intake-test-error'),
    ).toEqual({});
  });
});

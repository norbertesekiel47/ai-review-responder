import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadIntakeForm } from '../LeadIntakeForm';
import {
  getLeadIntakeFieldErrorProps,
  submitLeadIntake,
  validateLeadIntakeFields,
} from '../LeadIntakeForm.helpers';

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

  it('renders accessible labels, required markers, and the optional url field', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, { intent: 'waitlist', source: 'landing' }),
    );

    // Real <label> elements associated to each input via htmlFor/id.
    expect(html).toContain('for="lead-intake-waitlist-landing-name"');
    expect(html).toContain('id="lead-intake-waitlist-landing-name"');
    expect(html).toContain('for="lead-intake-waitlist-landing-email"');
    expect(html).toContain('for="lead-intake-waitlist-landing-businessName"');
    expect(html).toContain('for="lead-intake-waitlist-landing-googleMapsUrl"');

    // Required fields marked; url field typed for url entry.
    expect(html).toContain('aria-required="true"');
    expect(html).toContain('type="url"');
    expect(html).toContain('inputMode="url"');

    // Privacy consent microcopy near submit.
    expect(html).toContain('Privacy Policy');
    expect(html).toContain('href="/legal/privacy"');

    // Honeypot field present but hidden from assistive tech.
    expect(html).toContain('name="company_website"');
    expect(html).toContain('tabindex="-1"');
  });

  it('validates all fields at once with a per-field error map', () => {
    expect(
      validateLeadIntakeFields({
        name: '',
        email: 'not-an-email',
        businessName: '',
        googleMapsUrl: '',
      }),
    ).toEqual({
      name: 'Please enter your name.',
      email: 'Please enter a valid email address.',
      businessName: 'Please enter your business name.',
    });

    expect(
      validateLeadIntakeFields({
        name: 'Nora Reed',
        email: 'nora@example.com',
        businessName: 'Juniper Lodge',
        googleMapsUrl: 'http://maps.google.com/?cid=123',
      }),
    ).toEqual({
      googleMapsUrl: 'Please enter a valid https link.',
    });

    expect(
      validateLeadIntakeFields({
        name: 'Nora Reed',
        email: 'nora@example.com',
        businessName: 'Juniper Lodge',
        googleMapsUrl: 'https://maps.google.com/?cid=123',
      }),
    ).toEqual({});
  });

  it('scopes validation ARIA props to fields with errors', () => {
    const errors = { email: 'Please enter a valid email address.' };

    expect(
      getLeadIntakeFieldErrorProps('email', errors, 'lead-intake-test-error'),
    ).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'lead-intake-test-error',
    });
    expect(
      getLeadIntakeFieldErrorProps('googleMapsUrl', errors, 'lead-intake-test-error'),
    ).toEqual({});
    expect(
      getLeadIntakeFieldErrorProps('email', {}, 'lead-intake-test-error'),
    ).toEqual({});
  });
});

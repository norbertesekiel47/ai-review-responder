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

    expect(html).toContain('Get early access');
    expect(html).not.toContain('Join waitlist');
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
      honeypot: '',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/lead-intake');
    if (!init) throw new Error('Expected fetch init payload');
    expect(init.method).toBe('POST');
    // The honeypot must travel to the server under its canonical field name
    // (regression guard for the dropped-honeypot bug); empty for a real user.
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Nora Reed',
      email: 'nora@example.com',
      businessName: 'Juniper Lodge',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      intent: 'waitlist',
      source: 'landing',
      company_website: '',
    });
  });

  it('sends a bot-filled honeypot to the server as company_website', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await submitLeadIntake({
      name: 'Bot',
      email: 'bot@example.com',
      businessName: 'Spam Co',
      googleMapsUrl: '',
      intent: 'waitlist',
      source: 'landing',
      honeypot: 'http://spam.example.com',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error('Expected fetch init payload');
    expect(JSON.parse(init.body as string).company_website).toBe('http://spam.example.com');
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

    // Privacy notice near submit — a notice, not a contract (M18).
    expect(html).toContain('We&#x27;ll only use this to contact you about early access.');
    expect(html).not.toContain('By joining you agree');
    expect(html).toContain('Privacy Policy');
    expect(html).toContain('href="/legal/privacy"');

    // Honeypot field present but hidden from assistive tech.
    expect(html).toContain('name="company_website"');
    expect(html).toContain('tabindex="-1"');
  });

  it('has no placeholder that repeats its label, and keeps the Maps hint visible under the label (M17)', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, { intent: 'waitlist', source: 'landing' }),
    );

    expect(html).not.toContain('placeholder="Your name"');
    expect(html).not.toContain('placeholder="Email address"');
    expect(html).not.toContain('placeholder="Business name"');
    // The Maps field keeps a format-only placeholder; its help text is a visible
    // hint the input is described by, so it does not vanish on focus.
    expect(html).toContain('placeholder="https://maps.google.com/…"');
    expect(html).not.toContain('helps us prep');
    const hintId = 'lead-intake-waitlist-landing-googleMapsUrl-hint';
    expect(html).toContain(`<p id="${hintId}"`);
    expect(html).toContain('Paste your listing’s Google Maps link so we can look at your reviews before we reach out.');
    expect(html).toMatch(new RegExp(`<input[^>]*id="lead-intake-waitlist-landing-googleMapsUrl"[^>]*aria-describedby="${hintId}"`));
    // The hint precedes the input in source order (under the label, above the field).
    expect(html.indexOf(`id="${hintId}"`)).toBeLessThan(html.indexOf('id="lead-intake-waitlist-landing-googleMapsUrl"'));
  });

  it('offsets the focus ring against the ink band it sits on, not teal (M20)', () => {
    const onInk = renderToStaticMarkup(
      createElement(LeadIntakeForm, { intent: 'waitlist', source: 'pricing', tone: 'onTeal' }),
    );
    expect(onInk).toContain('focus:ring-offset-rw-ink2');
    expect(onInk).not.toContain('focus:ring-offset-rw-teal-strong');
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

// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFILL_EMAIL_KEY } from '@/components/auth/shared/prefillEmail';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ ok: false })),
  oauthStart: vi.fn(async () => {}),
}));

vi.mock('@/components/auth/hooks/useSignupSubmit', () => ({
  useSignupSubmit: () => ({
    submit: mocks.submit,
    loading: false,
    error: '',
    errorKind: null,
    setError: () => {},
  }),
}));

vi.mock('@/components/auth/hooks/useGoogleOAuth', () => ({
  useGoogleOAuth: () => ({ start: mocks.oauthStart, loading: false, error: '' }),
}));

vi.mock('../fireConfetti', () => ({ fireConfetti: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

const { SignupForm } = await import('../SignupForm');

describe('SignupForm', () => {
  it('renders the four required fields and Terms link', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toContain('Your name');
    expect(html).toContain('Phone (optional)');
    expect(html).toContain('Work email');
    expect(html).toContain('Create a password');
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('Sign up with Google');
  });
  it('marks the submit CTA aria-disabled on first render (Terms unchecked) but keeps it clickable to surface the hint', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*aria-disabled="true"/);
    // It must NOT be hard-disabled, or the onSubmit hint could never fire.
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*\sdisabled/);
  });
  it('renders the four strength bars', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    const matches = html.match(/rw-strength-bar/g) ?? [];
    expect(matches).toHaveLength(4);
  });
  it('renders the password requirements list before submit', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toContain('rw-req-list');
    expect(html).toContain('At least 8 characters');
    expect(html).toContain('Upper &amp; lowercase letters');
    expect(html).toContain('A number');
  });
  it('labels the CTA with the verb "Create account", not a claim (A21)', () => {
    const html = renderToStaticMarkup(createElement(SignupForm));
    expect(html).toContain('Create account');
    expect(html).not.toContain('Start saving 15 hours');
  });
});

describe('SignupForm — form state through the UI', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('keeps every field controlled as the owner types', () => {
    render(createElement(SignupForm));

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sofia Reyes' } });
    fireEvent.change(screen.getByLabelText('Phone (optional)'), { target: { value: '+1 555 0136' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'sofia@shop.co' } });
    fireEvent.change(screen.getByLabelText('Create a password'), { target: { value: 'Str0ngPass!' } });

    expect(screen.getByLabelText('Your name')).toHaveValue('Sofia Reyes');
    expect(screen.getByLabelText('Phone (optional)')).toHaveValue('+1 555 0136');
    expect(screen.getByLabelText('Work email')).toHaveValue('sofia@shop.co');
    expect(screen.getByLabelText('Create a password')).toHaveValue('Str0ngPass!');
  });

  it('submitting without accepting the Terms shows the hint instead of a silent dead end', () => {
    render(createElement(SignupForm));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'sofia@shop.co' } });

    fireEvent.submit(screen.getByRole('button', { name: /create account/i }).closest('form')!);

    expect(screen.getByRole('alert')).toHaveTextContent(/accept the terms/i);
    expect(mocks.submit).not.toHaveBeenCalled();

    // Ticking the box clears the hint.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('submits the typed values once the Terms are accepted and records the signup start', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(SignupForm));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sofia Reyes' } });
    fireEvent.change(screen.getByLabelText('Phone (optional)'), { target: { value: '+1 555 0136' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'sofia@shop.co' } });
    fireEvent.change(screen.getByLabelText('Create a password'), { target: { value: 'Str0ngPass!' } });
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.submit(screen.getByRole('button', { name: /create account/i }).closest('form')!);

    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith({
        ownerEmail: 'sofia@shop.co',
        ownerName: 'Sofia Reyes',
        ownerPhone: '+1 555 0136',
        password: 'Str0ngPass!',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/enqueue', expect.anything());
    const beacon = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(beacon).toMatchObject({
      eventName: 'signup_started',
      properties: { source: 'signup_form', method: 'email' },
    });
  });

  it('prefills the email handed over from the login tab and clears the handoff', async () => {
    sessionStorage.setItem(PREFILL_EMAIL_KEY, 'carried@shop.co');

    render(createElement(SignupForm));

    await waitFor(() => expect(screen.getByLabelText('Work email')).toHaveValue('carried@shop.co'));
    expect(sessionStorage.getItem(PREFILL_EMAIL_KEY)).toBeNull();
  });

  it('the Google button starts OAuth and records the signup start with method=google', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(SignupForm));

    fireEvent.click(screen.getByRole('button', { name: /sign up with google/i }));

    await waitFor(() => expect(mocks.oauthStart).toHaveBeenCalledTimes(1));
    const beacon = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(beacon.properties).toEqual({ source: 'signup_form', method: 'google' });
  });
});

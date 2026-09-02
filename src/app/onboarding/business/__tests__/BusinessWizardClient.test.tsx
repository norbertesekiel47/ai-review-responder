// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
}));

import { BusinessWizardClient } from '../BusinessWizardClient';
import {
  ONBOARDING_CONNECTION_FAILED,
  ONBOARDING_ERROR_COPY,
} from '@/app/onboarding/_shared/onboarding-error-copy';

const initialValues = { category: '', website: '', businessName: 'Bella Vista' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// The body the wizard POSTed on the nth fetch call, parsed.
function postedBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// Walks the legacy-flow wizard Location (URL mode) → Profile → Voice.
function walkLegacyToVoice() {
  fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
  fireEvent.change(screen.getByLabelText('Google Maps URL'), {
    target: { value: 'https://maps.google.com/?cid=1' },
  });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

// Walks the demo-flow wizard Profile → Voice → Connect. Profile is prefilled
// with a business name so Continue is enabled; Voice is all-optional.
function walkToConnect() {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  fireEvent.click(screen.getByRole('button', { name: /^continue/i }));
}

describe('BusinessWizardClient — one progress system (A10, A27)', () => {
  it('renders the sub-step as text inside the step h2 and no second dot strip', () => {
    const { container } = render(
      <BusinessWizardClient initialValues={initialValues} demoFlowEnabled />,
    );

    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2).toHaveTextContent('Step 1 of 3 — Profile');
    expect(h2).toHaveTextContent('Business profile');
    // The funnel thread (the ONE progress graphic) owns the only aria-current.
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
    expect(screen.queryByText('Voice')).not.toBeInTheDocument();
  });

  it('uses the legacy names when the location is captured in the wizard', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Step 1 of 3 — Location',
    );
  });

  it('keeps one heading and one subtitle above the first field', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set up your business');
    expect(screen.getAllByRole('heading')).toHaveLength(2); // h1 + the step h2
    expect(screen.queryByText(/then we go live/i)).not.toBeInTheDocument();
  });

  it('advances the sub-step label as the owner moves through the wizard', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 2 of 3 — Voice');
  });
});

describe('BusinessWizardClient — flow-aware Voice button (A11)', () => {
  it('reads "Continue" in the demo flow, where Connect still follows', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('button', { name: /^continue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /finish setup/i })).not.toBeInTheDocument();
  });

  it('reads "Finish setup" in the legacy flow, where Voice is the last step', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    // Location step: switch to the URL input so Continue enables without Google.
    fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
    fireEvent.change(screen.getByLabelText('Google Maps URL'), {
      target: { value: 'https://maps.google.com/?cid=1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 3 of 3 — Voice');
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeInTheDocument();
  });
});

describe('BusinessWizardClient — tier-aware Connect promise (A12)', () => {
  it('promises owner approval of every reply on Copilot', () => {
    render(
      <BusinessWizardClient
        initialValues={initialValues}
        demoFlowEnabled
        subscriptionTier="copilot"
      />,
    );
    walkToConnect();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Step 3 of 3 — Connect',
    );
    expect(screen.getByText('You approve every reply before it goes live.')).toBeInTheDocument();
    expect(screen.queryByText(/veto window/i)).not.toBeInTheDocument();
  });

  it('tells an Autopilot owner that in-policy replies post after the veto window', () => {
    render(
      <BusinessWizardClient
        initialValues={initialValues}
        demoFlowEnabled
        subscriptionTier="autopilot"
      />,
    );
    walkToConnect();

    expect(
      screen.getByText(
        'Replies inside your policy post after the veto window. Everything else waits for you.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never auto-post/i)).not.toBeInTheDocument();
  });

  it('never names the vendor — describes the role instead', () => {
    const { container } = render(
      <BusinessWizardClient initialValues={initialValues} demoFlowEnabled />,
    );
    walkToConnect();

    expect(container.textContent).not.toMatch(/zernio/i);
    expect(screen.getByText(/secure Google connection partner/i)).toBeInTheDocument();
  });
});

describe('BusinessWizardClient — legacy flow submit (Voice is the last step)', () => {
  it('POSTs Profile + Location + Voice and lands on /dashboard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    walkLegacyToVoice();

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/onboarding/business');
    expect(postedBody(fetchMock)).toMatchObject({
      businessName: 'Bella Vista',
      googleMapsUrl: 'https://maps.google.com/?cid=1',
      tone: 'professional and friendly',
    });
  });

  it('"Skip for now" on Voice omits the voice fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    walkLegacyToVoice();
    fireEvent.change(screen.getByLabelText(/products|services/i), {
      target: { value: 'Espresso' },
    });

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(postedBody(fetchMock)).not.toHaveProperty('productsServices');
  });

  it('shows owner copy for an API error code and stays on the step', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate_limited' })));
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    walkLegacyToVoice();

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText(ONBOARDING_ERROR_COPY.rate_limited!)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /finish setup/i })).not.toBeDisabled();
  });

  it('follows a server redirectTo on a rejected save (e.g. session moved on)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { error: 'already_onboarded', redirectTo: '/dashboard' })),
    );
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    walkLegacyToVoice();

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByText(ONBOARDING_ERROR_COPY.already_onboarded!)).not.toBeInTheDocument();
  });

  it('shows the connection-failed copy when the POST never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    walkLegacyToVoice();

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText(ONBOARDING_CONNECTION_FAILED)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('Back on Profile returns to Location', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
    fireEvent.change(screen.getByLabelText('Google Maps URL'), {
      target: { value: 'https://maps.google.com/?cid=1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 2 of 3 — Profile');

    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 1 of 3 — Location');
  });
});

describe('BusinessWizardClient — demo flow Connect step', () => {
  it('saves, then hands the browser to the OAuth authUrl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200, { authUrl: 'https://oauth.example/consent' }));
    vi.stubGlobal('fetch', fetchMock);
    const location = { ...window.location, href: 'http://localhost/onboarding/business' };
    vi.stubGlobal('location', location);
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    walkToConnect();

    fireEvent.click(screen.getByRole('button', { name: /connect google business profile/i }));

    await waitFor(() => expect(location.href).toBe('https://oauth.example/consent'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/onboarding/business');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/zernio/connect/start');
    // Post-pay: the location was captured at /start and is never resubmitted.
    expect(postedBody(fetchMock)).not.toHaveProperty('googleMapsUrl');
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('never starts OAuth when the save itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_body' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    walkToConnect();

    fireEvent.click(screen.getByRole('button', { name: /connect google business profile/i }));

    expect(await screen.findByText(ONBOARDING_ERROR_COPY.invalid_body!)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to /dashboard with an explanation when the connect start is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(200)).mockResolvedValueOnce(jsonResponse(502)),
    );
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    walkToConnect();

    fireEvent.click(screen.getByRole('button', { name: /connect google business profile/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(screen.getByText(/could not start the google connection/i)).toBeInTheDocument();
  });

  it('falls back to /dashboard when the connect start never reaches the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200))
        .mockRejectedValueOnce(new TypeError('Failed to fetch')),
    );
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    walkToConnect();

    fireEvent.click(screen.getByRole('button', { name: /connect google business profile/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(screen.getByText(/your details are saved/i)).toBeInTheDocument();
  });

  it('"Skip for now" saves and lands on /dashboard, honouring a skipped Voice step', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByLabelText(/products|services/i), {
      target: { value: 'Espresso' },
    });
    fireEvent.click(screen.getByRole('button', { name: /skip/i })); // Voice → Connect, voice skipped

    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBody(fetchMock)).not.toHaveProperty('productsServices');
  });

  it('Back on Connect returns to Voice', () => {
    render(<BusinessWizardClient initialValues={initialValues} demoFlowEnabled />);
    walkToConnect();

    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Step 2 of 3 — Voice');
  });
});

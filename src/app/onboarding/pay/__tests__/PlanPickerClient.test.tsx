// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlanPickerClient } from '../PlanPickerClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlanPickerClient', () => {
  it('renders all four onboarding plans with canonical prices', () => {
    render(<PlanPickerClient cancelled={false} />);

    expect(
      screen.getByRole('heading', { name: 'Founding Member' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Basic' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Standard' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Premium' })).toBeInTheDocument();

    expect(screen.getByText('$19')).toBeInTheDocument();
    expect(screen.getByText('$29')).toBeInTheDocument();
    expect(screen.getByText('$79')).toBeInTheDocument();
    expect(screen.getByText('$199')).toBeInTheDocument();
  });

  it('posts tier basic when Basic is selected', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'checkout_unavailable' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanPickerClient cancelled={false} />);
    await user.click(screen.getByRole('button', { name: 'Choose Basic' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'basic' }),
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Checkout unavailable');
  });
});

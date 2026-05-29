// @vitest-environment jsdom
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocationProvider } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

const { mockCookieGet, mockRedisGet, mockVerify } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockRedisGet: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/connect/select-location',
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

vi.mock('@/lib/zernio/connect-session-cookie', () => ({
  ZERNIO_CONNECT_COOKIE_NAME: 'zernio_connect_session',
  verifySignedConnectSessionValue: (value: string | undefined) => mockVerify(value),
}));

vi.mock('@/lib/zernio/connect-state', () => ({
  locationsKey: (sessionId: string) => `connect:locations:${sessionId}`,
}));

import SelectLocationPage from '../page';

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

function wrap(ui: ReactElement) {
  return h(LocationProvider, {
    locations: [{ id: LOC, name: 'Test Biz', displayLabel: null, isPrimary: true }],
    initialScope: LOC,
    multiLocationEnabled: false,
    children: ui,
  });
}

describe('select-location page chrome', () => {
  let originalPublishingEnabled: string | undefined;

  beforeEach(() => {
    originalPublishingEnabled = process.env.ZERNIO_PUBLISHING_ENABLED;
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    mockCookieGet.mockReturnValue({ value: 'signed-cookie' });
    mockVerify.mockReturnValue('session-id');
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        locations: [{ id: 'loc-1', name: 'Acme Coffee', address: '123 Main St' }],
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPublishingEnabled === undefined) {
      delete process.env.ZERNIO_PUBLISHING_ENABLED;
    } else {
      process.env.ZERNIO_PUBLISHING_ENABLED = originalPublishingEnabled;
    }
  });

  it('renders the TopBar chrome above the location picker', async () => {
    const ui = await SelectLocationPage();
    render(wrap(ui));

    // TopBar chrome
    expect(screen.getByText('Connect Google Business')).toBeInTheDocument();
    expect(screen.getByText('Select location')).toBeInTheDocument();
    expect(screen.getByText('Back to dashboard')).toBeInTheDocument();

    // Existing picker still renders
    expect(screen.getByText('Pick a Google Business location')).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlResult } = vi.hoisted(() => ({ sqlResult: { rows: [] as unknown[] } }));
vi.mock('@/lib/db/server', () => ({
  sql: async () => sqlResult.rows,
  jsonb: (v: unknown) => v,
}));

import { GET } from '../route';

const UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';

function call(responseId: string) {
  return GET({} as never, { params: Promise.resolve({ responseId }) });
}

beforeEach(() => {
  sqlResult.rows = [];
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

describe('GET /r/google/[responseId]', () => {
  it('302-redirects to an allowlisted Google Maps URL for a posted response, with no-store', async () => {
    sqlResult.rows = [{ google_maps_url: 'https://maps.google.com/maps/place/Acme' }];
    const res = await call(UUID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://maps.google.com/maps/place/Acme');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts google.com/maps and maps.app.goo.gl short links', async () => {
    sqlResult.rows = [{ google_maps_url: 'https://www.google.com/maps/place/x' }];
    expect((await call(UUID)).status).toBe(302);
    sqlResult.rows = [{ google_maps_url: 'https://maps.app.goo.gl/abcd' }];
    expect((await call(UUID)).status).toBe(302);
  });

  it('accepts maps.google.com with a /maps path or a query, but NOT a bare arbitrary path (Codex review #3)', async () => {
    sqlResult.rows = [{ google_maps_url: 'https://maps.google.com/?cid=12345' }];
    expect((await call(UUID)).status).toBe(302);
    sqlResult.rows = [{ google_maps_url: 'https://maps.google.com/maps/place/x' }];
    expect((await call(UUID)).status).toBe(302);
    // bare arbitrary path on the maps subdomain (no /maps path, no query) is no
    // longer blindly trusted → unavailable.
    sqlResult.rows = [{ google_maps_url: 'https://maps.google.com/redirect/somewhere' }];
    expect((await call(UUID)).status).toBe(200);
  });

  it('renders the unavailable PAGE (not a redirect) when google_maps_url is null', async () => {
    sqlResult.rows = [{ google_maps_url: null }];
    const res = await call(UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
  });

  it('renders unavailable when no posted response matches the id', async () => {
    sqlResult.rows = [];
    expect((await call(UUID)).status).toBe(200);
  });

  it('REFUSES to open-redirect off a non-Google host', async () => {
    sqlResult.rows = [{ google_maps_url: 'https://evil.example.com/maps' }];
    const res = await call(UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a non-https Google URL', async () => {
    sqlResult.rows = [{ google_maps_url: 'http://maps.google.com/x' }];
    expect((await call(UUID)).status).toBe(200);
  });

  it('rejects a non-UUID responseId as unavailable', async () => {
    expect((await call('not-a-uuid')).status).toBe(200);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PerLocationOverride } from '@/lib/channels/overrides-view';
import {
  channelIcon,
  channelLabel,
  formatOverrideLocationLabel,
  groupInactiveOverrides,
  groupOverridesByLocation,
  mutateOverride,
  removeOverrideConsequence,
} from '../PerLocationOverridePanel.helpers';

function override(partial: Partial<PerLocationOverride> & Pick<PerLocationOverride, 'enrollmentId' | 'locationId'>): PerLocationOverride {
  return {
    channel: 'telegram',
    locationName: 'Downtown',
    handle: null,
    status: 'verified',
    archived: false,
    ...partial,
  } as PerLocationOverride;
}

describe('channel labels', () => {
  it('names the known channels and falls back to the id', () => {
    expect(channelLabel('email')).toBe('Email');
    expect(channelLabel('whatsapp')).toBe('WhatsApp');
    expect(channelLabel('carrier-pigeon')).toBe('carrier-pigeon');
    expect(channelIcon('telegram')).toBe('💬');
    expect(channelIcon('carrier-pigeon')).toBe('📡');
  });
});

describe('formatOverrideLocationLabel / removeOverrideConsequence', () => {
  it('suffixes archived locations at render time only', () => {
    expect(formatOverrideLocationLabel(override({ enrollmentId: 'e1', locationId: 'l1' }))).toBe('Downtown');
    expect(formatOverrideLocationLabel(override({ enrollmentId: 'e1', locationId: 'l1', archived: true }))).toBe(
      'Downtown (archived)',
    );
  });

  it('spells out which setting the location falls back to', () => {
    expect(removeOverrideConsequence(override({ enrollmentId: 'e1', locationId: 'l1', channel: 'whatsapp' }))).toBe(
      'Downtown will go back to your account-wide WhatsApp setting.',
    );
  });
});

describe('groupOverridesByLocation', () => {
  it('indexes by location in first-seen order, preserving row order within a location', () => {
    const a1 = override({ enrollmentId: 'a1', locationId: 'a' });
    const b1 = override({ enrollmentId: 'b1', locationId: 'b' });
    const a2 = override({ enrollmentId: 'a2', locationId: 'a', channel: 'email' });
    const grouped = groupOverridesByLocation([a1, b1, a2]);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')).toEqual([a1, a2]);
    expect(grouped.get('b')).toEqual([b1]);
  });
});

describe('groupInactiveOverrides', () => {
  it('classifies by the archived flag, not by membership in the active ids', () => {
    const activeSole = override({ enrollmentId: 'e1', locationId: 'active' });
    const archived = override({ enrollmentId: 'e2', locationId: 'active', archived: true });
    const orphan = override({ enrollmentId: 'e3', locationId: 'gone' });
    const grouped = groupInactiveOverrides([activeSole, archived, orphan], new Set(['active']));
    expect(grouped.get('active')).toEqual([archived]);
    expect(grouped.get('gone')).toEqual([orphan]);
    expect([...grouped.values()].flat()).not.toContain(activeSole);
  });

  it('is empty when every override sits on an active, non-archived location', () => {
    expect(groupInactiveOverrides([override({ enrollmentId: 'e1', locationId: 'a' })], new Set(['a'])).size).toBe(0);
  });
});

describe('mutateOverride', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs / DELETEs the location + channel and resolves on 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(mutateOverride('POST', 'Add', 'loc-1', 'telegram')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/channels/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: 'loc-1', channel: 'telegram' }),
    });
  });

  it('throws the server error string, or a status fallback when the body is unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Not eligible' }, { status: 409 })));
    await expect(mutateOverride('DELETE', 'Remove', 'loc-1', 'telegram')).rejects.toThrow('Not eligible');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(mutateOverride('DELETE', 'Remove', 'loc-1', 'telegram')).rejects.toThrow('Remove failed (500)');
  });
});

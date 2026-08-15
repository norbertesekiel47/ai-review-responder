import { describe, it, expect } from 'vitest';
import { flagOff } from '../flag-off';

// flagOff() is channel-agnostic and portal-agnostic, so its direct coverage
// belongs beside the module (with runners.test.ts and resolve-actor.test.ts),
// not inside a per-channel env suite. It previously had one copy in each of
// src/lib/notifications/channels/__tests__/{telegram,whatsapp}-env.test.ts —
// duplicated coverage of one function, and the only two `src/lib → src/app`
// imports in the repo, on the branch whose whole purpose is deleting a
// backwards dependency between those trees.
describe('flagOff', () => {
  it('returns 404 not_found', async () => {
    const res = flagOff();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });
});

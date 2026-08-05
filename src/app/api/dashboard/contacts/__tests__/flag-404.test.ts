import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireWritableOwner, mockRequireOwnerWithAccount } = vi.hoisted(() => ({
  mockRequireWritableOwner: vi.fn(),
  mockRequireOwnerWithAccount: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    // Identity same-origin wrapper: this file exercises only the flag gate,
    // which must fire before any auth work.
    withSameOrigin: () =>
      <TArgs extends unknown[]>(handler: (...args: TArgs) => unknown) => handler,
    requireWritableOwner: (...args: unknown[]) => mockRequireWritableOwner(...args),
    requireOwnerWithAccount: (...args: unknown[]) => mockRequireOwnerWithAccount(...args),
  };
});

import { POST as uploadsPost } from '../uploads/route';
import { GET as uploadStatusGet } from '../uploads/[id]/route';
import { GET as contactsListGet } from '../route';
import { DELETE as contactDelete } from '../[id]/route';
import {
  DELETE as suppressionClear,
  POST as suppressionMark,
} from '../[id]/suppression/route';

const UPLOAD_ID = '01900000-0000-7000-8000-000000000001';
const CONTACT_ID = '01900000-0000-7000-8000-000000000002';

// Every /api/dashboard/contacts/* route registers here; Task 6 appends its
// GET-list + DELETE entries so the flag gate stays covered in one place.
const routes: ReadonlyArray<{ name: string; invoke: () => Promise<Response> }> = [
  {
    name: 'POST /api/dashboard/contacts/uploads',
    invoke: () => uploadsPost(
      new NextRequest('http://localhost:3000/api/dashboard/contacts/uploads', {
        method: 'POST',
      }),
    ),
  },
  {
    name: 'GET /api/dashboard/contacts/uploads/[id]',
    invoke: () => uploadStatusGet(
      new NextRequest(`http://localhost:3000/api/dashboard/contacts/uploads/${UPLOAD_ID}`),
      { params: Promise.resolve({ id: UPLOAD_ID }) },
    ),
  },
  {
    name: 'GET /api/dashboard/contacts',
    invoke: () => contactsListGet(
      new NextRequest('http://localhost:3000/api/dashboard/contacts'),
    ),
  },
  {
    name: 'DELETE /api/dashboard/contacts/[id]',
    invoke: () => contactDelete(
      new NextRequest(`http://localhost:3000/api/dashboard/contacts/${CONTACT_ID}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    ),
  },
  {
    name: 'POST /api/dashboard/contacts/[id]/suppression',
    invoke: () => suppressionMark(
      new NextRequest(
        `http://localhost:3000/api/dashboard/contacts/${CONTACT_ID}/suppression`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    ),
  },
  {
    name: 'DELETE /api/dashboard/contacts/[id]/suppression',
    invoke: () => suppressionClear(
      new NextRequest(
        `http://localhost:3000/api/dashboard/contacts/${CONTACT_ID}/suppression`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    ),
  },
];

describe('SOLICITATION_WATCH_ENABLED route gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('contacts API routes return 404 when SOLICITATION_WATCH_ENABLED is off', async () => {
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', undefined);

    for (const route of routes) {
      const response = await route.invoke();
      expect(response.status, route.name).toBe(404);
    }

    // The 404 must be decided BEFORE auth: an off flag means the surface
    // does not exist, and must not leak an auth-shaped response instead.
    expect(mockRequireWritableOwner).not.toHaveBeenCalled();
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
  });
});

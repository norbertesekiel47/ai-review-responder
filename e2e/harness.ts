// E2E auth harness — Supabase `auth.admin` wrapper for the auth-funnel specs
// (forgot-password / reset-password / signup-google / signup-password).
//
// Backing project: the STAGING Supabase (locked decision 2026-06-11 — local
// runs only; CI never gets these secrets, so the specs self-skip there).
// Map the env from .env.staging.local before running:
//
//   export E2E_SUPABASE_URL=$STAGING_NEXT_PUBLIC_SUPABASE_URL
//   export E2E_SUPABASE_SERVICE_KEY=$STAGING_SUPABASE_SERVICE_KEY
//
// IMPORTANT: the app under test must point at the SAME Supabase project
// (export NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_URL / SUPABASE_SERVICE_KEY to the staging values too) or the
// sessions/links the harness mints will not be valid for the app.
// See docs/runbooks/e2e-local-setup.md §auth-harness.
//
// Cleanup discipline: staging Auth is SHARED state. Every spec must call
// cleanup helpers in `finally`; emails are unique per run so a crashed run
// never collides with the next one.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  seedAuthOwnerAccount,
  cleanupAuthOwnerAccount,
  getE2eSql,
  type AuthOwnerSeedData,
} from './seed';

export const isAuthHarnessConfigured: boolean =
  !!process.env.E2E_SUPABASE_URL && !!process.env.E2E_SUPABASE_SERVICE_KEY;

/**
 * Deep-tier gate (explicit opt-in). The app reads `users` through BOTH
 * Postgres.js (DATABASE_POOL_URL) and supabase-js/PostgREST (the Supabase
 * project's own Postgres), so the deep auth specs (recovery callback,
 * reset happy-path, link replay, signup-google) only work when
 * TEST_DATABASE_POOL_URL points at the SAME database as E2E_SUPABASE_URL —
 * i.e. the staging Postgres. That seeds/cleans rows in shared staging state,
 * so it never happens implicitly: set E2E_AUTH_DEEP=true deliberately.
 * Recipe + residue check: docs/runbooks/e2e-local-setup.md §auth-harness.
 */
export const isDeepAuthConfigured: boolean =
  isAuthHarnessConfigured && process.env.E2E_AUTH_DEEP === 'true';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

let _admin: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_KEY are not set — gate specs on isAuthHarnessConfigured before calling the harness.',
    );
  }
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

function uniqueEmail(prefix: string): string {
  // Unique per run; the domain never receives mail (one transactional send can
  // bounce on the happy-path forgot-password spec — accepted, see runbook).
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@e2e.repworth.net`;
}

export interface OwnerHandle {
  email: string;
  password: string;
  authUserId: string;
  seed: AuthOwnerSeedData;
}

export interface AdminHandle {
  email: string;
  password: string;
  authUserId: string;
  userId: string;
}

/**
 * Full owner: staging Auth user (confirmed, password-capable) + the complete
 * account/users/businesses row set in the TEST database so the app recognizes
 * the identity end-to-end (login destination, dashboard, forgot-password role
 * lookup).
 */
export async function createOwnerUser(): Promise<OwnerHandle> {
  const email = uniqueEmail('e2e-owner');
  const password = `pw-${randomUUID()}`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'E2E Harness Owner' },
  });
  if (error || !data.user) throw new Error(`createOwnerUser failed: ${error?.message}`);
  const seed = await seedAuthOwnerAccount({ ownerEmail: email, authUserId: data.user.id });
  return { email, password, authUserId: data.user.id, seed };
}

/** Staging Auth user + a bare role='admin' users row (no account/business). */
export async function createAdminUser(): Promise<AdminHandle> {
  const email = uniqueEmail('e2e-admin');
  const password = `pw-${randomUUID()}`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'E2E Harness Admin' },
  });
  if (error || !data.user) throw new Error(`createAdminUser failed: ${error?.message}`);
  const userId = randomUUID();
  const sql = getE2eSql();
  await sql`
    INSERT INTO users (id, name, email, role, auth_id, account_id)
    VALUES (${userId}::uuid, 'E2E Harness Admin', ${email}, 'admin', ${data.user.id}, NULL)
  `;
  return { email, password, authUserId: data.user.id, userId };
}

/**
 * Recovery URL via the admin API — no email is sent for THIS call.
 *
 * Deliberately NOT the `action_link` (Supabase's hosted /verify): that
 * redirect honors only the project's Redirect-URL allow-list, so localhost
 * runs bounce to the staging Site URL (behind Vercel SSO). Instead we build
 * the APP's own callback URL from `hashed_token` — the callback verifies it
 * server-side via `verifyOtp` (the documented token_hash lane) and sets
 * session cookies itself. Same shape the production email template emits.
 */
export async function getResetUrl(
  email: string,
  next = '/reset-password',
): Promise<string> {
  const { data, error } = await adminClient().auth.admin.generateLink({
    type: 'recovery',
    email,
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    throw new Error(`generateLink(recovery) failed: ${error?.message}`);
  }
  return `${APP_URL}/api/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=recovery&flow=owner&next=${encodeURIComponent(next)}`;
}

/**
 * Materialize an authenticated browser session WITHOUT real OAuth: mint a
 * magic link and drive the page straight to the app callback's token_hash
 * lane — the app verifies and sets its cookies itself (no hand-crafted
 * `sb-*-auth-token`, no dependency on the Supabase redirect allow-list).
 */
export async function signInViaMagicLink(
  page: Page,
  email: string,
  next = '/signup/finish',
): Promise<void> {
  const { data, error } = await adminClient().auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    throw new Error(`generateLink(magiclink) failed: ${error?.message}`);
  }
  await page.goto(
    `${APP_URL}/api/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&flow=owner&next=${encodeURIComponent(next)}`,
  );
  await page.waitForURL((url) => url.origin === APP_URL && !url.pathname.startsWith('/api/'), {
    timeout: 15_000,
  });
}

/**
 * Bare confirmed auth user with NO app-DB rows — the post-OAuth state
 * /signup/finish expects (it provisions users/account/business itself).
 */
export async function createBareAuthUser(): Promise<{ email: string; authUserId: string }> {
  const email = uniqueEmail('e2e-google');
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'E2E Google User' },
  });
  if (error || !data.user) throw new Error(`createBareAuthUser failed: ${error?.message}`);
  return { email, authUserId: data.user.id };
}

/**
 * Cleanup for flows where the APP provisioned the rows (finish-signup):
 * walk users.auth_id → account → businesses and delete whatever exists,
 * then the staging Auth user.
 */
export async function deleteProvisionedOwner(authUserId: string): Promise<void> {
  const sql = getE2eSql();
  const [userRow] = await sql<{ id: string; account_id: string | null }[]>`
    SELECT id, account_id FROM users WHERE auth_id = ${authUserId} LIMIT 1
  `;
  if (userRow) {
    if (userRow.account_id) {
      await sql`DELETE FROM channel_enrollments WHERE business_id IN
        (SELECT id FROM businesses WHERE account_id = ${userRow.account_id}::uuid)`;
      await sql`DELETE FROM businesses WHERE account_id = ${userRow.account_id}::uuid`;
      await sql`UPDATE users SET account_id = NULL WHERE id = ${userRow.id}::uuid`;
      await sql`DELETE FROM accounts WHERE id = ${userRow.account_id}::uuid`;
    }
    await sql`DELETE FROM users WHERE id = ${userRow.id}::uuid`;
  }
  await adminClient().auth.admin.deleteUser(authUserId);
}

export async function deleteOwnerUser(handle: OwnerHandle): Promise<void> {
  await cleanupAuthOwnerAccount(handle.seed);
  await adminClient().auth.admin.deleteUser(handle.authUserId);
}

export async function deleteAdminUser(handle: AdminHandle): Promise<void> {
  const sql = getE2eSql();
  await sql`DELETE FROM users WHERE id = ${handle.userId}::uuid`;
  await adminClient().auth.admin.deleteUser(handle.authUserId);
}

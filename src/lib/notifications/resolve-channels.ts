// src/lib/notifications/resolve-channels.ts
//
// Single chokepoint that resolves channels for a given (accountId, locationId).
// Queries channel_enrollments WHERE account_id = $accountId AND
// (location_id = $locationId OR location_id IS NULL), groups by channel,
// prefers per-location override over org-default. Ignores archived,
// unverified, and unsubscribed rows. Returns at most one enrollment per
// channel. Upstash/Redis cache with 5-min TTL keyed on (account_id, location_id),
// write-invalidation on channel_enrollments writes.
//
// Validation contract: VAL-NOTIF-001 through VAL-NOTIF-010, VAL-NOTIF-020.
// Coding convention: AGENTS.md — "Import resolveChannels(accountId, locationId)
// from this module. Never query channel_enrollments directly for notification dispatch."

import type { Sql } from 'postgres';
import { getCacheRedis } from '../db/redis-cache';
import { CHANNEL_IDS } from './channels/types';
import type { ChannelId } from './channels/types';
import type { AccountId, LocationId } from '../shared/ids';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedChannel {
  channel: ChannelId;
  handle: string;
  /** null for org-default enrollments, non-null for per-location overrides. */
  location_id: string | null;
}

// ── Cache constants ─────────────────────────────────────────────────────────

// v2: SMS removal; old namespace may contain stale 'sms' resolutions
const CACHE_PREFIX = 'rch:channels:v2:';
const CACHE_TTL_SECONDS = 300; // 5 minutes

function cacheKey(accountId: string, locationId: string): string {
  return `${CACHE_PREFIX}${accountId}:${locationId}`;
}

function accountCachePattern(accountId: string): string {
  return `${CACHE_PREFIX}${accountId}:*`;
}

// ── resolveChannels ─────────────────────────────────────────────────────────

/**
 * Resolves the set of active channels for a given (accountId, locationId).
 *
 * Resolution logic:
 * 1. Check cache — return cached result if present.
 * 2. Check if the location is archived — return empty if so (VAL-NOTIF-020).
 * 3. Query channel_enrollments for both org-default (location_id IS NULL)
 *    and per-location override (location_id = $locationId) rows.
 * 4. Group by channel — per-location override beats org-default (VAL-NOTIF-003).
 * 5. Cache the result with 5-min TTL (VAL-NOTIF-008).
 *
 * Filters applied by the SQL query:
 * - status = 'verified' only (VAL-NOTIF-006)
 * - archived_at IS NULL (VAL-NOTIF-005)
 * - unsubscribed_at IS NULL (VAL-NOTIF-007)
 */
export async function resolveChannels(
  sql: Sql,
  accountId: AccountId,
  locationId: LocationId,
): Promise<ResolvedChannel[]> {
  // 1. Check cache
  const redis = getCacheRedis();
  const cached = await redis.get(cacheKey(accountId, locationId));
  if (cached) {
    return JSON.parse(cached) as ResolvedChannel[];
  }

  // 2. Check if the location is archived (VAL-NOTIF-020)
  const [archivedRow] = await sql<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${accountId}::uuid
  `;

  // If the location doesn't exist or is archived, return empty channels
  if (!archivedRow || archivedRow.archived_at !== null) {
    // Cache the empty result too
    await redis.set(cacheKey(accountId, locationId), JSON.stringify([]), 'EX', CACHE_TTL_SECONDS);
    return [];
  }

  // 3. Query channel_enrollments
  const rows = await sql<{
    channel: ChannelId;
    handle: string;
    location_id: string | null;
  }[]>`
    SELECT channel, handle, location_id
    FROM channel_enrollments
    WHERE account_id = ${accountId}::uuid
      AND (location_id = ${locationId}::uuid OR location_id IS NULL)
      AND status = 'verified'
      AND archived_at IS NULL
      AND unsubscribed_at IS NULL
      AND channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
    ORDER BY
      -- Per-location overrides first so the dedup loop prefers them
      CASE WHEN location_id IS NOT NULL THEN 0 ELSE 1 END,
      created_at ASC
  `;

  // 4. Deduplicate by channel — per-location override beats org-default.
  //    VAL-NOTIF-003: Per-location override beats org-default for the SAME channel.
  //    We iterate all rows and prefer the per-location override when both exist.
  const byChannel = new Map<ChannelId, ResolvedChannel>();

  for (const row of rows) {
    const existing = byChannel.get(row.channel);
    // Per-location override (location_id IS NOT NULL) beats org-default (location_id IS NULL)
    if (!existing) {
      byChannel.set(row.channel, {
        channel: row.channel,
        handle: row.handle,
        location_id: row.location_id,
      });
    } else if (row.location_id !== null && existing.location_id === null) {
      // Override beats org-default
      byChannel.set(row.channel, {
        channel: row.channel,
        handle: row.handle,
        location_id: row.location_id,
      });
    }
    // else: both are same scope (both org-default or both per-location) —
    // keep the first one (stable, deterministic).
  }

  // Sort by channel for deterministic output order (matches original
  // getVerifiedEnrollments behavior of ORDER BY created_at ASC).
  const result: ResolvedChannel[] = Array.from(byChannel.values()).sort(
    (a, b) => a.channel.localeCompare(b.channel),
  );

  // 5. Cache the result (VAL-NOTIF-008)
  await redis.set(cacheKey(accountId, locationId), JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);

  return result;
}

// ── invalidateChannelCache ──────────────────────────────────────────────────

/**
 * Invalidates all cached channel resolutions for a given account.
 * Call this on any channel_enrollments INSERT, UPDATE, or DELETE for that
 * account (VAL-NOTIF-009).
 *
 * Uses KEYS to find all cache entries for this account, then DELetes them.
 * For small-scale cache (5-min TTL, per-account keys) this is fine.
 * At scale, consider using SCAN instead of KEYS.
 */
export async function invalidateChannelCache(accountId: AccountId): Promise<void> {
  const redis = getCacheRedis();
  const pattern = accountCachePattern(accountId);
  const keys = await redis.keys(pattern);

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

export interface ChannelCacheInvalidationLogger {
  warn: (message: string, meta?: unknown) => void;
}

/**
 * Best-effort cache invalidation wrapper for write paths. Redis failures must
 * not roll back enrollment writes, but they should be visible in logs because a
 * stale channel cache can briefly affect notification routing.
 */
export async function safeInvalidateChannelCache(
  accountId: AccountId,
  context: string,
  logger: ChannelCacheInvalidationLogger = console,
): Promise<void> {
  try {
    await invalidateChannelCache(accountId);
  } catch (err) {
    logger.warn('channel-cache-invalidate-failed', {
      accountId,
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

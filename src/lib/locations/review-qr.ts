// src/lib/locations/review-qr.ts
//
// Review QR + QR redirect domain module (docs/context/review-qr.md "Review QR" /
// "QR redirect"). Two callers cross this seam: the public /q/[businessId]
// route (resolveQrRedirect) and the owner settings section
// (getOwnerReviewQrLocations). sql arrives as a parameter (invariant #15).
//
// The write-review prefix is deliberately a third private spelling of the
// format (url-parser.ts RECOGNISES it; solicitation/dispatch.ts builds the
// THROWING variant for the send lane, where an upstream gate guarantees
// canonicality). This builder returns null instead: for a scanner, a
// non-canonical place id is an unavailable page, not an assertion failure —
// nothing upstream guarantees canonicality here.
//
// v1 counts every successful resolve as a scan — HEAD requests and link
// prefetchers included (accepted noise, intake edge case).
//
// Scale ceiling (adversarial R1 A3): the list loader generates one 2048px
// PNG per location, ~130ms each, sequentially. Location counts are
// quota-bounded today (accounts.locations_included), so the settings list
// stays server-rendered; an on-demand QR asset endpoint is the named escape
// if quotas grow. Single-location callers (the print view) use
// getOwnerReviewQrLocation and generate exactly one QR.

import QRCode from 'qrcode';
import type { Sql } from 'postgres';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { subscriptionAllowsQrRedirect } from '@/lib/shared/subscription-status';
import { getLocationsForAccount, getQrRedirectRow, type LocationRow } from './repo';

const GOOGLE_WRITE_REVIEW_URL_PREFIX =
  'https://search.google.com/local/writereview?placeid=';

/** Print-quality edge length for the downloadable PNG. */
const QR_PNG_WIDTH = 2048;

/**
 * The Google write-review deep link for a place id, or null when the value
 * is not a canonical Place ID (hex CIDs resolve to nothing at Google —
 * migration 007 legacy rows).
 */
export function buildWriteReviewUrl(placeId: string | null): string | null {
  const candidate = placeId?.trim() ?? '';
  if (!isPlaceId(candidate)) return null;
  return `${GOOGLE_WRITE_REVIEW_URL_PREFIX}${encodeURIComponent(candidate)}`;
}

export type QrRedirectResolution =
  | { kind: 'redirect'; url: string; accountId: string }
  | {
      kind: 'unavailable';
      reason: 'not_found' | 'archived' | 'subscription' | 'bad_place_id';
    };

/**
 * Resolve one QR scan. Refusal order: not_found → archived → subscription →
 * bad_place_id (most-specific first). Pure result, no side effects — the
 * route owns the 302, the page, the log line and the analytics insert. The
 * read itself lives in repo.ts (getQrRedirectRow) — that module owns every
 * location query, and the tenant-scope allowlist is STATEMENT-granular, so
 * placing it there exempts nothing else (codex R3 #7).
 */
export async function resolveQrRedirect(
  sql: Sql,
  businessId: string,
): Promise<QrRedirectResolution> {
  const row = await getQrRedirectRow(sql, businessId);
  if (!row) return { kind: 'unavailable', reason: 'not_found' };
  if (row.archived_at !== null) return { kind: 'unavailable', reason: 'archived' };
  if (!subscriptionAllowsQrRedirect(row.subscription_status)) {
    return { kind: 'unavailable', reason: 'subscription' };
  }
  const url = buildWriteReviewUrl(row.google_place_id);
  if (url === null) return { kind: 'unavailable', reason: 'bad_place_id' };
  return { kind: 'redirect', url, accountId: row.account_id };
}

export interface OwnerReviewQrLocation {
  businessId: string;
  displayName: string;
  /** The URL the QR encodes — the QR redirect hop, never the Google URL. */
  qrTargetUrl: string;
  /** PNG data URL (2048px), null when the location is not QR-eligible. */
  qrDataUrl: string | null;
  /** null when eligible; the only v1 ineligibility is a non-canonical place id. */
  ineligibleReason: 'bad_place_id' | null;
}

/**
 * Every non-archived location of ONE account, with its QR (or the reason it
 * has none). Reads through repo.ts's getLocationsForAccount — that module
 * owns location reads (codex R1 finding 15); re-spelling its query here
 * would be a second owner. appUrl is passed in by the composition root —
 * this module never reads env (invariant #15 posture).
 */
export async function getOwnerReviewQrLocations(
  sql: Sql,
  accountId: string,
  appUrl: string,
): Promise<OwnerReviewQrLocation[]> {
  const base = requireQrBase(appUrl);
  const rows = await getLocationsForAccount(sql, accountId);
  const locations: OwnerReviewQrLocation[] = [];
  // Sequential on purpose: ci:pool-fanout forbids Promise combinators over
  // src/lib/locations, and N is small.
  for (const row of rows) {
    locations.push(await toOwnerReviewQrLocation(row, base));
  }
  return locations;
}

/**
 * ONE location of ONE account, with its QR — the print view's loader
 * (adversarial R1 A3a: the list loader would generate a QR per location to
 * render one). Account scope stays structural: the lookup happens INSIDE
 * the caller's account-scoped list, so a foreign businessId is null, never
 * data. Exactly one QR is generated, for the found row.
 */
export async function getOwnerReviewQrLocation(
  sql: Sql,
  accountId: string,
  businessId: string,
  appUrl: string,
): Promise<OwnerReviewQrLocation | null> {
  const base = requireQrBase(appUrl);
  const rows = await getLocationsForAccount(sql, accountId);
  const row = rows.find((entry) => entry.id === businessId);
  if (!row) return null;
  return toOwnerReviewQrLocation(row, base);
}

/** Shared appUrl guard: a QR encoding a relative URL is a config defect. */
function requireQrBase(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  if (base === '') {
    throw new Error('review-qr: appUrl is required to build QR target URLs');
  }
  return base;
}

async function toOwnerReviewQrLocation(
  row: LocationRow,
  base: string,
): Promise<OwnerReviewQrLocation> {
  const qrTargetUrl = `${base}/q/${row.id}`;
  const eligible = buildWriteReviewUrl(row.google_place_id) !== null;
  return {
    businessId: row.id,
    displayName: row.display_label ?? row.name,
    qrTargetUrl,
    qrDataUrl: eligible
      ? await QRCode.toDataURL(qrTargetUrl, { margin: 1, width: QR_PNG_WIDTH })
      : null,
    ineligibleReason: eligible ? null : 'bad_place_id',
  };
}

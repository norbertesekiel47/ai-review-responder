/**
 * Landing footer copy.
 *
 * ── What may not appear here ──────────────────────────────────────────────
 * The pattern this footer was adapted from ships a contact block with an
 * email, a phone number and a city, plus five social accounts. RepWorth has
 * none of those beyond the address below, and a footer is exactly where an
 * invented phone number or a `href="#"` social icon looks most credible and
 * does most damage. Do not add one until it is real.
 *
 * Link labels and hrefs are NOT here either — `src/components/ui/marketing-links.ts`
 * is their single owner, shared with SiteFooter and the nav, so a route change
 * lands in one place. This file holds only the strings that exist nowhere else.
 */

import { PRODUCT_BLURB } from '@/components/ui/marketing-links';

/** The published contact address, matching `src/lib/legal/content.ts` — which
 *  names it as the contact of record in the privacy notice. If that changes,
 *  change it there first; the legal document is the authority, not this file. */
export const SUPPORT_EMAIL = 'support@repworth.net';

/**
 * The blurb is the SAME sentence SiteFooter shows on every other page —
 * `PRODUCT_BLURB` in marketing-links.ts owns it, so the two footers describe
 * one product. It keeps the page's argument rather than a feature list:
 * "supervised" is the whole claim the page has spent nine sections earning,
 * and "Google reviews" is the shipped scope, stated plainly. It says nothing
 * about Solicitor, CRM, social or multi-platform, all of which are unbuilt —
 * see future-copy.ts.
 */
export const BLURB = PRODUCT_BLURB;

/** Rendered as the outlined display graphic. Uppercased in CSS rather than in
 *  the string, so the accessible copy of the brand name elsewhere on the page
 *  stays normally cased. */
export const WORDMARK = 'RepWorth';

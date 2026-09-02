// Single owner of the public marketing pages' link facts (label + href).
// Surfaces (SiteNav, SiteFooter's Product column, the landing nav) compose
// their OWN ordering from these entries; the label/href pair is declared once.

export const MARKETING_LINKS = {
  features: { label: 'Features', href: '/features' },
  howItWorks: { label: 'How it works', href: '/how-it-works' },
  pricing: { label: 'Pricing', href: '/pricing' },
} as const;

export type MarketingLink = (typeof MARKETING_LINKS)[keyof typeof MARKETING_LINKS];

/** Header-nav order (SiteNav + landing nav). SiteFooter's Product column
 *  renders this same list, so the two chrome surfaces list the pages in one
 *  order. */
export const NAV_LINKS: readonly MarketingLink[] = [
  MARKETING_LINKS.features,
  MARKETING_LINKS.howItWorks,
  MARKETING_LINKS.pricing,
];

/** Footer legal links, in SiteFooter's canonical order. Shared by SiteFooter's
 *  Legal column and the landing page's act-3 footer bar. */
export const LEGAL_LINKS = [
  { label: 'Privacy', href: '/legal/privacy' },
  { label: 'Terms', href: '/legal/terms' },
  { label: 'Security', href: '/security' },
  { label: 'Sub-processors', href: '/legal/sub-processors' },
  { label: 'Cookies', href: '/legal/cookies' },
  { label: 'AUP', href: '/legal/aup' },
] as const;

/** Footer company links (SiteFooter's Company column + the landing footer). */
export const COMPANY_LINKS = [{ label: 'Contact', href: '/help/contact' }] as const;

/**
 * The one early-access door while self-serve signup is off. Every pill, h1
 * and page title that asks for the same thing uses this label — one action,
 * one phrase — and points at the lead-capture route. Demos are not bookable
 * yet, so the route keeps its name while the label does not promise one.
 */
export const EARLY_ACCESS_CTA = { label: 'Get early access', href: '/book-a-demo' } as const;

/**
 * How the site chrome describes the product — the SiteFooter blurb and the
 * landing footer's blurb are this same sentence, so the two footers cannot
 * drift into describing two different products. "Team" is the chrome noun;
 * "fleet" stays inside the landing page's own voice copy.
 */
export const PRODUCT_BLURB =
  'A supervised team of AI agents for your Google reviews. Every action is recorded, and nothing posts outside the gate you control.';

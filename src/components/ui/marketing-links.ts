// Single owner of the public marketing pages' link facts (label + href).
// Surfaces (SiteNav, SiteFooter's Product column, the landing nav) compose
// their OWN ordering from these entries; the label/href pair is declared once.

export const MARKETING_LINKS = {
  features: { label: 'Features', href: '/features' },
  howItWorks: { label: 'How it works', href: '/how-it-works' },
  pricing: { label: 'Pricing', href: '/pricing' },
} as const;

export type MarketingLink = (typeof MARKETING_LINKS)[keyof typeof MARKETING_LINKS];

/** Header-nav order (SiteNav + landing nav). The footer's Product column uses
 *  its own historical order; compose there, don't reorder here. */
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

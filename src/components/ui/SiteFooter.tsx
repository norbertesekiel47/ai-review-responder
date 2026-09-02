import Image from 'next/image';
import Link from 'next/link';

import { COMPANY_LINKS, LEGAL_LINKS, NAV_LINKS, PRODUCT_BLURB } from './marketing-links';

/**
 * Site-wide marketing footer — Daylight Gallery II chrome: bone surface,
 * brand + blurb, three link columns, a grid-width hairline, and the
 * copyright line (styles: `.rw-foot-dl*` in (public)/_styles/island.css).
 *
 * Self-contained (`<footer className="rw-foot rw-foot-dl">`) so pages can
 * render `<SiteFooter />` directly; SiteShell also renders it as the last
 * child of the island on every marketing page. The base `rw-foot` class stays
 * for the content tests and the legacy `.rw-foot > a` rule (the auth island's
 * inline mode-switch line); `.rw-foot-dl` carries the redesigned layout.
 */

interface FooterColumn {
  heading: string;
  links: ReadonlyArray<{ label: string; href: string }>;
}

const FOOTER_COLUMNS: ReadonlyArray<FooterColumn> = [
  {
    heading: 'Product',
    // The header's order, so the footer never lists the pages differently.
    links: NAV_LINKS,
  },
  {
    heading: 'Legal',
    links: LEGAL_LINKS,
  },
  {
    heading: 'Company',
    links: COMPANY_LINKS,
  },
];

export function SiteFooter() {
  return (
    <footer className="rw-foot rw-foot-dl">
      <div className="rw-foot-cols">
        <div>
          <Link href="/" className="rw-foot-brand">
            <Image src="/logo.svg" alt="" width={26} height={26} unoptimized />
            <span>RepWorth</span>
          </Link>
          <p className="rw-foot-blurb">{PRODUCT_BLURB}</p>
        </div>
        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            {/* h3, not h4: pages put their sections at h2, so h4 skipped a level
                and broke the outline on every surface this footer renders on.
                `.rw-foot-h` styles by class, so nothing moves. */}
            <h3 className="rw-foot-h">{column.heading}</h3>
            <ul className="rw-foot-list">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="rw-foot-copy-row">
        <div className="rw-foot-copy">
          <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}

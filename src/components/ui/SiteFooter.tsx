import Link from 'next/link';

/**
 * Site-wide marketing footer. Self-contained (`<footer className="rw-foot">`) so
 * pages can render `<SiteFooter />` directly; SiteShell also renders it as the
 * last child of the island on every marketing page.
 *
 * The global `.rw-foot` rule is a two-item `space-between` flex row, so this
 * component overrides that container to a stacked column (link grid + a bottom
 * copyright bar) via Tailwind. The legacy link rule is scoped to direct-child
 * anchors (`.rw-foot > a`), so the column links here — nested in `ul > li > a` —
 * keep their own Tailwind color/spacing utilities instead of the inline-row look.
 */

interface FooterColumn {
  heading: string;
  links: ReadonlyArray<{ label: string; href: string }>;
}

const FOOTER_COLUMNS: ReadonlyArray<FooterColumn> = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'How it works', href: '/how-it-works' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '/legal/privacy' },
      { label: 'Terms', href: '/legal/terms' },
      { label: 'Security', href: '/security' },
      { label: 'Sub-processors', href: '/legal/sub-processors' },
      { label: 'Cookies', href: '/legal/cookies' },
      { label: 'AUP', href: '/legal/aup' },
    ],
  },
  {
    heading: 'Company',
    links: [{ label: 'Contact', href: '/help/contact' }],
  },
];

export function SiteFooter() {
  return (
    <footer className="rw-foot flex-col items-stretch">
      <div className="grid w-full grid-cols-1 gap-8 sm:grid-cols-3">
        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.heading} aria-label={column.heading} className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold uppercase tracking-wider text-rw-teal-strong">
              {column.heading}
            </span>
            <ul className="flex flex-col gap-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="ml-0 text-sm text-rw-teal-strong transition-colors hover:text-rw-teal-strong/80 focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="mt-2 w-full border-t border-rw-teal/15 pt-4 text-rw-teal-strong">
        <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
      </div>
    </footer>
  );
}

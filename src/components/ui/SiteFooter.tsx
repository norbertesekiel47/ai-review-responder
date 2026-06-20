import Link from 'next/link';

/**
 * Site-wide marketing footer. Self-contained (`<footer className="rw-foot">`) so
 * pages can render `<SiteFooter />` directly; SiteShell also renders it as the
 * last child of the island on every marketing page.
 *
 * The global `.rw-foot` rule is a two-item `space-between` flex row, so this
 * component overrides that container to a stacked column (link grid + a bottom
 * copyright bar) via Tailwind. Each link resets the global `.rw-foot a`
 * left-margin (`ml-0`) so columns stack cleanly instead of inheriting the
 * inline-row spacing.
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
            <span className="text-[13px] font-semibold uppercase tracking-wider text-[#557069]">
              {column.heading}
            </span>
            <ul className="flex flex-col gap-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="ml-0 text-sm text-[#557069] transition-colors hover:text-[#557069]/80 focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="mt-2 w-full border-t border-[#97B3AE]/15 pt-4 text-[#557069]">
        <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
      </div>
    </footer>
  );
}

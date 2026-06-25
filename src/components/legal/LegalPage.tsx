import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import { SiteFooter } from '@/components/ui/SiteFooter';
import type { LegalDoc } from '@/lib/legal/content';

const CROSS_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Privacy', href: '/legal/privacy' },
  { label: 'Terms', href: '/legal/terms' },
  { label: 'Security', href: '/security' },
  { label: 'Sub-processors', href: '/legal/sub-processors' },
  { label: 'Cookies', href: '/legal/cookies' },
  { label: 'AUP', href: '/legal/aup' },
];

/**
 * Derives a stable, URL-safe anchor id from a section heading so the in-page
 * table of contents and each `<h2>` agree on the same fragment target.
 */
function sectionAnchorId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  const tableCaption = `${doc.title} sub-processor table`;

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main id="main-content" className="px-8 py-16 md:px-16">
        <article className="mx-auto max-w-2xl">
          <h1 className="mb-2 text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-rw-ink">
            {doc.title}
          </h1>
          <p className="mb-10 text-sm text-rw-teal-strong">
            Version {doc.version} - Effective {doc.effectiveDate}
          </p>

          {doc.sections.length > 1 && (
            <nav
              aria-label="On this page"
              className="mb-12 rounded-2xl border border-rw-teal/20 bg-white/50 p-5"
            >
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-rw-teal-strong">
                On this page
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {doc.sections.map((section) => (
                  <li key={section.heading}>
                    <a
                      href={`#${sectionAnchorId(section.heading)}`}
                      className="text-sm text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
                    >
                      {section.heading}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="space-y-8 text-rw-ink-soft">
            {doc.sections.map((section) => (
              <section key={section.heading} className="space-y-3">
                <h2
                  id={sectionAnchorId(section.heading)}
                  className="text-xl font-medium text-rw-ink [scroll-margin-top:6rem]"
                >
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p key={paragraph} className="text-base leading-relaxed">
                    {paragraph}
                  </p>
                ))}
                {section.bullets && (
                  <ul className="list-disc space-y-2 pl-5 text-base leading-relaxed">
                    {section.bullets.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {section.table && (
                  <div>
                    <p className="mb-2 text-sm text-rw-teal-strong sm:hidden" aria-hidden="true">
                      Scroll the table sideways to see every column &rarr;
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <caption className="sr-only">
                          {tableCaption}. Scroll horizontally to see all columns.
                        </caption>
                        <thead>
                          <tr className="border-b border-rw-teal/30">
                            {section.table.headers.map((header) => (
                              <th
                                key={header}
                                scope="col"
                                className="py-2 pr-6 text-left font-medium text-rw-ink"
                              >
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-rw-teal/20">
                          {section.table.rows.map((row) => (
                            <tr key={row.join('|')}>
                              {row.map((cell, index) => (
                                <td
                                  key={`${row[0]}-${cell}`}
                                  className={`py-2 pr-6 ${
                                    index === 0
                                      ? 'whitespace-nowrap font-medium text-rw-ink'
                                      : 'text-rw-ink-soft'
                                  }`}
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>

          <nav
            aria-label="Other legal documents"
            className="mt-12 border-t border-rw-teal/20 pt-8"
          >
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-rw-teal-strong">
              Other documents
            </h2>
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {CROSS_LINKS.filter((link) => link.href !== `/legal/${doc.slug}`).map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-8">
            <Link
              href="/"
              className="text-sm text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
            >
              Back to home
            </Link>
          </div>
        </article>
      </main>
      <SiteFooter />
    </PageShell>
  );
}

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
          <h1 className="mb-2 text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-[#2a2a2a]">
            {doc.title}
          </h1>
          <p className="mb-10 text-sm text-[#557069]">
            Version {doc.version} - Effective {doc.effectiveDate}
          </p>

          {doc.sections.length > 1 && (
            <nav
              aria-label="On this page"
              className="mb-12 rounded-2xl border border-[#97B3AE]/20 bg-white/50 p-5"
            >
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[#557069]">
                On this page
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {doc.sections.map((section) => (
                  <li key={section.heading}>
                    <a
                      href={`#${sectionAnchorId(section.heading)}`}
                      className="text-sm text-[#557069] underline decoration-[#557069]/40 underline-offset-2 hover:decoration-[#557069]"
                    >
                      {section.heading}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="space-y-8 text-[#6a6a6a]">
            {doc.sections.map((section) => (
              <section key={section.heading} className="space-y-3">
                <h2
                  id={sectionAnchorId(section.heading)}
                  className="text-xl font-medium text-[#2a2a2a] [scroll-margin-top:6rem]"
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
                    <p className="mb-2 text-sm text-[#557069] sm:hidden" aria-hidden="true">
                      Scroll the table sideways to see every column &rarr;
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <caption className="sr-only">
                          {tableCaption}. Scroll horizontally to see all columns.
                        </caption>
                        <thead>
                          <tr className="border-b border-[#97B3AE]/30">
                            {section.table.headers.map((header) => (
                              <th
                                key={header}
                                scope="col"
                                className="py-2 pr-6 text-left font-medium text-[#2a2a2a]"
                              >
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#97B3AE]/20">
                          {section.table.rows.map((row) => (
                            <tr key={row.join('|')}>
                              {row.map((cell, index) => (
                                <td
                                  key={`${row[0]}-${cell}`}
                                  className={`py-2 pr-6 ${
                                    index === 0
                                      ? 'whitespace-nowrap font-medium text-[#2a2a2a]'
                                      : 'text-[#6a6a6a]'
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
            className="mt-12 border-t border-[#97B3AE]/20 pt-8"
          >
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[#557069]">
              Other documents
            </h2>
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {CROSS_LINKS.filter((link) => link.href !== `/legal/${doc.slug}`).map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-[#557069] underline decoration-[#557069]/40 underline-offset-2 hover:decoration-[#557069]"
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
              className="text-sm text-[#557069] underline decoration-[#557069]/40 underline-offset-2 hover:decoration-[#557069]"
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

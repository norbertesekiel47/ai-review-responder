import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import type { LegalDoc } from '@/lib/legal/content';

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main className="px-8 py-16 md:px-16">
        <article className="mx-auto max-w-3xl">
          <h1 className="mb-2 text-3xl font-medium text-[#2a2a2a]">
            {doc.title}
          </h1>
          <p className="mb-10 text-sm text-[#97B3AE]">
            Version {doc.version} - Effective {doc.effectiveDate}
          </p>
          <div className="space-y-8 text-[#4a4a4a]">
            {doc.sections.map((section) => (
              <section key={section.heading} className="space-y-3">
                <h2 className="text-xl font-medium text-[#2a2a2a]">
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p key={paragraph} className="text-sm leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
          <div className="mt-12 border-t border-[#97B3AE]/20 pt-8">
            <Link href="/" className="text-sm text-[#97B3AE] hover:underline">
              Back to home
            </Link>
          </div>
        </article>
      </main>
    </PageShell>
  );
}

import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import { SiteFooter } from '@/components/ui/SiteFooter';

export const metadata: Metadata = {
  title: 'Security · RepWorth',
  description:
    'How RepWorth protects review, billing, and approval data: scoped access, hashed approval tokens, and explicit owner approval before posting.',
};

export default function SecurityPage() {
  const selfServeEnabled = selfServeSignupEnabled();

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main id="main-content" className="px-8 py-16 md:px-16">
        <div className="mx-auto max-w-2xl space-y-8">
          <header>
            <h1 className="mb-2 text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-rw-ink">Security</h1>
            <p className="text-lg leading-relaxed text-rw-ink-soft">
              RepWorth protects review, billing, and approval data with scoped access, hashed
              approval tokens, and explicit owner approval before posting.
            </p>
          </header>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-rw-ink">Vulnerability disclosure</h2>
            <p className="text-lg leading-relaxed text-rw-ink-soft">
              Report suspected vulnerabilities to{' '}
              <a
                className="text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
                href="mailto:security@repworth.net"
              >
                security@repworth.net
              </a>
              . We will acknowledge receipt, investigate in good faith, and avoid legal action
              for good-faith research that avoids data destruction, service disruption, and
              access to other customers&apos; data.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-rw-ink">Current status</h2>
            <ul className="list-disc space-y-2 pl-5 text-lg text-rw-ink-soft">
              <li>Approval tokens are stored as SHA-256 hashes, not raw tokens.</li>
              <li>Customer-facing posting requires explicit owner approval.</li>
              <li>
                Tenant access is enforced in application code — every owner read and write is
                scoped to your account and location. Row-level security policies are additionally
                enabled on protected database tables as a defense-in-depth backstop.
              </li>
              <li>
                Likely protected health information (PHI) in imported review text is blocked
                before persistence or logging.
              </li>
              <li>SOC 2 audit is not yet complete.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-rw-ink">Legal and privacy</h2>
            <p className="text-lg leading-relaxed text-rw-ink-soft">
              See{' '}
              <Link
                href="/legal/privacy"
                className="text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
              >
                Privacy
              </Link>
              ,{' '}
              <Link
                href="/legal/terms"
                className="text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
              >
                Terms
              </Link>
              , and{' '}
              <Link
                href="/legal/sub-processors"
                className="text-rw-teal-strong underline decoration-rw-teal-strong/40 underline-offset-2 hover:decoration-rw-teal-strong"
              >
                Sub-processors
              </Link>
              .
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </PageShell>
  );
}

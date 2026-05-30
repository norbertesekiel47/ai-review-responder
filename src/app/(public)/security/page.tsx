import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

export default function SecurityPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main className="px-8 py-16 md:px-16">
        <div className="mx-auto max-w-3xl space-y-8">
          <header>
            <h1 className="mb-2 text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-[#2a2a2a]">Security</h1>
            <p className="text-lg leading-relaxed text-[#6a6a6a]">
              RepWorth protects review, billing, and approval data with scoped access, hashed
              approval tokens, and explicit owner approval before posting.
            </p>
          </header>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-[#2a2a2a]">Vulnerability disclosure</h2>
            <p className="text-lg leading-relaxed text-[#6a6a6a]">
              Report suspected vulnerabilities to{' '}
              <a className="text-[#97B3AE] hover:underline" href="mailto:security@repworth.net">
                security@repworth.net
              </a>
              . We will acknowledge receipt, investigate in good faith, and avoid legal action
              for good-faith research that avoids data destruction, service disruption, and
              access to other customers&apos; data.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-[#2a2a2a]">Current status</h2>
            <ul className="list-disc space-y-2 pl-5 text-lg text-[#6a6a6a]">
              <li>Approval tokens are stored as SHA-256 hashes, not raw tokens.</li>
              <li>Customer-facing posting requires explicit owner approval.</li>
              <li>Tenant access is app-scoped and protected by RLS on authenticated reads.</li>
              <li>Likely PHI in imported review text is blocked before persistence or logging.</li>
              <li>SOC 2 audit is not yet complete.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-medium text-[#2a2a2a]">Legal and privacy</h2>
            <p className="text-lg leading-relaxed text-[#6a6a6a]">
              See{' '}
              <Link href="/legal/privacy" className="text-[#97B3AE] hover:underline">
                Privacy
              </Link>
              ,{' '}
              <Link href="/legal/terms" className="text-[#97B3AE] hover:underline">
                Terms
              </Link>
              , and{' '}
              <Link href="/legal/sub-processors" className="text-[#97B3AE] hover:underline">
                Sub-processors
              </Link>
              .
            </p>
          </section>
        </div>
      </main>
    </PageShell>
  );
}

import { headers } from 'next/headers';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export default function PrivacyPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';

  return (
    <PageShell sections={[]}>
      <SiteNav comingSoon={comingSoon} />
      <div className="px-8 md:px-16 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-medium text-[#2a2a2a] mb-2">Privacy Policy</h1>
          <p className="text-sm text-[#97B3AE] mb-10">Last updated: April 20, 2026</p>

          <div className="prose prose-sm max-w-none text-[#4a4a4a] space-y-8">
            <section>
              <p className="leading-relaxed">
                RepWorth (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the
                RepWorth service at repworth.net. This policy describes what data we collect, how
                we use it, and your rights.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">1. Data We Collect</h2>
              <ul className="space-y-2 list-none pl-0">
                <li><strong className="text-[#2a2a2a]">Account data.</strong> Your name, email address, and business name when you register.</li>
                <li><strong className="text-[#2a2a2a]">Review data.</strong> Google Business reviews associated with your business, fetched via SerpAPI on your behalf.</li>
                <li><strong className="text-[#2a2a2a]">Response data.</strong> AI-generated review response drafts and any edits you make before approving them.</li>
                <li><strong className="text-[#2a2a2a]">Usage data.</strong> Approval actions, response edits, and settings changes.</li>
                <li><strong className="text-[#2a2a2a]">Payment data.</strong> Handled entirely by Stripe. We store only your Stripe customer ID and subscription status — never raw card numbers.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">2. How We Use Your Data</h2>
              <ul className="space-y-2 list-none pl-0">
                <li>To generate AI response drafts for your Google reviews.</li>
                <li>To send approval, notification, and weekly summary emails to your address.</li>
                <li>To process subscription billing via Stripe.</li>
                <li>To improve service reliability and detect misuse.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">3. Third-Party Processors</h2>
              <ul className="space-y-2 list-none pl-0">
                <li><strong className="text-[#2a2a2a]">Google (via SerpAPI)</strong> — review data retrieval.</li>
                <li><strong className="text-[#2a2a2a]">OpenAI / Anthropic</strong> — AI response generation. Review text is sent to these APIs for processing.</li>
                <li><strong className="text-[#2a2a2a]">Stripe</strong> — payment processing and subscription management.</li>
                <li><strong className="text-[#2a2a2a]">Resend</strong> — transactional email delivery.</li>
                <li><strong className="text-[#2a2a2a]">Supabase</strong> — database hosting. Data is stored in the United States.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">4. Data Retention</h2>
              <p className="leading-relaxed">
                Account and review data is retained while your subscription is active. Upon
                cancellation or account deletion, personal data is removed within 30 days.
                Anonymised aggregate statistics may be retained indefinitely to improve the service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. Your Rights</h2>
              <p className="leading-relaxed">
                You may request access to, correction of, or deletion of your personal data at any
                time. Email us at{' '}
                <a href="mailto:norbertesekiel@gmail.com" className="text-[#97B3AE] hover:underline">
                  norbertesekiel@gmail.com
                </a>{' '}
                and we will respond within 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. Security</h2>
              <p className="leading-relaxed">
                All data is encrypted in transit (TLS 1.2+) and at rest. Approval tokens are stored
                as one-way SHA-256 hashes and never in plaintext.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Changes to This Policy</h2>
              <p className="leading-relaxed">
                We will notify registered users by email of material changes to this policy at
                least 14 days before they take effect.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Contact</h2>
              <p className="leading-relaxed">
                RepWorth<br />
                Email:{' '}
                <a href="mailto:norbertesekiel@gmail.com" className="text-[#97B3AE] hover:underline">
                  norbertesekiel@gmail.com
                </a>
              </p>
            </section>
          </div>

          <div className="mt-12 pt-8 border-t border-[#97B3AE]/20">
            <Link href="/" className="text-sm text-[#97B3AE] hover:underline">
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

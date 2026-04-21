import { headers } from 'next/headers';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export default function TermsPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';

  return (
    <PageShell sections={[]}>
      <SiteNav comingSoon={comingSoon} />
      <div className="px-8 md:px-16 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-medium text-[#2a2a2a] mb-2">Terms of Service</h1>
          <p className="text-sm text-[#97B3AE] mb-10">Last updated: April 20, 2026</p>

          <div className="prose prose-sm max-w-none text-[#4a4a4a] space-y-8">
            <section>
              <p className="leading-relaxed">
                By creating an account or using the RepWorth service at repworth.net
                (&ldquo;Service&rdquo;), you agree to these Terms. If you do not agree, do not use
                the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">1. The Service</h2>
              <p className="leading-relaxed">
                RepWorth monitors your Google Business Profile reviews, generates AI-drafted
                response suggestions in your business voice, and emails those drafts for your
                review. No response is published to Google without your explicit approval. You
                remain solely responsible for all content posted under your business accounts.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">2. Eligibility</h2>
              <p className="leading-relaxed">
                You must be at least 18 years old and have authority to act on behalf of the
                business you register. One account per business. You are responsible for keeping
                your login credentials secure.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">3. Acceptable Use</h2>
              <p className="leading-relaxed">
                You may not use RepWorth to generate misleading, defamatory, or harassing content;
                to violate Google&apos;s Terms of Service or any applicable law; or to circumvent
                these Terms. We reserve the right to suspend accounts that violate this section
                without notice.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">4. Subscription and Billing</h2>
              <p className="leading-relaxed">
                Subscriptions are charged monthly in advance via Stripe. Prices are displayed at
                checkout and may change with 30 days&apos; written notice. You may cancel at any
                time from your account Settings; cancellation takes effect at the end of the current
                billing period. No refunds are issued for partial months.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. AI-Generated Content</h2>
              <p className="leading-relaxed">
                Response drafts are suggestions only. We make no warranty regarding their accuracy,
                appropriateness, tone, or fitness for any purpose. You are responsible for reviewing
                all drafts before approving them for posting to Google.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. Intellectual Property</h2>
              <p className="leading-relaxed">
                You retain ownership of your review data and any response content you produce. You
                grant RepWorth a limited, non-exclusive licence to process that data solely to
                operate the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Disclaimer of Warranties</h2>
              <p className="leading-relaxed">
                The Service is provided &ldquo;as is&rdquo; without warranty of any kind, express
                or implied, including implied warranties of merchantability, fitness for a
                particular purpose, or non-infringement.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Limitation of Liability</h2>
              <p className="leading-relaxed">
                To the maximum extent permitted by applicable law, RepWorth&apos;s total liability
                for any claim arising out of or related to the Service is limited to the fees you
                paid in the three months preceding the claim. We are not liable for indirect,
                incidental, consequential, or punitive damages.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">9. Termination</h2>
              <p className="leading-relaxed">
                Either party may terminate the agreement at any time. We may suspend or terminate
                your account for cause immediately, or without cause on 30 days&apos; notice. Upon
                termination, your access ends and your data is deleted per our{' '}
                <Link href="/privacy" className="text-[#97B3AE] hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">10. Governing Law</h2>
              <p className="leading-relaxed">
                These Terms are governed by the laws of the State of California, without regard to
                conflict-of-law principles. Any dispute shall be resolved in the courts of Los
                Angeles County, California.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">11. Contact</h2>
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

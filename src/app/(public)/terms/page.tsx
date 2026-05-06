import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

export default function TermsPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <div className="px-8 md:px-16 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-medium text-[#2a2a2a] mb-2">Terms of Service</h1>
          <p className="text-sm text-[#97B3AE] mb-10">Last updated: April 20, 2026</p>

          <div className="prose prose-sm max-w-none text-[#4a4a4a] space-y-8">
            <section>
              <p className="leading-relaxed">
                By creating an account or using the Repworth service at repworth.net
                (&ldquo;Service&rdquo;), you agree to these Terms. If you do not agree, do not use
                the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">1. The Service</h2>
              <p className="leading-relaxed">
                Repworth monitors your Google Business Profile reviews, generates AI-drafted
                response suggestions in your business voice, and delivers those drafts for your
                review via email and/or SMS. No response is published to Google without your
                explicit approval. You remain solely responsible for all content posted under your
                business accounts.
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
                You may not use Repworth to generate misleading, defamatory, or harassing content;
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
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. SMS Notifications</h2>
              <p className="leading-relaxed mb-4">
                By providing your mobile phone number and checking the opt-in box during
                registration, you consent to receive recurring automated SMS messages from Repworth,
                including:
              </p>
              <ul className="space-y-1 list-disc pl-5 mb-4">
                <li>Alerts when new Google reviews are received for your business.</li>
                <li>Notifications when AI-generated response drafts are ready for your approval.</li>
              </ul>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Consent is not a condition of purchase.</strong>{' '}
                You may use the Service without opting in to SMS notifications.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Message frequency</strong> varies based on your
                review volume, typically 1–10 messages per week.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Message and data rates may apply</strong>{' '}
                depending on your mobile carrier plan.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">To opt out</strong>, reply{' '}
                <strong className="text-[#2a2a2a]">STOP</strong> to any SMS message at any time.
                You will receive a final confirmation and no further messages will be sent. To
                re-subscribe, reply <strong className="text-[#2a2a2a]">START</strong>.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">For help</strong>, reply{' '}
                <strong className="text-[#2a2a2a]">HELP</strong> to any SMS message or contact us
                at{' '}
                <a href="mailto:hello@repworth.com" className="text-[#97B3AE] hover:underline">
                  info@repworth.com
                </a>
                .
              </p>
              <p className="leading-relaxed">
                Repworth will never share, sell, or rent your mobile phone number or SMS opt-in
                status to third parties or affiliates for marketing or promotional purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. AI-Generated Content</h2>
              <p className="leading-relaxed">
                Response drafts are suggestions only. We make no warranty regarding their accuracy,
                appropriateness, tone, or fitness for any purpose. You are responsible for reviewing
                all drafts before approving them for posting to Google.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Intellectual Property</h2>
              <p className="leading-relaxed">
                You retain ownership of your review data and any response content you produce. You
                grant Repworth a limited, non-exclusive licence to process that data solely to
                operate the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Disclaimer of Warranties</h2>
              <p className="leading-relaxed">
                The Service is provided &ldquo;as is&rdquo; without warranty of any kind, express
                or implied, including implied warranties of merchantability, fitness for a
                particular purpose, or non-infringement.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">9. Limitation of Liability</h2>
              <p className="leading-relaxed">
                To the maximum extent permitted by applicable law, Repworth&apos;s total liability
                for any claim arising out of or related to the Service is limited to the fees you
                paid in the three months preceding the claim. We are not liable for indirect,
                incidental, consequential, or punitive damages.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">10. Termination</h2>
              <p className="leading-relaxed">
                Either party may terminate the agreement at any time. We may suspend or terminate
                your account for cause immediately, or without cause on 30 days&apos; notice. Upon
                termination, your access ends and your data is deleted per our{' '}
                <Link href="/privacy" className="text-[#97B3AE] hover:underline">
                  Privacy Policy
                </Link>
                . SMS opt-in consent is also revoked and your mobile number removed within 30 days
                of termination.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">11. Governing Law</h2>
              <p className="leading-relaxed">
                These Terms are governed by the laws of the State of California, without regard to
                conflict-of-law principles. Any dispute shall be resolved in the courts of Los
                Angeles County, California.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">12. Changes to These Terms</h2>
              <p className="leading-relaxed">
                We will notify registered users by email of material changes to these Terms at
                least 14 days before they take effect. Continued use of the Service after that date
                constitutes acceptance of the updated Terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">13. Contact</h2>
              <p className="leading-relaxed">
                Repworth<br />
                Email:{' '}
                <a href="mailto:info@repworth.net" className="text-[#97B3AE] hover:underline">
                  info@repworth.net
                </a><br />
                Website: repworth.net
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

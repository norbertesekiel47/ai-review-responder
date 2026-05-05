import { headers } from 'next/headers';
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

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
                Repworth (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the
                Repworth service at repworth.net. This policy describes what data we collect, how
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
                <li><strong className="text-[#2a2a2a]">SMS/mobile data.</strong> If you opt in to SMS notifications during onboarding, we collect your mobile phone number solely to deliver review alerts and response approval notifications. This information is never shared with third parties or affiliates for marketing or promotional purposes.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">2. How We Use Your Data</h2>
              <ul className="space-y-2 list-none pl-0">
                <li>To generate AI response drafts for your Google reviews.</li>
                <li>To send approval, notification, and weekly summary emails to your address.</li>
                <li>To send SMS notifications about new reviews and response drafts, if you have opted in.</li>
                <li>To process subscription billing via Stripe.</li>
                <li>To improve service reliability and detect misuse.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">3. SMS Messaging Program</h2>
              <p className="leading-relaxed mb-4">
                If you provide your mobile phone number and opt in during account registration,
                Repworth will send you SMS notifications including:
              </p>
              <ul className="space-y-1 list-disc pl-5 mb-4">
                <li>Alerts when new Google reviews are received for your business.</li>
                <li>Notifications when AI-generated response drafts are ready for your approval.</li>
              </ul>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Consent:</strong> Opt-in is obtained via an
                unchecked checkbox during account registration. By checking this box, you expressly
                consent to receive recurring automated text messages from Repworth. Consent is not
                a condition of purchase.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Message frequency:</strong> Message frequency
                varies based on your review volume, typically 1–10 messages per week.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Rates:</strong> Message and data rates may
                apply depending on your mobile carrier plan.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Opt-out:</strong> Reply{' '}
                <strong className="text-[#2a2a2a]">STOP</strong> at any time to unsubscribe. You
                will receive a final confirmation message and no further SMS messages will be sent.
              </p>
              <p className="leading-relaxed mb-2">
                <strong className="text-[#2a2a2a]">Help:</strong> Reply{' '}
                <strong className="text-[#2a2a2a]">HELP</strong> for assistance or contact us at{' '}
                <a href="mailto:hello@repworth.com" className="text-[#97B3AE] hover:underline">
                  hello@repworth.com
                </a>
                .
              </p>
              <p className="leading-relaxed">
                <strong className="text-[#2a2a2a]">Data sharing:</strong> Mobile opt-in data and
                your mobile phone number will never be shared, sold, or rented to third parties or
                affiliates for marketing or promotional purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">4. Third-Party Processors</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-[#97B3AE]/20">
                      <th className="text-left py-2 pr-6 font-medium text-[#2a2a2a]">Processor</th>
                      <th className="text-left py-2 font-medium text-[#2a2a2a]">Purpose</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#97B3AE]/10">
                    {[
                      { name: 'Google (via SerpAPI)', purpose: 'Review data retrieval' },
                      { name: 'OpenAI / Anthropic', purpose: 'AI response generation. Review text is sent to these APIs for processing.' },
                      { name: 'Stripe', purpose: 'Payment processing and subscription management' },
                      { name: 'Resend', purpose: 'Transactional email delivery' },
                      { name: 'Twilio', purpose: 'SMS notification delivery' },
                      { name: 'Supabase', purpose: 'Database hosting. Data is stored in the United States.' },
                    ].map(({ name, purpose }) => (
                      <tr key={name}>
                        <td className="py-2 pr-6 font-medium text-[#2a2a2a] whitespace-nowrap">{name}</td>
                        <td className="py-2 text-[#4a4a4a]">{purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. Data Retention</h2>
              <p className="leading-relaxed">
                Account and review data is retained while your subscription is active. Upon
                cancellation or account deletion, personal data is removed within 30 days. Mobile
                phone numbers collected for SMS are removed within the same 30-day window.
                Anonymised aggregate statistics may be retained indefinitely to improve the service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. Your Rights</h2>
              <p className="leading-relaxed">
                You may request access to, correction of, or deletion of your personal data at any
                time — including your mobile number and SMS opt-in status. Email us at{' '}
                <a href="mailto:info@repworth.net" className="text-[#97B3AE] hover:underline">
                  info@repworth.net
                </a>{' '}
                and we will respond within 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Security</h2>
              <p className="leading-relaxed">
                All data is encrypted in transit (TLS 1.2+) and at rest. Approval tokens are stored
                as one-way SHA-256 hashes and never in plaintext. Mobile phone numbers are stored in
                encrypted form and access is restricted to authorised systems only.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Changes to This Policy</h2>
              <p className="leading-relaxed">
                We will notify registered users by email of material changes to this policy at
                least 14 days before they take effect.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">9. Contact</h2>
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

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { SiteShell } from '@/components/ui/SiteShell';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Service closed',
  description:
    'RepWorth has shut down and is no longer taking sign-ups. How to ask for a copy of your data, or for its deletion.',
};

// The privacy policy routes data-access and deletion requests to this mailbox
// (docs/legal/repworth-privacy-policy.md, "Your Rights"), and it stays
// monitored after the shutdown.
const SUPPORT_EMAIL = 'support@repworth.net';

const FACTS: readonly { label: string; body: ReactNode }[] = [
  {
    label: 'Customers',
    body: 'We contacted every existing customer directly before the shutdown.',
  },
  {
    label: 'Your data',
    body: (
      <>
        To ask for a copy of your data, or for its deletion, email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="rw-dl-txtlink">
          {SUPPORT_EMAIL}
        </a>
        .
      </>
    ),
  },
  {
    label: 'Google replies',
    body: 'Replies already posted to your Google Business Profile stay there. You can edit or remove them in Google.',
  },
];

/**
 * The shutdown notice. Signup, login, the lead-capture route and every
 * backend-dependent page redirect here (next.config.mjs), and the site-wide
 * `ClosedBanner` links here. Fully static on purpose: no flags, no data, no
 * fetch — it has to render with the whole backend switched off. The nav runs
 * in its `comingSoon` posture so it offers no signup door.
 */
export default function ClosedPage() {
  return (
    <SiteShell scope="rw-closed-page" comingSoon>
      <section className="rw-dl-band">
        <div className="rw-dl-col">
          <div className="mx-auto max-w-[680px] font-[family-name:var(--rw-font-body)] font-normal text-rw-ink2">
            <p className="text-[13px] text-[var(--rw-ink2-mute)]">Service notice · October 2026</p>
            <h1 className="rw-dl-h2 mt-4">RepWorth has closed.</h1>
            <p className="rw-dl-lede mt-5">
              We have shut down RepWorth. We are no longer taking sign-ups, and the app, the
              dashboard and approval links are switched off.
            </p>

            {/* The `.rw-dl-card` anatomy (paper, hairline, 8px radius, 28px
                sides) in utilities, with the vertical padding moved onto the
                rows so each row's hairline divider sits midway between rows. */}
            <dl className="mt-12 rounded-lg border border-[var(--rw-line)] bg-rw-paper px-7 py-2">
              {FACTS.map(({ label, body }, index) => (
                <div
                  key={label}
                  className={`grid gap-1 py-5 sm:grid-cols-[160px_1fr] sm:gap-6 ${
                    index > 0 ? 'border-t border-[var(--rw-line)]' : ''
                  }`}
                >
                  <dt className="text-[13px] text-[var(--rw-ink2-mute)] sm:pt-0.5">{label}</dt>
                  <dd className="text-base leading-relaxed">{body}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-10">
              <Link href="/" className="rw-dl-txtlink">
                Back to home <span aria-hidden="true">→</span>
              </Link>
            </p>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

'use client';

import { useRef } from 'react';
import { m } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import { SiteFooter } from '@/components/ui/SiteFooter';
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const WAITLIST_BULLETS = [
  'Get notified when early access opens for your area',
  'Help us prioritize your business and location',
  'Share your Google Maps listing so setup is faster later',
  'Move cleanly into a demo request when bookings reopen',
];

const TRUST_SIGNALS = [
  'Built for local business owners',
  'Your data is never shared or sold',
  'No commitment while you wait',
];

export function BookADemoContent({ selfServeEnabled = false }: { selfServeEnabled?: boolean }) {
  const formRef = useRef<HTMLDivElement>(null);
  const sections = [{ ref: formRef, label: 'Waitlist' }];
  const prefersReducedMotion = usePrefersReducedMotion();

  const fadeUp = (delay: number) =>
    prefersReducedMotion
      ? { initial: false as const, animate: { opacity: 1, y: 0 } }
      : {
          initial: { opacity: 0, y: 20 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay },
        };

  return (
    <PageShell sections={sections}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      <main id="main-content">
      {/* Main content */}
      <div ref={formRef} className="px-8 py-16 md:py-24 bg-gradient-to-b from-white to-rw-cream/30">
        <div className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-start">
            {/* Left: pitch */}
            <m.div {...fadeUp(0.2)}>
              <p className="text-sm tracking-wider uppercase text-rw-teal-strong mb-4">Early access</p>
              <h1 className="text-4xl md:text-5xl font-medium leading-tight text-rw-ink mb-6">
                Join the RepWorth early access waitlist
              </h1>
              <p className="text-base text-rw-ink-soft mb-8">
                We&apos;ll reach out when your area opens — no demo is scheduled yet.
              </p>

              <ul className="space-y-4 mb-10">
                {WAITLIST_BULLETS.map((bullet, i) => (
                  <m.li
                    key={bullet}
                    className="flex items-start gap-3"
                    {...(prefersReducedMotion
                      ? { initial: false as const, animate: { opacity: 1, x: 0 } }
                      : {
                          initial: { opacity: 0, x: -10 },
                          animate: { opacity: 1, x: 0 },
                          transition: { duration: 0.5, delay: 0.3 + i * 0.1 },
                        })}
                  >
                    <div className="size-6 rounded-full bg-rw-teal-strong/15 flex items-center justify-center shrink-0 mt-0.5">
                      <svg className="size-3.5 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="text-rw-teal-strong">{bullet}</span>
                  </m.li>
                ))}
              </ul>
            </m.div>

            {/* Right: form */}
            <m.div {...fadeUp(0.4)}>
              <div className="bg-white rounded-2xl border border-rw-teal/10 shadow-lg p-8">
                <h2 className="text-xl font-medium text-rw-ink mb-6">Join waitlist</h2>
                <LeadIntakeForm intent="waitlist" source="book-a-demo" tone="light" />
              </div>
            </m.div>
          </div>
        </div>
      </div>

      {/* Trust signals */}
      <section className="px-8 py-12 bg-gradient-to-br from-rw-teal-strong to-rw-teal-strong/90 text-white">
        <m.div
          className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-6 justify-center items-center text-center sm:text-left"
          {...(prefersReducedMotion
            ? { initial: false as const, animate: { opacity: 1, y: 0 } }
            : {
                initial: { opacity: 0, y: 20 },
                whileInView: { opacity: 1, y: 0 },
                viewport: { once: true },
                transition: { duration: 0.6 },
              })}
        >
          {TRUST_SIGNALS.map((signal) => (
            <div key={signal} className="flex items-center gap-2 text-sm text-white">
              <svg className="size-4 text-white shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {signal}
            </div>
          ))}
        </m.div>
      </section>
      </main>

      {/* Footer so the page isn't a footerless dead-end */}
      <div className="px-8 pb-4">
        <SiteFooter />
      </div>
    </PageShell>
  );
}

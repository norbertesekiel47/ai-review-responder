'use client';

import Link from 'next/link';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

type IconKey = 'mail' | 'card' | 'shield';

interface SupportChannel {
  title: string;
  purpose: string;
  email: string;
  circle: string;
  icon: IconKey;
}

const CHANNELS: SupportChannel[] = [
  {
    title: 'Account help',
    purpose: 'Connecting Google, locations, and day-to-day questions',
    email: 'support@repworth.net',
    circle: 'from-[#97B3AE] to-[#97B3AE]/80',
    icon: 'mail',
  },
  {
    title: 'Billing',
    purpose: 'Invoices, plan changes, and past-due recovery',
    email: 'billing@repworth.net',
    circle: 'from-[#F2C3B9] to-[#F2C3B9]/80',
    icon: 'card',
  },
  {
    title: 'Security',
    purpose: 'Report a vulnerability or security incident',
    email: 'security@repworth.net',
    circle: 'from-[#D6CBBF] to-[#D6CBBF]/80',
    icon: 'shield',
  },
];

const ICON_PATHS: Record<IconKey, string> = {
  mail: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  card: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  shield: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
};

const RESPONSE_TARGETS = [
  'Basic and Founders: 24 business hours',
  'Standard: 8 business hours',
  'Premium: 2 business hours',
];

const HELP_TOPICS = [
  'Connecting your Google Business Profile',
  'Billing and past-due recovery',
  'Importing locations by CSV',
];

export function ContactContent({ selfServeEnabled = false }: { selfServeEnabled?: boolean }) {
  return (
    <LazyMotion features={domAnimation}>
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      <div className="px-8 py-16 md:py-20">
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <p className="mb-4 text-sm uppercase tracking-wider text-[#97B3AE]">Support</p>
          <h1 className="mb-4 text-4xl font-medium leading-tight text-[#2a2a2a] md:text-5xl">
            How can we help?
          </h1>
          <p className="mb-10 text-lg leading-relaxed text-[#6a6a6a]">
            Pick the channel that fits. We answer fastest by email.
          </p>
        </m.div>

        <div className="grid gap-6 md:grid-cols-3">
          {CHANNELS.map((channel, i) => (
            <m.div
              key={channel.email}
              className="flex flex-col rounded-2xl border border-[#97B3AE]/10 bg-white p-6 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
            >
              <div
                className={`mb-4 flex size-12 items-center justify-center rounded-full bg-gradient-to-br shadow-md ${channel.circle}`}
                aria-hidden="true"
              >
                <svg className="size-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ICON_PATHS[channel.icon]} />
                </svg>
              </div>
              <h2 className="mb-2 text-xl font-medium text-[#2a2a2a]">{channel.title}</h2>
              <p className="mb-6 flex-1 text-[#6a6a6a]">{channel.purpose}</p>
              <m.a
                href={`mailto:${channel.email}`}
                className="inline-block rounded-full border border-[#97B3AE]/20 bg-[#97B3AE]/10 px-5 py-3 text-center font-medium text-[#97B3AE] transition-colors hover:bg-[#97B3AE]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
                whileHover={{ scale: 1.04, y: -2 }}
                whileTap={{ scale: 0.98 }}
              >
                {channel.email}
              </m.a>
            </m.div>
          ))}
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <m.div
            className="rounded-2xl border border-[#97B3AE]/10 bg-[#F0EEEA]/60 p-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6 }}
          >
            <h2 className="mb-4 text-xl font-medium text-[#2a2a2a]">Response targets</h2>
            <ul className="space-y-2 text-[#6a6a6a]">
              {RESPONSE_TARGETS.map((target) => (
                <li key={target}>{target}</li>
              ))}
            </ul>
          </m.div>

          <m.div
            className="rounded-2xl border border-[#97B3AE]/10 bg-[#F0EEEA]/60 p-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <h2 className="mb-4 text-xl font-medium text-[#2a2a2a]">Common help topics</h2>
            <ul className="space-y-2 text-[#6a6a6a]">
              {HELP_TOPICS.map((topic) => (
                <li key={topic}>{topic}</li>
              ))}
            </ul>
          </m.div>
        </div>
      </div>

      <div className="rounded-b-[3rem] bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 px-8 py-12 text-center text-white">
        <m.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <p className="mb-6 text-lg text-white/90">Looking for something else?</p>
          <Link
            href="/"
            className="inline-block rounded-full bg-white px-8 py-4 font-medium text-[#97B3AE] shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#97B3AE]"
          >
            Back to RepWorth →
          </Link>
        </m.div>
      </div>
    </PageShell>
    </LazyMotion>
  );
}

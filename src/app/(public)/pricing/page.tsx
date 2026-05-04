'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

const PLANS = [
  {
    name: 'Founding Member',
    price: '$99',
    badge: 'Limited — 10 slots',
    badgeColor: '#F2C3B9',
    badgeText: '#2a2a2a',
    description: 'Rate locked for life.',
    highlight: true,
    cta: 'Claim Your Slot',
    comingSoon: false,
    features: [
      'Google review monitoring (hourly)',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
      'ROI dashboard',
      'Dedicated onboarding call',
      'Rate locked for life',
    ],
  },
  {
    name: 'Standard',
    price: '$149',
    badge: 'After founding slots fill',
    badgeColor: '#97B3AE',
    badgeText: '#ffffff',
    description: 'Everything you need to dominate your reviews.',
    highlight: false,
    cta: 'Get Started',
    comingSoon: false,
    features: [
      'Everything in Founding Member',
      'Priority support',
      'Advanced analytics',
      'Custom response style guide',
    ],
  },
  {
    name: 'Premium',
    price: '$199',
    badge: 'Coming soon',
    badgeColor: '#D6CBBF',
    badgeText: '#2a2a2a',
    description: 'Multi-platform domination.',
    highlight: false,
    cta: 'Join Waitlist',
    comingSoon: true,
    features: [
      'Everything in Standard',
      'Yelp & TripAdvisor monitoring',
      'SMS review generation campaigns',
      'Competitor monitoring',
      'Multi-location support',
    ],
  },
] as const;

const INCLUDED = [
  'Unlimited reviews monitored',
  'AI responses in any language',
  'Email notifications with one-tap approval',
  'Weekly review intelligence brief',
  'ROI dashboard',
  'Dedicated onboarding call',
];

const COMPARISON = [
  { name: 'RepWorth', price: '$99/mo', aiResponses: '✓', approval: '✓', multilingual: '✓', setup: 'None' },
  { name: 'Birdeye', price: '$300+/mo', aiResponses: '✓', approval: '✗', multilingual: '~', setup: 'Complex' },
  { name: 'Podium', price: '$300+/mo', aiResponses: '✓', approval: '✗', multilingual: '✗', setup: 'Complex' },
  { name: 'DIY', price: '10+ hrs/wk', aiResponses: '✗', approval: 'Manual', multilingual: 'If fluent', setup: 'N/A' },
];

const FAQ = [
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. No contracts, no cancellation fees. Cancel from your account dashboard and billing stops at the end of your current period.',
  },
  {
    q: 'Is there a free trial?',
    a: "We'll generate sample responses for your actual reviews during the demo — no credit card, no commitment. You see the product working on your real business before you pay a cent.",
  },
  {
    q: 'What happens if I get a lot of reviews?',
    a: "There's no limit. Your plan covers unlimited reviews monitored and responded to every month — flat price regardless of volume.",
  },
];

export default function PricingPage() {
  const plansRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const faqRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: plansRef, label: 'Plans' },
    { ref: compareRef, label: 'Compare' },
    { ref: faqRef, label: 'FAQ' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Hero */}
      <section className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          Simple pricing
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          One flat price. Unlimited reviews.
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          No per-response charges. No hidden fees. Just results.
        </motion.p>
      </section>

      {/* Pricing cards */}
      <section ref={plansRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-3 gap-6">
          {PLANS.map((plan, i) => (
            <motion.div
              key={plan.name}
              className={`relative rounded-2xl p-7 border shadow-lg flex flex-col ${
                plan.highlight
                  ? 'border-[#97B3AE]/40 bg-gradient-to-br from-[#F0EEEA]/60 to-white'
                  : 'border-[#97B3AE]/10 bg-white'
              } ${plan.comingSoon ? 'opacity-75' : ''}`}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: plan.comingSoon ? 0.75 : 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              whileHover={plan.comingSoon ? {} : { y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
            >
              <div
                className="absolute -top-3 left-6 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: plan.badgeColor, color: plan.badgeText }}
              >
                {plan.badge}
              </div>

              <h3 className="text-xl font-medium text-[#2a2a2a] mt-2 mb-1">{plan.name}</h3>
              <p className="text-sm text-[#6a6a6a] mb-4">{plan.description}</p>
              <div className="mb-6">
                <span className="text-4xl font-medium text-[#2a2a2a]">{plan.price}</span>
                <span className="text-[#6a6a6a] text-sm">/month</span>
              </div>

              {plan.comingSoon ? (
                <span className="block w-full text-center py-3 rounded-full font-medium text-sm mb-6 bg-[#F0EEEA] text-[#6a6a6a]/50 border border-[#97B3AE]/10 cursor-not-allowed">
                  {plan.cta}
                </span>
              ) : (
                <Link href="/book-a-demo">
                  <motion.span
                    className={`block w-full text-center py-3 rounded-full font-medium text-sm mb-6 cursor-pointer ${
                      plan.highlight
                        ? 'bg-[#97B3AE] text-white shadow-lg'
                        : 'bg-[#F0EEEA] text-[#2a2a2a] border border-[#97B3AE]/10'
                    }`}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {plan.cta}
                  </motion.span>
                </Link>
              )}

              <ul className="space-y-3 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-[#6a6a6a]">
                    <svg className="w-4 h-4 text-[#97B3AE] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </section>

      {/* What's included in every plan */}
      <section className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            What&apos;s included in every plan
          </motion.h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {INCLUDED.map((item, i) => (
              <motion.div
                key={item}
                className="flex items-start gap-3 bg-white rounded-xl p-4 border border-[#97B3AE]/10 shadow-sm"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.07 }}
              >
                <div className="w-8 h-8 rounded-full bg-[#97B3AE]/10 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span className="text-[#2a2a2a] text-sm font-medium pt-1">{item}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison table */}
      <section ref={compareRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            How RepWorth compares
          </motion.h2>
          <motion.p
            className="text-[#6a6a6a] text-center mb-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            The facts speak for themselves.
          </motion.p>
          <motion.div
            className="overflow-x-auto rounded-2xl border border-[#97B3AE]/10 shadow-lg"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0EEEA]/60 border-b border-[#97B3AE]/10">
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Solution</th>
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Cost</th>
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">AI responses</th>
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Owner approval</th>
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Multilingual</th>
                  <th scope="col" className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Setup</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr
                    key={row.name}
                    className={`border-b border-[#97B3AE]/10 last:border-0 ${
                      i === 0 ? 'bg-[#97B3AE]/5' : 'bg-white'
                    }`}
                  >
                    <td className={`px-6 py-4 font-medium ${i === 0 ? 'text-[#97B3AE]' : 'text-[#2a2a2a]'}`}>
                      {row.name}
                    </td>
                    <td className="px-6 py-4 text-[#2a2a2a]">{row.price}</td>
                    <td className={`px-6 py-4 ${row.aiResponses === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.aiResponses}
                    </td>
                    <td className={`px-6 py-4 ${row.approval === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.approval}
                    </td>
                    <td className={`px-6 py-4 ${row.multilingual === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.multilingual}
                    </td>
                    <td className="px-6 py-4 text-[#6a6a6a]">{row.setup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        </div>
      </section>

      {/* FAQ */}
      <section ref={faqRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            Common questions
          </motion.h2>
          <div className="space-y-4">
            {FAQ.map((item, i) => (
              <motion.div
                key={i}
                className="bg-white rounded-xl border border-[#97B3AE]/10 p-6 shadow-sm"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
              >
                <h3 className="font-medium text-[#2a2a2a] mb-2">{item.q}</h3>
                <p className="text-[#6a6a6a] leading-relaxed text-sm">{item.a}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Book a Demo — see your own reviews answered in 60 seconds
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          15 minutes. No commitment. No credit card.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book My Demo
            </motion.span>
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}

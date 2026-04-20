'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

const STEPS = [
  {
    number: '01',
    title: 'We connect to your Google reviews',
    description:
      'We monitor your Google Business Profile every hour for new reviews. No app to download, no login to share, no setup required on your end.',
    color: '#D2E0D3',
  },
  {
    number: '02',
    title: 'AI drafts a personalized response',
    description:
      'Within an hour of a new review, our AI writes a response that sounds like you — referencing specific details from the review, in whatever language it was written.',
    color: '#F0DDD6',
  },
  {
    number: '03',
    title: 'You approve with one tap',
    description:
      "You get an email with the review and the AI draft side-by-side. Tap approve and you're done. Edit the draft or request a new one if you want. Takes 30 seconds.",
    color: '#F2C3B9',
  },
  {
    number: '04',
    title: 'We post it to Google',
    description:
      "Your approved response goes live on Google. Your response rate hits 100%. Google rewards active responders with better local ranking — more visibility, more customers.",
    color: '#D6CBBF',
  },
];

const FAQ = [
  {
    q: "What if I don't like the response?",
    a: 'You can edit the draft directly in the email, or tap "Regenerate" to get a fresh version. Nothing is ever posted without your explicit approval.',
  },
  {
    q: "What if I'm too busy to approve?",
    a: "We send a reminder after 24 hours. Reviews stay queued until you're ready — there's no deadline. Your response rate catches up whenever you do.",
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. RepWorth works entirely through email notifications. No app, no dashboard login required, no browser extension.',
  },
  {
    q: 'What languages do you support?',
    a: 'Any language. Our AI detects the language of the review and responds in kind — Spanish, Vietnamese, Chinese, Tagalog, Korean, and more.',
  },
];

export default function HowItWorksPage() {
  const stepsRef = useRef<HTMLDivElement>(null);
  const exampleRef = useRef<HTMLDivElement>(null);
  const faqRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: stepsRef, label: 'Steps' },
    { ref: exampleRef, label: 'Example' },
    { ref: faqRef, label: 'FAQ' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Hero */}
      <section aria-label="Page hero" className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          How it works
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          Done-for-you in four steps
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          You spend 30 seconds per review. We handle everything else.
        </motion.p>
      </section>

      {/* Steps */}
      <section ref={stepsRef} aria-label="How it works steps" className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto space-y-6">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.number}
              className="flex gap-6 items-start rounded-2xl p-8 border border-[#97B3AE]/10 shadow-sm"
              style={{ background: `linear-gradient(135deg, ${step.color}20 0%, ${step.color}08 100%)` }}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
            >
              <div className="text-5xl font-medium shrink-0 opacity-20 leading-none text-[#2a2a2a]">
                {step.number}
              </div>
              <div>
                <h3 className="text-xl md:text-2xl font-medium text-[#2a2a2a] mb-3">{step.title}</h3>
                <p className="text-[#6a6a6a] leading-relaxed">{step.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Example: sample review + response */}
      <section ref={exampleRef} aria-label="Example review and response" className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            What it looks like in practice
          </motion.h2>
          <motion.p
            className="text-[#6a6a6a] text-center mb-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            A real review from a restaurant. A RepWorth response, ready in under an hour.
          </motion.p>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Customer review */}
            <motion.div
              className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <div className="flex items-center gap-3 mb-4">
                <div aria-hidden="true" className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50" />
                <div>
                  <p className="font-medium text-[#2a2a2a] text-sm">Maria G.</p>
                  <div className="flex gap-0.5" role="img" aria-label="5 out of 5 stars">
                    {[0, 1, 2, 3, 4].map((j) => (
                      <svg key={j} aria-hidden="true" className="w-3.5 h-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ))}
                  </div>
                </div>
              </div>
              <p className="text-[#2a2a2a] text-sm leading-relaxed">
                &ldquo;El ceviche estaba increíble — fresco y lleno de sabor. El servicio fue muy atento. Mi familia y yo definitivamente volveremos. ¡Gracias por la experiencia tan especial!&rdquo;
              </p>
              <p className="text-xs text-[#6a6a6a] mt-3">Google review · 2 hours ago</p>
              <div className="mt-4 pt-4 border-t border-[#97B3AE]/10">
                <p className="text-xs font-medium text-[#6a6a6a] uppercase tracking-wide">Customer review</p>
              </div>
            </motion.div>

            {/* AI response */}
            <motion.div
              className="bg-white rounded-2xl p-6 border border-[#97B3AE]/20 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
                <p className="text-sm font-medium text-[#97B3AE]">Owner response — via RepWorth</p>
                <span className="ml-auto text-xs text-[#6a6a6a] italic">posted 38 min later</span>
              </div>
              <p className="text-[#2a2a2a] text-sm leading-relaxed">
                &ldquo;¡Muchas gracias, María! Nos alegra mucho que hayan disfrutado el ceviche — lo preparamos con pescado fresco todos los días, así que su comentario significa mucho para nuestro equipo. Fue un placer atenderlos y esperamos volver a verlos pronto a usted y a su familia. ¡Hasta la próxima!&rdquo;
              </p>
              <div className="mt-4 pt-4 border-t border-[#97B3AE]/10 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#97B3AE]" />
                <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide">AI-generated, owner-approved</p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section ref={faqRef} aria-label="Frequently asked questions" className="px-8 py-16 bg-white">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            Questions
          </motion.h2>
          <div className="space-y-4">
            {FAQ.map((item, i) => (
              <motion.div
                key={item.q}
                className="bg-[#F0EEEA]/40 rounded-xl border border-[#97B3AE]/10 p-6"
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
      <section aria-label="Book a demo call to action" className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Ready to try it on your actual reviews?
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          15-minute demo. No credit card. No commitment.
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
              Book a Demo
            </motion.span>
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}

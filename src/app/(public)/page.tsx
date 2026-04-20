'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { motion, useScroll, useTransform } from 'motion/react';
import { HowItWorksCarousel } from './components/landing/HowItWorksCarousel';
import type { CarouselStep } from './components/landing/HowItWorksCarousel';
import { ContactForm } from './components/landing/ContactForm';

// ── Data ─────────────────────────────────────────────────────────────

const STEPS: CarouselStep[] = [
  {
    step: '01',
    title: 'Monitor',
    description: 'We poll your Google reviews every 60 minutes automatically.',
    color: '#D2E0D3',
  },
  {
    step: '02',
    title: 'Generate',
    description: 'AI drafts a personalised response that sounds like you wrote it.',
    color: '#F0DDD6',
  },
  {
    step: '03',
    title: 'Approve',
    description: 'You get an email. Tap approve, edit, or regenerate. 30 seconds.',
    color: '#F2C3B9',
  },
  {
    step: '04',
    title: 'Post',
    description: 'The approved response is posted to Google on your behalf.',
    color: '#D6CBBF',
  },
];

const FEATURES = [
  {
    color: '#97B3AE',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    title: 'Your voice, automated',
    description: 'Trained on your best responses',
  },
  {
    color: '#F2C3B9',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    title: 'Instant responses',
    description: 'Reply within minutes, not days',
  },
  {
    color: '#D6CBBF',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    title: 'Always on brand',
    description: 'Consistent tone across all platforms',
  },
];

// ── Page ─────────────────────────────────────────────────────────────

export default function LandingPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const howItWorksRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
  const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
  const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div ref={containerRef} className="min-h-screen bg-[#D2E0D3] relative">
      {/* ── Parallax Background ───────────────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 backdrop-blur-sm bg-[#D2E0D3]/80" />
        {[
          { style: { y: bgY1 }, className: 'absolute top-20 left-10 w-64 h-80', dots: 5 },
          { style: { y: bgY2 }, className: 'absolute top-[500px] right-20 w-72 h-64', dots: 4 },
          { style: { y: bgY3 }, className: 'absolute top-[1000px] left-[15%] w-56 h-72', dots: 5 },
          { style: { y: bgY4 }, className: 'absolute top-[1400px] right-[10%] w-64 h-56', dots: 5 },
        ].map((card, i) => (
          <motion.div
            key={i}
            style={card.style}
            className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
          >
            <div className="flex gap-1 mb-3">
              {Array.from({ length: card.dots }).map((_, j) => (
                <div key={j} className="w-4 h-4 bg-[#F2C3B9]/60 rounded-full" />
              ))}
            </div>
            <div className="space-y-2">
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
            </div>
          </motion.div>
        ))}
      </div>

      {/* ── Right-side dot navigation (desktop) ──────────────────── */}
      <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
        {[
          { ref: heroRef, label: 'Hero' },
          { ref: featuresRef, label: 'Features' },
          { ref: howItWorksRef, label: 'How it works' },
          { ref: ctaRef, label: 'Book a Demo' },
        ].map(({ ref, label }) => (
          <button
            key={label}
            onClick={() => scrollTo(ref)}
            aria-label={`Go to ${label}`}
            className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
          />
        ))}
      </div>

      {/* ── Island Container ─────────────────────────────────────── */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <motion.div
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {/* Nav */}
          <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
              <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
            </div>
            <div className="hidden sm:flex items-center gap-8">
              {[
                { label: 'Features', href: '/features' },
                { label: 'How it works', href: '/how-it-works' },
                { label: 'Pricing', href: '/pricing' },
                { label: 'Book a Demo', href: '/book-a-demo' },
              ].map(({ label, href }) => (
                <Link
                  key={label}
                  href={href}
                  className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                >
                  {label}
                </Link>
              ))}
            </div>
          </nav>

          {/* Hero */}
          <section ref={heroRef} className="px-12 py-20 text-center relative">
            <motion.p
              className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              RepWorth
            </motion.p>
            <motion.h1
              className="text-5xl md:text-6xl lg:text-7xl mb-6 text-[#2a2a2a] max-w-4xl mx-auto font-medium leading-tight"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              Every review gets the reply it deserves
            </motion.h1>
            <motion.p
              className="text-lg text-[#6a6a6a] mb-8 max-w-2xl mx-auto"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              Automated responses that sound authentically human, crafted in your brand voice.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.5 }}
            >
              <motion.button
                onClick={() => scrollTo(ctaRef)}
                className="px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg"
                whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.button>
            </motion.div>
          </section>

          {/* Features */}
          <section ref={featuresRef} className="px-12 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30">
            <div className="max-w-4xl mx-auto">
              <motion.div
                className="text-center mb-16"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="text-4xl md:text-5xl mb-6 text-[#2a2a2a] font-medium">
                  Save 15 hours every week
                </h2>
                <p className="text-lg text-[#6a6a6a] leading-relaxed max-w-2xl mx-auto">
                  RepWorth learns your brand voice and responds to reviews instantly. No templates,
                  no generic messages — just thoughtful replies that build customer loyalty.
                </p>
              </motion.div>
              <div className="grid md:grid-cols-3 gap-8">
                {FEATURES.map((f, i) => (
                  <motion.div
                    key={f.title}
                    className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: '-100px' }}
                    transition={{ duration: 0.6, delay: i * 0.1 }}
                    whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
                  >
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center mb-4 shadow-md"
                      style={{ background: `linear-gradient(135deg, ${f.color}, ${f.color}cc)` }}
                    >
                      {f.icon}
                    </div>
                    <h3 className="text-xl mb-2 text-[#2a2a2a] font-medium">{f.title}</h3>
                    <p className="text-[#6a6a6a]">{f.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          {/* How It Works */}
          <section ref={howItWorksRef} className="py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30 overflow-hidden">
            <div className="text-center mb-12 px-12">
              <h2 className="text-4xl md:text-5xl mb-4 text-[#2a2a2a] font-medium">How it works</h2>
              <p className="text-sm text-[#97B3AE] italic">Use arrows to explore</p>
            </div>
            <HowItWorksCarousel steps={STEPS} />
          </section>

          {/* Platforms */}
          <section className="px-12 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <motion.h2
                  className="text-4xl md:text-5xl mb-6 text-[#2a2a2a] font-medium"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6 }}
                >
                  Works where your customers review you
                </motion.h2>
                <motion.p
                  className="text-lg text-[#6a6a6a] mb-2 max-w-2xl mx-auto"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  Connect your Google account. One dashboard, all your reviews.
                </motion.p>
                <p className="text-sm text-[#97B3AE] italic mb-8">More platforms coming soon</p>
                <motion.div
                  className="flex justify-center mb-16"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                >
                  <motion.div
                    className="text-2xl text-[#2a2a2a] opacity-40"
                    whileHover={{ opacity: 0.7, scale: 1.05 }}
                    transition={{ duration: 0.2 }}
                  >
                    Google
                  </motion.div>
                </motion.div>
              </div>

              {/* Dashboard Mockup */}
              <motion.div
                className="relative"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.6, delay: 0.3 }}
              >
                <div className="bg-gradient-to-br from-[#F0EEEA] to-white rounded-2xl p-6 border border-[#97B3AE]/20 shadow-xl">
                  <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#97B3AE]/10">
                    <div className="flex gap-2">
                      <div className="w-3 h-3 rounded-full bg-[#F2C3B9]/50" />
                      <div className="w-3 h-3 rounded-full bg-[#D6CBBF]/50" />
                      <div className="w-3 h-3 rounded-full bg-[#97B3AE]/50" />
                    </div>
                    <div className="text-xs text-[#6a6a6a]">Dashboard Preview</div>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    {[
                      { label: 'Total Reviews', value: '1,234', color: '#D2E0D3' },
                      { label: 'Replied', value: '1,180', color: '#F2C3B9' },
                      { label: 'Avg Response', value: '8 min', color: '#97B3AE' },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="p-4 rounded-xl border border-[#97B3AE]/10"
                        style={{ background: `linear-gradient(135deg, ${stat.color}20 0%, ${stat.color}10 100%)` }}
                      >
                        <div className="text-xs text-[#6a6a6a] mb-1">{stat.label}</div>
                        <div className="text-2xl text-[#2a2a2a]">{stat.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="bg-white rounded-xl p-4 border border-[#97B3AE]/10 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50 shrink-0" />
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="h-2 bg-[#2a2a2a]/10 rounded w-24" />
                            <div className="flex gap-1">
                              {[0, 1, 2, 3, 4].map((j) => (
                                <div key={j} className="w-3 h-3 rounded-full bg-[#F2C3B9]/40" />
                              ))}
                            </div>
                          </div>
                          <div className="h-2 bg-[#2a2a2a]/10 rounded w-full" />
                          <div className="h-2 bg-[#2a2a2a]/10 rounded w-3/4" />
                          <div className="mt-3 pl-4 border-l-2 border-[#97B3AE]/30">
                            <div className="h-2 bg-[#97B3AE]/20 rounded w-5/6" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Floating stat cards */}
                <motion.div
                  className="absolute -top-6 -right-6 w-32 h-24 bg-gradient-to-br from-[#F2C3B9]/40 to-[#F2C3B9]/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
                  initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: 5 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.5 }}
                >
                  <div className="text-xs text-[#6a6a6a] mb-1">Response Rate</div>
                  <div className="text-xl text-[#2a2a2a]">96%</div>
                </motion.div>

                <motion.div
                  className="absolute -bottom-6 -left-6 w-32 h-24 bg-gradient-to-br from-[#97B3AE]/40 to-[#97B3AE]/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
                  initial={{ opacity: 0, scale: 0.8, rotate: 5 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: -5 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.6 }}
                >
                  <div className="text-xs text-[#6a6a6a] mb-1">This Week</div>
                  <div className="text-xl text-[#2a2a2a]">+127</div>
                </motion.div>
              </motion.div>
            </div>
          </section>

          {/* CTA + Contact Form */}
          <section
            ref={ctaRef}
            className="px-12 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem]"
          >
            <div className="max-w-3xl mx-auto text-center">
              <motion.h2
                className="text-4xl md:text-5xl mb-6 font-medium"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                Start responding smarter today
              </motion.h2>
              <motion.p
                className="text-lg mb-10 opacity-90"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.1 }}
              >
                Tell us about your business and we&apos;ll set you up with a personalised demo.
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.2 }}
              >
                <ContactForm />
              </motion.div>
            </div>
          </section>
        </motion.div>
      </div>
    </div>
  );
}

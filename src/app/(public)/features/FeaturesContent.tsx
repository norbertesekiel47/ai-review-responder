'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export function FeaturesContent({ comingSoon = false }: { comingSoon?: boolean }) {
  const aiRef = useRef<HTMLDivElement>(null);
  const multiRef = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<HTMLDivElement>(null);
  const briefRef = useRef<HTMLDivElement>(null);
  const roiRef = useRef<HTMLDivElement>(null);
  const competitorRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: aiRef, label: 'AI' },
    { ref: multiRef, label: 'Languages' },
    { ref: approvalRef, label: 'Approval' },
    { ref: voiceRef, label: 'Voice' },
    { ref: briefRef, label: 'Brief' },
    { ref: roiRef, label: 'ROI' },
    { ref: competitorRef, label: 'Competitor' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav comingSoon={comingSoon} />

      {/* Hero */}
      <section aria-label="Page hero" className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          Features
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          Everything your reviews need, nothing you don&apos;t
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          RepWorth is a done-for-you service — not another dashboard to learn.
        </motion.p>
      </section>

      {/* Feature 1: AI-powered response generation */}
      <section ref={aiRef} aria-label="AI-powered response generation" className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">AI-powered response generation</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every response is written from scratch — never from a template. Our AI reads the actual review, references specific details the customer mentioned, and writes a reply that sounds like you wrote it yourself. No &ldquo;thanks for your feedback&rdquo; filler.
            </p>
          </motion.div>
          <motion.div
            className="space-y-4"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="rounded-xl border border-red-100 bg-red-50/40 p-5">
              <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Generic (without RepWorth)</p>
              <p className="text-sm text-[#6a6a6a] italic">&ldquo;Thank you for your feedback! We appreciate your business and hope to see you again soon.&rdquo;</p>
            </div>
            <div className="flex justify-center">
              <svg className="w-5 h-5 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
            <div className="rounded-xl border border-[#97B3AE]/30 bg-[#97B3AE]/5 p-5">
              <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-2">Personalized (RepWorth)</p>
              <p className="text-sm text-[#2a2a2a]">&ldquo;Sarah, thank you so much! We&apos;re thrilled the al pastor tacos hit the spot — our team makes the achiote marinade from scratch every morning. Looking forward to your next visit!&rdquo;</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 2: Multilingual */}
      <section ref={multiRef} aria-label="Multilingual support" className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            className="order-2 md:order-1 space-y-3"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="rounded-xl border border-[#97B3AE]/10 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <div aria-hidden="true" className="w-7 h-7 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50" />
                <div>
                  <p className="text-xs font-medium text-[#2a2a2a]">Carlos M.</p>
                  <div role="img" aria-label="5 out of 5 stars" className="flex gap-0.5">
                    {[0,1,2,3,4].map(j => (
                      <svg key={j} aria-hidden="true" className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                      </svg>
                    ))}
                  </div>
                </div>
              </div>
              <p className="text-sm text-[#2a2a2a]">&ldquo;La mejor enchilada que he comido en años. El mole es auténtico. Volvería todos los fines de semana si pudiera.&rdquo;</p>
            </div>
            <div className="ml-6 rounded-xl border border-[#97B3AE]/20 bg-[#97B3AE]/5 p-5">
              <p className="text-xs font-medium text-[#97B3AE] mb-2">Owner response — in Spanish, automatically</p>
              <p className="text-sm text-[#2a2a2a]">&ldquo;Carlos, ¡muchísimas gracias! El mole es la receta de mi abuela — tardan tres días en prepararlo. Nos alegra mucho que lo hayas disfrutado. ¡Hasta pronto!&rdquo;</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #F2C3B9, #F2C3B9cc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Multilingual, automatically</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              RepWorth detects the language of every review and responds in the same language — no setup needed. Spanish, Vietnamese, Chinese, Tagalog, Korean — your customers feel heard in their own words.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 3: One-tap approval */}
      <section ref={approvalRef} aria-label="One-tap approval" className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #D6CBBF, #D6CBBFcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">One-tap approval</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              You get an email showing the customer&apos;s review and the AI draft side-by-side. Tap approve, edit it, or ask for a fresh draft. Nothing is ever posted without your explicit sign-off. Most owners spend under 30 seconds per review.
            </p>
          </motion.div>
          <motion.div
            className="flex justify-center"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div aria-hidden="true" className="w-64 rounded-3xl border-2 border-[#2a2a2a]/10 bg-[#F0EEEA] shadow-2xl overflow-hidden">
              <div className="bg-[#2a2a2a] px-4 py-2 flex justify-between items-center">
                <p className="text-white text-xs">9:41</p>
                <div className="w-16 h-4 bg-[#2a2a2a] rounded-full border border-white/20" />
              </div>
              <div className="p-4 space-y-3">
                <div className="bg-white rounded-xl p-3 text-xs text-[#2a2a2a] shadow-sm">
                  <p className="font-medium mb-1">New review — Mama Rosa&apos;s 🍽️</p>
                  <p className="text-[#6a6a6a]">★★★★★ &ldquo;Best enchiladas I&apos;ve had in years...&rdquo;</p>
                </div>
                <div className="bg-[#97B3AE]/10 rounded-xl p-3 text-xs border border-[#97B3AE]/20">
                  <p className="font-medium text-[#97B3AE] mb-1">Draft response</p>
                  <p className="text-[#6a6a6a]">&ldquo;Carlos, thank you so much! The mole is our abuela&apos;s recipe...&rdquo;</p>
                </div>
                <div className="space-y-2">
                  <div className="bg-[#97B3AE] rounded-full py-2.5 text-center text-white text-xs font-medium shadow">
                    ✓ Approve &amp; Post
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-white rounded-full py-2 text-center text-[#6a6a6a] text-xs border border-[#97B3AE]/20">Edit</div>
                    <div className="flex-1 bg-white rounded-full py-2 text-center text-[#6a6a6a] text-xs border border-[#97B3AE]/20">Regenerate</div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 4: Voice learning */}
      <section ref={voiceRef} aria-label="Voice learning" className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            className="order-2 md:order-1"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg">
              <p className="text-sm font-medium text-[#6a6a6a] mb-4">Edit rate over time</p>
              <div className="flex items-end gap-2 h-24" role="img" aria-label="Bar chart showing edit rate declining from 85% in week 1 to 12% in week 8">
                {[85, 72, 61, 48, 35, 28, 18, 12].map((h, i) => (
                  <div key={i} aria-hidden="true" className="flex-1 rounded-t" style={{ height: `${h}%`, background: `rgba(151, 179, 174, ${0.3 + (8-i) * 0.08})` }} />
                ))}
              </div>
              <div className="flex justify-between text-xs text-[#6a6a6a] mt-2">
                <span>Week 1</span>
                <span>Week 8</span>
              </div>
              <p className="text-xs text-[#97B3AE] mt-3 italic">Owners edit fewer responses as the AI learns their voice.</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Voice learning</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every time you edit a response, RepWorth learns. Over 4-8 weeks, it picks up your phrasing, your warmth level, your way of handling negative reviews. By week 8, most owners approve drafts without changes.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 5: Review intelligence brief */}
      <section ref={briefRef} aria-label="Weekly review intelligence brief" className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #F2C3B9, #F2C3B9cc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Weekly review intelligence brief</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every Monday morning, you get a brief summarizing what customers actually said this week — what they loved, what they complained about, and what topics are trending. Operational intelligence from your reviews, not just star counts.
            </p>
          </motion.div>
          <motion.div
            className="bg-[#F0EEEA]/50 rounded-2xl border border-[#97B3AE]/10 p-6 shadow-lg"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-4">Weekly brief — Apr 14–20</p>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-[#2a2a2a] mb-1">Reviews this week</p>
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-medium text-[#2a2a2a]">14</span>
                  <span className="text-xs text-[#97B3AE] bg-[#97B3AE]/10 px-2 py-0.5 rounded-full">↑ 3 vs last week</span>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-[#2a2a2a] mb-2">Top mentions</p>
                <div className="space-y-1.5">
                  {[
                    { topic: 'al pastor tacos', count: 7, sentiment: 'positive' },
                    { topic: 'wait time', count: 4, sentiment: 'negative' },
                    { topic: 'friendly staff', count: 6, sentiment: 'positive' },
                  ].map(({ topic, count, sentiment }) => (
                    <div key={topic} className="flex items-center gap-2 text-xs">
                      <div aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${sentiment === 'positive' ? 'bg-[#97B3AE]' : 'bg-[#F2C3B9]'}`} />
                      <span className="text-[#2a2a2a]">{topic}</span>
                      <span className="text-[#6a6a6a] ml-auto">{count}×</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-[#97B3AE]/10 pt-3">
                <p className="text-xs text-[#6a6a6a] italic">&ldquo;Wait time came up in 4 reviews this week — worth looking at staffing on Saturday evenings.&rdquo;</p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 6: ROI dashboard */}
      <section ref={roiRef} aria-label="ROI dashboard" className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            className="order-2 md:order-1 bg-white rounded-2xl border border-[#97B3AE]/10 shadow-lg p-6"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="grid grid-cols-2 gap-4 mb-6">
              {[
                { label: 'Response rate', before: '12%', after: '100%', color: '#97B3AE' },
                { label: 'Avg response time', before: '4 days', after: '58 min', color: '#F2C3B9' },
              ].map(({ label, before, after, color }) => (
                <div key={label} className="rounded-xl p-4 border border-[#97B3AE]/10" style={{ background: `${color}15` }}>
                  <p className="text-xs text-[#6a6a6a] mb-2">{label}</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs line-through text-[#6a6a6a]/60">{before}</span>
                    <span className="text-lg font-medium text-[#2a2a2a]">{after}</span>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <p className="text-xs text-[#6a6a6a] mb-3">Google ranking trend (placeholder)</p>
              <div className="flex items-end gap-1 h-16" role="img" aria-label="Bar chart showing Google ranking improving over 12 weeks">
                {[3, 4, 3.5, 5, 6, 7, 8, 9, 8.5, 10, 9, 11].map((v, i) => (
                  <div key={i} aria-hidden="true" className="flex-1 rounded-t" style={{ height: `${v * 9}%`, background: `rgba(151, 179, 174, ${0.3 + i * 0.05})` }} />
                ))}
              </div>
              <p className="text-xs text-[#97B3AE] mt-2 italic text-right">↑ Local search position over 3 months</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #D6CBBF, #D6CBBFcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">ROI dashboard</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              See your response rate before and after RepWorth, your average response time, and how your Google Maps ranking has moved. Concrete numbers, not vanity metrics — so you can show the value to your accountant or business partner.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 7: Competitor monitoring */}
      <section ref={competitorRef} aria-label="Competitor monitoring" className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a]">Competitor monitoring</h2>
              <span className="text-xs bg-[#D6CBBF]/40 text-[#6a6a6a] px-2 py-0.5 rounded-full border border-[#D6CBBF]/60">Coming soon</span>
            </div>
            <p className="text-[#6a6a6a] leading-relaxed">
              Know how your reviews stack up against the business next door. Track competitor response rates, star rating trends, and what customers are saying about them — so you always know where you stand in your local market.
            </p>
          </motion.div>
          <motion.div
            className="bg-[#F0EEEA]/50 rounded-2xl border border-[#97B3AE]/10 p-6 shadow-lg"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 0.7, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-4">Area comparison — placeholder</p>
            <div className="space-y-3">
              {[
                { name: 'Your business', rate: '100%', stars: '4.8', color: '#97B3AE' },
                { name: 'Competitor A', rate: '23%', stars: '4.2', color: '#D6CBBF' },
                { name: 'Competitor B', rate: '8%', stars: '4.0', color: '#D6CBBF' },
              ].map(({ name, rate, stars, color }) => (
                <div key={name} className="flex items-center gap-4 text-sm">
                  <div aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-[#2a2a2a] flex-1">{name}</span>
                  <span className="text-[#6a6a6a]">★ {stars}</span>
                  <span className="text-xs text-[#6a6a6a]">{rate} responses</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* CTA */}
      <section aria-label="Call to action" className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          See it in action with your own reviews
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          We&apos;ll pull your real Google reviews and show you AI responses live during the demo.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          {comingSoon ? (
            <span className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium opacity-60 cursor-default select-none">
              Coming Soon
            </span>
          ) : (
            <Link href="/book-a-demo">
              <motion.span
                className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
                whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.span>
            </Link>
          )}
        </motion.div>
      </section>
    </PageShell>
  );
}

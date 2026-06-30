'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import './landing-experience.css';

/**
 * Rebuilt RepWorth landing page — a single full-bleed cinematic scroll
 * experience ported from the imported "RepWorth Landing" Claude Design comp.
 *
 * Background: a fixed canvas paints a warm aurora gradient (brand palette) that
 * hands off to the hero video once it has buffered. The video is *scrubbed*
 * frame-by-frame from scroll position (scroll progress → `currentTime`), not
 * autoplayed — that is the comp's signature effect. If the video can't load it
 * silently stays on the aurora, and reduced-motion visitors get a single static
 * frame with no scrubbing, particles, or rAF loop. Same-origin `/video/*` keeps
 * it inside the production CSP (`default-src 'self'`, no `media-src`).
 *
 * The previous landing is preserved verbatim at `/landing-legacy`.
 */

const VIDEO_SRC = '/video/heroVideo.mp4';

interface LandingExperienceProps {
  /** Where every CTA points. `/signup` when self-serve signup is live, else the
   *  lead-capture route (`/signup` 404s when the flag is off). */
  primaryCtaHref: string;
  /** Hero + nav CTA label (reflects the trial offer when one is live). */
  primaryCtaLabel: string;
}

interface AuroraBlob {
  x: number;
  y: number;
  r: number;
  a: number;
  c: string;
  sx: number;
  sy: number;
  px: number;
  py: number;
  ph: number;
}

interface Mote {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  a: number;
  c: string;
}

export function LandingExperience({ primaryCtaHref, primaryCtaLabel }: LandingExperienceProps) {
  const reduced = usePrefersReducedMotion();

  const bgRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const particlesRef = useRef<HTMLCanvasElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const cardsTriggerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const finalInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bgCanvas = bgRef.current;
    const particlesCanvas = particlesRef.current;
    if (!bgCanvas || !particlesCanvas) return;
    const bgCtx = bgCanvas.getContext('2d');
    const pCtx = particlesCanvas.getContext('2d');
    if (!bgCtx || !pCtx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let progress = 0;
    let target = 0;
    let time = 0;
    let videoReady = false;
    let finalShown = false;
    let raf = 0;
    let blobs: AuroraBlob[] = [];
    let motes: Mote[] = [];

    const rgba = (hex: string, a: number): string => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      for (const c of [bgCanvas, particlesCanvas]) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
    };

    const initScene = () => {
      // Aurora blobs — warm brand palette, positions as viewport fractions.
      blobs = [
        { x: 0.22, y: 0.3, r: 0.62, a: 0.55, c: '#D2E0D3', sx: 1.0, sy: 1.3, px: 0.1, py: -0.18, ph: 0.0 },
        { x: 0.78, y: 0.26, r: 0.55, a: 0.5, c: '#F2C3B9', sx: 1.4, sy: 0.9, px: -0.14, py: 0.1, ph: 1.7 },
        { x: 0.62, y: 0.68, r: 0.66, a: 0.48, c: '#97B3AE', sx: 0.8, sy: 1.1, px: 0.08, py: 0.16, ph: 3.1 },
        { x: 0.3, y: 0.74, r: 0.5, a: 0.46, c: '#F0DDD6', sx: 1.2, sy: 1.5, px: -0.1, py: 0.14, ph: 4.5 },
        { x: 0.5, y: 0.46, r: 0.58, a: 0.4, c: '#D6CBBF', sx: 0.9, sy: 1.0, px: 0.05, py: -0.12, ph: 2.2 },
        { x: 0.88, y: 0.62, r: 0.44, a: 0.4, c: '#D2E0D3', sx: 1.3, sy: 0.7, px: -0.06, py: -0.1, ph: 5.6 },
      ];
      // Drifting motes.
      const palette = ['#557069', '#97B3AE', '#F2C3B9', '#ffffff'];
      motes = [];
      const count = Math.round(Math.min(60, (width * height) / 26000));
      for (let i = 0; i < count; i++) {
        motes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 0.8 + Math.random() * 2.2,
          vx: (Math.random() - 0.5) * 0.22,
          vy: -0.12 - Math.random() * 0.35,
          a: 0.12 + Math.random() * 0.35,
          c: palette[(Math.random() * palette.length) | 0] ?? '#ffffff',
        });
      }
    };

    const drawAurora = () => {
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.clearRect(0, 0, width, height);
      bgCtx.fillStyle = '#F0EEEA';
      bgCtx.fillRect(0, 0, width, height);
      const tm = time * 0.00006;
      const maxR = Math.max(width, height);
      for (const b of blobs) {
        const x = (b.x + Math.sin(tm * b.sx + b.ph) * 0.07 + (progress - 0.5) * b.px) * width;
        const y = (b.y + Math.cos(tm * b.sy + b.ph) * 0.07 + (progress - 0.5) * b.py) * height;
        const r = b.r * maxR;
        const g = bgCtx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(b.c, b.a));
        g.addColorStop(0.55, rgba(b.c, b.a * 0.32));
        g.addColorStop(1, rgba(b.c, 0));
        bgCtx.fillStyle = g;
        bgCtx.fillRect(0, 0, width, height);
      }
      // Cool "resolve" tint as the final reveal approaches.
      if (progress > 0) {
        bgCtx.fillStyle = rgba('#557069', progress * 0.14);
        bgCtx.fillRect(0, 0, width, height);
      }
    };

    const drawVideo = () => {
      const v = videoRef.current;
      if (!v || !v.duration) {
        drawAurora();
        return;
      }
      const t = progress * (v.duration - 0.05);
      if (Math.abs(v.currentTime - t) > 0.06 && !v.seeking) {
        try {
          v.currentTime = t;
        } catch {
          /* seek can throw mid-load; the next frame retries */
        }
      }
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.clearRect(0, 0, width, height);
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!vw || !vh) return;
      const s = Math.max(width / vw, height / vh);
      const dw = vw * s;
      const dh = vh * s;
      bgCtx.drawImage(v, (width - dw) / 2, (height - dh) / 2, dw, dh);
    };

    const drawParticles = () => {
      pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pCtx.clearRect(0, 0, width, height);
      for (const m of motes) {
        m.x += m.vx;
        m.y += m.vy;
        if (m.y < -6) {
          m.y = height + 6;
          m.x = Math.random() * width;
        }
        if (m.x < -6) m.x = width + 6;
        if (m.x > width + 6) m.x = -6;
        pCtx.globalAlpha = m.a;
        pCtx.fillStyle = m.c;
        pCtx.beginPath();
        pCtx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        pCtx.fill();
      }
      pCtx.globalAlpha = 1;
    };

    const clearParticles = () => {
      pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pCtx.clearRect(0, 0, width, height);
    };

    const drawAll = () => {
      if (videoReady && !reduced) drawVideo();
      else drawAurora();
      if (!reduced) drawParticles();
      else clearParticles();
    };

    const revealFinal = () => {
      const el = finalInnerRef.current;
      if (!el || finalShown) return;
      finalShown = true;
      el.classList.add('is-revealed');
    };

    const onScroll = () => {
      const se = document.scrollingElement || document.documentElement;
      const scrollY = window.scrollY || se.scrollTop || 0;
      const vh = window.innerHeight;
      const docH = se.scrollHeight;
      const start = vh * 0.5;
      const end = Math.max(start + 1, docH - vh);
      target = Math.max(0, Math.min(1, (scrollY - start) / (end - start)));
      if (reduced) progress = target;

      const hero = heroRef.current;
      if (hero) {
        const ho = Math.max(0, Math.min(1, 1 - scrollY / (vh * 0.82)));
        hero.style.opacity = String(ho);
        hero.style.transform = `translateY(${-(1 - ho) * 40}px)`;
      }

      const trig = cardsTriggerRef.current;
      const cards = cardsRef.current;
      if (trig && cards) {
        const rect = trig.getBoundingClientRect();
        const visible = rect.top < vh * 0.62 && rect.bottom > vh * 0.42;
        cards.style.opacity = visible ? '1' : '0';
        cards.style.pointerEvents = visible ? 'auto' : 'none';
        // Keep the off-screen reveal cards out of the tab order / a11y tree.
        cards.inert = !visible;
      }

      const fin = finalInnerRef.current;
      if (fin && !finalShown) {
        const fr = fin.getBoundingClientRect();
        if (fr.top < vh * 0.82) revealFinal();
      }
    };

    const loop = (t: number) => {
      time = t || 0;
      progress += (target - progress) * 0.09;
      drawAll();
      raf = requestAnimationFrame(loop);
    };

    resize();
    initScene();

    // Only fetch the 23 MB clip for visitors who will actually see it scrub.
    const video = videoRef.current;
    let onLoaded: (() => void) | null = null;
    let onError: (() => void) | null = null;
    if (video && !reduced) {
      onLoaded = () => {
        videoReady = true;
      };
      onError = () => {
        videoReady = false;
      };
      video.addEventListener('loadeddata', onLoaded);
      video.addEventListener('error', onError);
      video.src = VIDEO_SRC;
      video.load();
    }

    const onResize = () => {
      resize();
      initScene();
      onScroll();
      if (reduced) drawAll();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    let io: IntersectionObserver | null = null;
    if (finalInnerRef.current) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) revealFinal();
        },
        { threshold: 0.32 },
      );
      io.observe(finalInnerRef.current);
    }

    onScroll();
    drawAll();
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      if (video && onLoaded) video.removeEventListener('loadeddata', onLoaded);
      if (video && onError) video.removeEventListener('error', onError);
    };
  }, [reduced]);

  return (
    <div className="rw-le">
      {/* Fixed background scene (aurora → scrubbed video). Decorative. */}
      <div className="rw-le-bg" aria-hidden="true">
        <canvas className="rw-le-canvas" ref={bgRef} />
        <video
          className="rw-le-video"
          ref={videoRef}
          muted
          playsInline
          preload="none"
          crossOrigin="anonymous"
          tabIndex={-1}
        />
        <div className="rw-le-wash" />
      </div>

      <canvas className="rw-le-particles" ref={particlesRef} aria-hidden="true" />

      {/* Scroll-reveal cards — supplementary navigation that fades in mid-page. */}
      <div className="rw-le-cards" ref={cardsRef} aria-label="Explore RepWorth">
        <div className="rw-le-cards-grid">
          <Link className="rw-le-card" href="/features">
            <span className="rw-le-card-num">01</span>
            <h3>Features</h3>
            <p>
              Everything RepWorth drafts, posts, and tracks for you — replies written in your
              voice, sent the moment you tap approve.
            </p>
            <span className="rw-le-card-link">Explore features →</span>
          </Link>
          <Link className="rw-le-card" href="/how-it-works">
            <span className="rw-le-card-num">02</span>
            <h3>How it works</h3>
            <p>
              Connect Google, set your tone, approve. Three simple steps to staying on top of
              every review without the busywork.
            </p>
            <span className="rw-le-card-link">See the flow →</span>
          </Link>
          <Link className="rw-le-card" href="/pricing">
            <span className="rw-le-card-num">03</span>
            <h3>Pricing</h3>
            <p>
              Simple per-location pricing with a free trial to start. Find the plan that fits your
              business — no surprises.
            </p>
            <span className="rw-le-card-link">View plans →</span>
          </Link>
        </div>
      </div>

      <nav className="rw-le-nav" aria-label="Primary">
        <div className="rw-le-nav-left">
          <Link className="rw-le-brand" href="/">
            RepWorth
          </Link>
          <div className="rw-le-nav-links">
            <Link href="/features">Features</Link>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
        </div>
        <Link className="rw-le-cta" href={primaryCtaHref}>
          {primaryCtaLabel}
        </Link>
      </nav>

      <main id="main-content" className="rw-le-scroll">
        <section className="rw-le-hero">
          <div className="rw-le-hero-inner" ref={heroRef}>
            <p className="rw-le-eyebrow">Review response, on autopilot</p>
            <h1 className="rw-le-title">
              Every review gets the reply it{' '}
              <span className="rw-le-mark">
                <span className="rw-le-mark-bar" aria-hidden="true" />
                <span className="rw-le-mark-text">deserves</span>
              </span>
              .
            </h1>
            <p className="rw-le-sub">
              RepWorth drafts a reply to every Google review in your voice, notifies you, and posts
              it the moment you tap approve. You save about fifteen hours a week — your customers
              feel heard within minutes.
            </p>
            <div className="rw-le-hero-ctas">
              <Link className="rw-le-btn-primary" href={primaryCtaHref}>
                {primaryCtaLabel} <span aria-hidden="true">→</span>
              </Link>
              <Link className="rw-le-btn-ghost" href="/how-it-works">
                See how it works →
              </Link>
            </div>
          </div>
          <div className="rw-le-cue" aria-hidden="true">
            <span className="rw-le-cue-label">Scroll</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </div>
        </section>

        <div className="rw-le-spacer-a" aria-hidden="true" />
        <div className="rw-le-cards-trigger" ref={cardsTriggerRef} aria-hidden="true" />
        <div className="rw-le-spacer-b" aria-hidden="true" />

        <section className="rw-le-final">
          <div className="rw-le-final-inner" ref={finalInnerRef}>
            <p className="rw-le-eyebrow">Ready when you are</p>
            <h2 className="rw-le-final-title">Every review, answered.</h2>
            <p className="rw-le-final-sub">
              Save about fifteen hours a week. Your customers feel heard within minutes — and your
              rating takes care of itself.
            </p>
            <Link className="rw-le-btn-primary" href={primaryCtaHref}>
              Join the early access waitlist <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}

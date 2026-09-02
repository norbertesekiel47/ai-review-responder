// Branded styling for onboarding funnel form controls + CTAs.
// Single authoritative owner so every funnel input/label/banner/button
// derives from one place. Inputs use text-base (16px) to prevent iOS Safari
// auto-zoom on focus (audit M2).
//
// Token rule (ADR 0004): `rw-teal` is decoration only — borders, rings, dots.
// Anything that carries text or a white label sits on `rw-teal-strong`
// (white on `rw-teal` is 2.24:1). Every colour here is an `rw-*` token so a
// future funnel control inherits the right one by construction.

export const fieldClass =
  'w-full px-4 py-3 rounded-xl border border-rw-teal/30 bg-white text-base text-rw-ink ' +
  'placeholder:text-rw-warm-gray focus:outline-none focus:border-rw-teal-strong focus:ring-2 ' +
  'focus:ring-rw-teal-strong/30 transition';

export const textareaClass = `${fieldClass} resize-y min-h-[64px]`;

export const labelClass = 'block text-sm font-medium text-rw-ink mb-1.5';

export const errorBannerClass =
  'rounded-xl border border-rw-error/30 bg-rw-error/5 p-4 text-sm text-rw-error';

export const infoBannerClass =
  'rounded-xl border border-rw-teal/20 bg-rw-cream p-4 text-sm text-rw-ink-soft';

export const primaryButtonClass =
  'px-8 py-3 bg-rw-teal-strong text-white rounded-full font-medium shadow-lg ' +
  'hover:bg-rw-teal-strong-hover disabled:opacity-50 disabled:cursor-not-allowed transition';

export const ghostButtonClass =
  'px-6 py-3 text-rw-ink-soft font-medium rounded-full hover:text-rw-ink ' +
  'disabled:opacity-50 transition';

// Brand hover/tap for motion.button / motion.a CTAs.
export const buttonMotion = {
  whileHover: { scale: 1.05, y: -2 },
  whileTap: { scale: 0.98 },
} as const;

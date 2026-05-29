// Branded styling for onboarding funnel form controls + CTAs.
// Single authoritative owner so every funnel input/label/banner/button
// derives from one place. Inputs use text-base (16px) to prevent iOS Safari
// auto-zoom on focus (audit M2).

export const fieldClass =
  'w-full px-4 py-3 rounded-xl border border-[#97B3AE]/30 bg-white text-base text-[#2a2a2a] ' +
  'placeholder:text-[#9a948a] focus:outline-none focus:border-[#97B3AE] focus:ring-2 ' +
  'focus:ring-[#97B3AE]/30 transition';

export const textareaClass = `${fieldClass} resize-y min-h-[64px]`;

export const labelClass = 'block text-sm font-medium text-[#2a2a2a] mb-1.5';

export const errorBannerClass =
  'rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700';

export const infoBannerClass =
  'rounded-xl border border-[#97B3AE]/20 bg-[#F0EEEA] p-4 text-sm text-[#6a6a6a]';

export const primaryButtonClass =
  'px-8 py-3 bg-[#97B3AE] text-white rounded-full font-medium shadow-lg ' +
  'hover:bg-[#7e9b96] disabled:opacity-50 disabled:cursor-not-allowed transition';

export const ghostButtonClass =
  'px-6 py-3 text-[#6a6a6a] font-medium rounded-full hover:text-[#2a2a2a] ' +
  'disabled:opacity-50 transition';

// Brand hover/tap for motion.button / motion.a CTAs.
export const buttonMotion = {
  whileHover: { scale: 1.05, y: -2 },
  whileTap: { scale: 0.98 },
} as const;

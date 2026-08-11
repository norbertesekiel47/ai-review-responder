import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://repworth.net';

// Self-hosted from ./fonts rather than next/font/google: Turbopack fetches
// Google-hosted fonts at COMPILE time, and an intermittent failure there
// resolves to `Module not found: @vercel/turbopack-next/internal/font/google/font`,
// which breaks layout.tsx and therefore every page. That took down E2E runs and
// Vercel builds (production included) on unrelated commits. The .woff2 files are
// byte-identical to the ones Google was serving — see ./fonts/README.md for the
// source URL of each and how to refresh them.
//
// These are variable fonts, so one file spans each family's whole weight range;
// the ranges below are the weights this app actually uses.
const inter = localFont({
  src: './fonts/inter-latin.woff2',
  weight: '100 900',
  variable: '--font-inter',
  display: 'swap',
});
// 200/300 exist for the landing hero's display type (light-weight editorial
// register); 400-800 are the established app/marketing weights.
const plusJakarta = localFont({
  src: './fonts/plus-jakarta-sans-latin.woff2',
  weight: '200 800',
  variable: '--font-plus-jakarta',
  display: 'swap',
});
const dmSans = localFont({
  src: './fonts/dm-sans-latin.woff2',
  weight: '400 700',
  variable: '--font-dm-sans',
  display: 'swap',
});
const fraunces = localFont({
  src: [
    { path: './fonts/fraunces-latin.woff2', weight: '300 500', style: 'normal' },
    { path: './fonts/fraunces-italic-latin.woff2', weight: '300 500', style: 'italic' },
  ],
  variable: '--font-fraunces',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});
const jetBrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin.woff2',
  weight: '400 500',
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'RepWorth',
    template: '%s · RepWorth',
  },
  description: 'AI-powered review response management for small businesses',
  icons: {
    icon: '/logo.svg',
  },
  openGraph: {
    type: 'website',
    siteName: 'RepWorth',
    title: 'RepWorth',
    description: 'AI-powered review response management for small businesses',
    url: APP_URL,
    images: ['/logo.svg'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RepWorth',
    description: 'AI-powered review response management for small businesses',
    images: ['/logo.svg'],
  },
};

export const viewport: Viewport = {
  themeColor: '#D2E0D3',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${plusJakarta.variable} ${dmSans.variable} ${fraunces.variable} ${jetBrainsMono.variable}`}
    >
      <body className={inter.className}>{children}</body>
    </html>
  );
}

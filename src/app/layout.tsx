import type { Metadata, Viewport } from 'next';
import { Inter, Plus_Jakarta_Sans, DM_Sans, Fraunces, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://repworth.net';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
// 200/300 exist for the landing hero's display type (light-weight editorial
// register); 400-800 are the established app/marketing weights.
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700', '800'],
  variable: '--font-plus-jakarta',
  display: 'swap',
});
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  style: ['normal', 'italic'],
  variable: '--font-fraunces',
  display: 'swap',
});
const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
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

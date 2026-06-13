import type { MetadataRoute } from 'next';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://repworth.net';

// Public marketing + legal pages only. Authed app surfaces are disallowed in
// robots.ts; /terms and /privacy permanently redirect to /legal/* so only the
// canonical legal URLs are listed.
const PUBLIC_PATHS: Array<{ path: string; priority: number }> = [
  { path: '/', priority: 1 },
  { path: '/features', priority: 0.8 },
  { path: '/how-it-works', priority: 0.8 },
  { path: '/pricing', priority: 0.9 },
  { path: '/security', priority: 0.6 },
  { path: '/book-a-demo', priority: 0.7 },
  { path: '/help/contact', priority: 0.5 },
  { path: '/legal/terms', priority: 0.3 },
  { path: '/legal/privacy', priority: 0.3 },
  { path: '/legal/cookies', priority: 0.3 },
  { path: '/legal/aup', priority: 0.3 },
  { path: '/legal/sub-processors', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map(({ path, priority }) => ({
    url: `${APP_URL}${path}`,
    changeFrequency: 'monthly',
    priority,
  }));
}

import * as Sentry from '@sentry/nextjs';
import { initBotId } from 'botid/client/core';
import { scrubSentryEvent } from '@/lib/shared/sentry-scrub';
import { BOTID_PROTECTED_ROUTES } from '@/lib/security/botid-routes';

// Required by @sentry/nextjs to instrument client-side navigations
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend(event) {
    return scrubSentryEvent(event);
  },
});

// Vercel BotID — attaches the invisible challenge solution to fetches that hit a
// protected route, so the server-side checkBotId() in those routes can classify
// the session. The per-route checkLevel MUST match the server (both derive from
// BOTID_PROTECTED_ROUTES — the single source of truth).
initBotId({
  protect: BOTID_PROTECTED_ROUTES.map((route) => ({
    path: route.path,
    method: route.method,
    advancedOptions: { checkLevel: route.checkLevel },
  })),
});

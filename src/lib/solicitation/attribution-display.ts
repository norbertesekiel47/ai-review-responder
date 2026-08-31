// The Attributed-review list's display window, and NOTHING else (#1010).
//
// THIS FILE IMPORTS NOTHING, AND THAT IS ITS ENTIRE PURPOSE — the same reason
// `@/lib/shared/format-rate` exists (#910 B3.10). `AttributedReviews.tsx` is a
// `'use client'` component and needs this number to render "the last 30 days".
// It used to read it from `@/lib/solicitation/attribution`, which is a SERVER
// module, and that runtime edge is what broke the build:
//
//   AttributedReviews.tsx ('use client')
//     -> attribution.ts            (VALUE import, for this constant)
//     -> batch-builder.ts          (VALUE import, acquireSolicitationBatchLock)
//     -> @/lib/refusals/write      (VALUE import, added by #1010)
//     -> createWorkerLogger -> log-context -> node:async_hooks
//
//   Failed to write app endpoint /(authenticated)/dashboard/requests/page
//   - the chunking context (unknown) does not support external modules
//     (request: node:async_hooks)
//
// The violation is invariant #1 and it PRE-DATES #1010: a client component was
// already importing a server module at runtime for one number. #1010 only
// lengthened the chain until it reached a Node built-in. Making the logger call
// lazy would not have helped — `log-context.ts` instantiates `AsyncLocalStorage`
// at module scope, so the bare `import` is the drag.
//
// KEEP THIS FILE IMPORT-FREE. `attribution.ts` re-exports the constant, so every
// server caller is unchanged and there is only ever ONE definition — which is
// the drift this constant was created to stop in the first place.

/** How far back the owner-facing Attributed-review list reaches. Presentation
 *  only, and a DIFFERENT number from the matcher's `ATTRIBUTION_WINDOW_DAYS`:
 *  how far back the owner's list reaches, not how far back a review may
 *  attribute. */
export const ATTRIBUTION_DISPLAY_WINDOW_DAYS = 30;

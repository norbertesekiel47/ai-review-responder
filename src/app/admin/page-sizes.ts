// Server-safe page-size constants for the admin list pages.
//
// WHY THIS FILE EXISTS: each of these constants used to be exported from its
// page's `'use client'` component (e.g. `export const PAGE_SIZE = 20` in
// `CostsClient.tsx`) and imported by the sibling SERVER page to build its first
// query — `getCostReport(sql, { limit: PAGE_SIZE, ... })`.
//
// That is a client/server boundary violation. A non-component value exported
// from a `'use client'` module is not the value on the server: the bundler
// replaces it with a client-reference stub, so the server page binds a FUNCTION
// as a SQL parameter and Postgres rejects it:
//
//   PostgresError: invalid input syntax for type bigint:
//   "function(){throw Error("Attempted to call PAGE_SIZE() from the server but
//   PAGE_SIZE is on the client. ...")}"   (SQLSTATE 22P02)
//
// It is a LATENT landmine, not a permanent break — whether the bundler inlines
// the constant or emits the stub depends on how the module graph is chunked, so
// the same source can work for months and then fail after an unrelated change
// shifts chunking. It went live on staging 2026-08-10 and took out seven admin
// pages with "Admin page failed to load".
//
// Rule: a value the SERVER reads must live in a module with no `'use client'`
// directive. The client components import these too, which is fine — the
// direction that breaks is server-importing-from-client, never the reverse.

/** Admin Overview — businesses table page size. */
export const OVERVIEW_PAGE_SIZE = 20;
/** Admin Jobs — failed-jobs table page size. */
export const JOBS_PAGE_SIZE = 20 as const;
/** Admin Costs — per-business cost table page size. */
export const COSTS_PAGE_SIZE = 20;
/** Admin Notifications — delivery table page size. */
export const NOTIFICATIONS_PAGE_SIZE = 20 as const;
/** Admin All Businesses — list page size. */
export const BUSINESSES_PAGE_SIZE = 20 as const;
/** Admin Flagged — open flagged-response queue page size. */
export const FLAGGED_PAGE_SIZE = 50 as const;
/** Admin Offboardings — offboarding queue page size. */
export const OFFBOARDINGS_PAGE_SIZE = 50 as const;

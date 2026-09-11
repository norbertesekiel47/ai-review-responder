# ADR 0001: Next.js routes may run short OAuth-handshake calls

## Status

Accepted — 2026-05-20

## Context

The "Vercel = UI only" invariant requires LLM calls, external API calls, and
long-running operations to run on Railway workers. The Zernio connect flow has
two routes — `callback` and `select-location` — that must call Zernio
synchronously because they set/clear signed cookies and return redirects in the
same request. They cannot be moved to a worker without breaking the
cookie/redirect contract.

## Decision

Next.js routes may perform short, user-blocking OAuth-handshake calls to a
provider when they must set/clear cookies or return a redirect synchronously.
Durable recovery, retries, and long-running work still belong in modules/workers.

The general carve-out is scoped to the OAuth connect handshake. It does NOT
permit LLM calls, batch/long-running work, or fire-and-forget side effects in
Next.js routes. The named manual-disconnect exception below is separate.

### Owner exception — manual Disconnect (2026-09-11, #1226)

The Admin split preserves the existing manual Disconnect operation at
`POST /api/zernio/disconnect` and exposes it through
`POST /api/admin/businesses/[id]/disconnect`. These two routes may await one
best-effort `zernioClient.deleteAccount` call, using the existing transport's
10-second timeout, after the selected active connection is successfully marked
disconnected. The update must pin the business ID, selected Zernio account ID,
and active status; a zero-row update performs no provider deletion. Provider
failure remains reported and does not undo the successful database transition.

This exception preserves current behavior rather than adding a durable retry
worker. It permits no profile deletion, billing/offboarding operation, new
provider action, background task, or impersonation change. Both routes share
the operation in a domain module with an explicit database parameter. The
legacy owner path retains cookie auth, same-origin enforcement, location and
subscription checks; the new Admin route uses the canonical Admin AAL2 gate
and bearer-aware same-origin wrapper. Both retain the offboarding refusal and
the existing publishing feature flag.

## Consequences

- The connect `callback` and `select-location` routes stay on Vercel.
- Their durable failure handling (incident recording, orphan cleanup) is
  extracted into modules with their own tests (see the Tier-1+2 modularization
  spec), keeping the route bodies thin.

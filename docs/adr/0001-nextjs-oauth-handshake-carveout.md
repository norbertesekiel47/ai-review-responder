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

This carve-out is scoped to the OAuth connect handshake. It does NOT permit LLM
calls, batch/long-running work, or fire-and-forget side effects in Next.js
routes.

## Consequences

- The connect `callback` and `select-location` routes stay on Vercel.
- Their durable failure handling (incident recording, orphan cleanup) is
  extracted into modules with their own tests (see the Tier-1+2 modularization
  spec), keeping the route bodies thin.

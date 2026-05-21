#!/usr/bin/env bash
#
# dev-stack.sh — one-command local stack for RepWorth.
#
# Brings up, with a single Ctrl-C teardown:
#   1. cloudflared quick tunnel  -> public HTTPS URL for the worker (:3001)
#   2. stripe listen             -> forwards Stripe events to /ingress/stripe
#   3. pnpm dev                  -> Next.js UI (:3000)
#   4. pnpm worker               -> Railway worker (:3001)
#
# Why the ordering matters (see worker/config/startup-assert.ts + worker/env.ts):
#   - cloudflared mints a NEW *.trycloudflare.com URL every run. The worker uses
#     WORKER_PUBLIC_URL for Zernio/Telegram webhook registration, so we capture
#     the fresh URL and export it BEFORE the worker boots.
#   - With MOCK_EXTERNAL_APIS=false, the worker requires STRIPE_WEBHOOK_SECRET at
#     boot and 401s any webhook whose signature doesn't match. We pull the Stripe
#     CLI's signing secret with `stripe listen --print-secret` and export it.
#   - worker/env.ts calls dotenv.config() with defaults, which does NOT override
#     vars already in the environment — so these exports win over stale .env.local
#     values without touching the file.
#
# Skips (set to 1 to opt out):
#   SKIP_TUNNEL=1  - no cloudflared (keeps stale WORKER_PUBLIC_URL from .env.local)
#   SKIP_STRIPE=1  - no stripe listen (keeps STRIPE_WEBHOOK_SECRET from .env.local)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKER_PORT="${PORT:-3001}"
STRIPE_FORWARD="localhost:${WORKER_PORT}/ingress/stripe"
TUNNEL_LOG="$(mktemp -t repworth-tunnel.XXXXXX)"

# --- pretty, prefixed, interleaved logging ----------------------------------
c_reset=$'\033[0m'; c_next=$'\033[36m'; c_wrk=$'\033[35m'; c_stripe=$'\033[33m'
c_tun=$'\033[32m';  c_info=$'\033[1;34m'; c_err=$'\033[1;31m'
info() { printf '%s[dev-stack]%s %s\n' "$c_info" "$c_reset" "$*"; }
die()  { printf '%s[dev-stack] ERROR:%s %s\n' "$c_err" "$c_reset" "$*" >&2; exit 1; }

# kill 0 signals the whole process group (this script + every child),
# so one Ctrl-C tears the entire stack down cleanly.
cleanup() {
  info "Shutting down stack..."
  rm -f "$TUNNEL_LOG" 2>/dev/null || true
  trap - EXIT INT TERM
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- preflight ---------------------------------------------------------------
command -v pnpm >/dev/null || die "pnpm not found."

ensure_redis() {
  if redis-cli ping >/dev/null 2>&1; then return; fi
  info "Local Redis not responding — attempting to start it..."
  if command -v brew >/dev/null && brew services start redis >/dev/null 2>&1; then
    :
  elif command -v redis-server >/dev/null; then
    redis-server --daemonize yes >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 10); do
    redis-cli ping >/dev/null 2>&1 && { info "Redis is up."; return; }
    sleep 0.5
  done
  die "Could not reach Redis on localhost:6379. Start it manually (brew services start redis)."
}
ensure_redis

if [[ "${SKIP_TUNNEL:-0}" != "1" ]]; then
  command -v cloudflared >/dev/null || die "cloudflared not found. Install: brew install cloudflared (or set SKIP_TUNNEL=1)."
fi
if [[ "${SKIP_STRIPE:-0}" != "1" ]]; then
  command -v stripe >/dev/null || die "stripe CLI not found. Install: brew install stripe/stripe-cli/stripe (or set SKIP_STRIPE=1)."
  stripe config --list 2>/dev/null | grep -q 'account_id' || die "stripe CLI not logged in. Run: stripe login"
fi

# --- 1. cloudflared tunnel: start, then scrape the fresh public URL ----------
if [[ "${SKIP_TUNNEL:-0}" != "1" ]]; then
  info "Starting cloudflared tunnel -> http://localhost:${WORKER_PORT} ..."
  ( cloudflared tunnel --url "http://localhost:${WORKER_PORT}" >"$TUNNEL_LOG" 2>&1 ) &

  TUNNEL_URL=""
  for _ in $(seq 1 60); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
    [[ -n "$TUNNEL_URL" ]] && break
    sleep 0.5
  done
  [[ -n "$TUNNEL_URL" ]] || die "Timed out waiting for cloudflared URL. Last log:\n$(tail -5 "$TUNNEL_LOG")"

  export WORKER_PUBLIC_URL="$TUNNEL_URL"
  info "Tunnel URL: $c_tun$TUNNEL_URL$c_reset  (exported as WORKER_PUBLIC_URL)"
  info "  -> Zernio/Telegram webhooks should point at ${TUNNEL_URL}/ingress/{zernio,telegram}"
fi

# --- 2. stripe signing secret: must be set before the worker boots -----------
if [[ "${SKIP_STRIPE:-0}" != "1" ]]; then
  info "Fetching Stripe CLI webhook signing secret..."
  STRIPE_SECRET="$(stripe listen --print-secret 2>/dev/null || true)"
  [[ "$STRIPE_SECRET" == whsec_* ]] || die "Could not read Stripe signing secret (got: '${STRIPE_SECRET:-<empty>}'). Try: stripe login"
  export STRIPE_WEBHOOK_SECRET="$STRIPE_SECRET"
  info "STRIPE_WEBHOOK_SECRET exported (whsec_…${STRIPE_SECRET: -4})"
fi

# --- 3. launch the long-running processes ------------------------------------
info "Launching Next.js (:3000), worker (:${WORKER_PORT})$([[ "${SKIP_STRIPE:-0}" != "1" ]] && echo ', stripe listen')..."

pnpm dev    2>&1 | sed "s/^/${c_next}[next]  ${c_reset}/" &
pnpm worker 2>&1 | sed "s/^/${c_wrk}[worker]${c_reset}/" &

if [[ "${SKIP_STRIPE:-0}" != "1" ]]; then
  stripe listen --forward-to "$STRIPE_FORWARD" 2>&1 | sed "s/^/${c_stripe}[stripe]${c_reset}/" &
fi

info "Stack is up. Press Ctrl-C to stop everything."
wait

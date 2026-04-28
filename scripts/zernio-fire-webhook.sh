#!/usr/bin/env bash
#
# Dev/test helper: fire a signed Zernio webhook at the local worker.
#
# Usage:
#   bash scripts/zernio-fire-webhook.sh                            # uses default mock account id
#   bash scripts/zernio-fire-webhook.sh <zernio-account-id>        # specific account
#   bash scripts/zernio-fire-webhook.sh <zernio-account-id> <event> [extra-body-json]
#
# Examples:
#   bash scripts/zernio-fire-webhook.sh                                          # account.disconnected, mock account
#   bash scripts/zernio-fire-webhook.sh mock-account-1234                        # account.disconnected, specific account
#   bash scripts/zernio-fire-webhook.sh "" webhook.test                          # webhook.test (no account needed)
#   bash scripts/zernio-fire-webhook.sh mock-account-1234 account.disconnected '{"reason":"user_revoked"}'
#
# Requires:
#   - openssl (for HMAC-SHA256)
#   - curl
#   - $ZERNIO_WEBHOOK_SECRET in the environment, or the default test secret below
#
# Worker URL defaults to http://localhost:3001/ingress/zernio. Override with
# WORKER_URL=https://staging.example.com/ingress/zernio.
#
# Note on payload shape: account.disconnected uses NESTED `account.id` per
# spec §5.4 (handler reads body.account?.id). Earlier versions of this script
# used a flat accountId field which silently no-op'd — fixed here.

set -euo pipefail

SECRET="${ZERNIO_WEBHOOK_SECRET:-test-secret-32-bytes-minimum-zzz}"
WORKER_URL="${WORKER_URL:-http://localhost:3001/ingress/zernio}"
ACCOUNT_ID="${1:-mock-account-1}"
EVENT="${2:-account.disconnected}"
EXTRA_JSON="${3:-}"
EVENT_ID="evt-$(date +%s)-$RANDOM"

# Build the body. account.disconnected requires nested account.id; webhook.test
# and other events don't need account info.
case "$EVENT" in
  account.disconnected|account.connected)
    if [ -z "$ACCOUNT_ID" ]; then
      echo "ERROR: $EVENT requires an account id (first arg)" >&2
      exit 1
    fi
    BODY=$(printf '{"id":"%s","event":"%s","account":{"id":"%s"},"reason":"user_revoked"}' \
      "$EVENT_ID" "$EVENT" "$ACCOUNT_ID")
    ;;
  webhook.test)
    BODY=$(printf '{"id":"%s","event":"%s"}' "$EVENT_ID" "$EVENT")
    ;;
  review.new|review.updated)
    BODY=$(printf '{"id":"%s","event":"%s","review":{"id":"mock-review-1"},"account":{"id":"%s"}}' \
      "$EVENT_ID" "$EVENT" "$ACCOUNT_ID")
    ;;
  *)
    BODY=$(printf '{"id":"%s","event":"%s","account":{"id":"%s"}}' \
      "$EVENT_ID" "$EVENT" "$ACCOUNT_ID")
    ;;
esac

# Splice in extra JSON fields if provided. The brace-strip merge is fragile —
# it assumes EXTRA_JSON is a well-formed object literal `{...}`. If the caller
# passed something else (escaped quotes, an array, a bare value), the resulting
# BODY is malformed and the HMAC signature won't verify. Validate shape first.
if [ -n "$EXTRA_JSON" ]; then
  if [[ "$EXTRA_JSON" == \{*\} ]]; then
    # Strip the trailing } from BODY and the leading { from EXTRA_JSON, then join.
    BODY=$(printf '%s,%s' "${BODY%\}}" "${EXTRA_JSON#\{}")
  else
    echo "WARNING: EXTRA_JSON does not look like a JSON object ({...}); skipping splice. Got: $EXTRA_JSON" >&2
  fi
fi

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

echo "→ $EVENT  (event_id=$EVENT_ID)"
echo "  body:  $BODY"
echo "  sig:   $SIG"
echo "  POST:  $WORKER_URL"
echo

curl -i -X POST "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -H "x-zernio-signature: $SIG" \
  -H "x-zernio-event-id: $EVENT_ID" \
  -d "$BODY"
echo

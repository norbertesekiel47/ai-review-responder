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
# Targeting a SPECIFIC location (review.new / review.updated only):
#   The webhook ingress narrows its fan-out to one location by parsing the
#   {locationId} segment out of the review RESOURCE NAME
#   (`accounts/{a}/locations/{loc}/reviews/{r}`) — see
#   src/lib/zernio/parse-review-webhook.ts. Set LOCATION_ID to build that
#   resource name so the parsed location matches a seeded zernio_location_id:
#
#     LOCATION_ID=mock-loc-2 bash scripts/zernio-fire-webhook.sh mock-account-1 review.new
#
#   Overridable companions (defaults shown):
#     REVIEW_ID=mock-review-1            # the {reviewId} path segment
#     RESOURCE_ACCOUNT_ID=gmb-account-1  # the {accountResource} path segment.
#                                        # NOTE: Google's account id, a DIFFERENT
#                                        # id space from the top-level Zernio
#                                        # account.id (first positional arg).
#                                        # The parser deliberately does NOT
#                                        # cross-check the two.
#
#   When LOCATION_ID is unset, review.new/review.updated keep the legacy
#   behavior: a bare review.id and account-wide fan-out.
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
WORKER_URL="${WORKER_URL:-http://127.0.0.1:3001/ingress/zernio}"
ACCOUNT_ID="${1:-mock-account-1}"
EVENT="${2:-account.disconnected}"
EXTRA_JSON="${3:-}"
EVENT_ID="${EVENT_ID:-evt-$(date +%s)-$RANDOM}"

# Ids are spliced into the JSON body verbatim. A quote/backslash in one would
# produce malformed-but-validly-signed JSON: the ingress verifies the HMAC,
# fails to parse, returns 200, and the operator chases a phantom ingest bug.
# Real Zernio/Google ids only ever use this charset — fail fast on anything else.
require_json_safe() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._:/-]*$ ]]; then
    echo "ERROR: $name contains characters unsafe for JSON splicing: $value" >&2
    exit 1
  fi
}
require_json_safe ACCOUNT_ID "$ACCOUNT_ID"
require_json_safe EVENT "$EVENT"
require_json_safe EVENT_ID "$EVENT_ID"

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
    REVIEW_ID="${REVIEW_ID:-mock-review-1}"
    require_json_safe REVIEW_ID "$REVIEW_ID"
    if [ -n "${LOCATION_ID:-}" ]; then
      # Build the review RESOURCE NAME so the ingress parses {locationId} and
      # narrows fan-out to exactly that seeded zernio_location_id.
      RESOURCE_ACCOUNT_ID="${RESOURCE_ACCOUNT_ID:-gmb-account-1}"
      require_json_safe LOCATION_ID "$LOCATION_ID"
      require_json_safe RESOURCE_ACCOUNT_ID "$RESOURCE_ACCOUNT_ID"
      REVIEW_NAME="accounts/${RESOURCE_ACCOUNT_ID}/locations/${LOCATION_ID}/reviews/${REVIEW_ID}"
      BODY=$(printf '{"id":"%s","event":"%s","review":{"id":"%s","name":"%s"},"account":{"id":"%s"}}' \
        "$EVENT_ID" "$EVENT" "$REVIEW_ID" "$REVIEW_NAME" "$ACCOUNT_ID")
    else
      # Legacy: bare review id, account-wide fan-out.
      BODY=$(printf '{"id":"%s","event":"%s","review":{"id":"%s"},"account":{"id":"%s"}}' \
        "$EVENT_ID" "$EVENT" "$REVIEW_ID" "$ACCOUNT_ID")
    fi
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

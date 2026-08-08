# Google Business Profile API — Access Application (fire-and-forget)

A short checklist so the owner submits the Google Business Profile (GBP) API
access application **today** and starts the multi-week approval clock. This is an
external gate: the code that consumes the access (`EDIT_REPLIES_ENABLED`) is
already merged and inert until both the API access is granted AND the flag is
flipped.

> **Owner action.** This doc does not submit anything. File it, note the date,
> move on — approval is asynchronous and takes **weeks**.

## What we are requesting

- **Access to the Google Business Profile API** with **quota to post and edit
  review replies** on behalf of connected businesses. (RepWorth posts owner-
  approved replies to Google and, with `EDIT_REPLIES_ENABLED`, edits/deletes an
  already-posted reply before re-posting the updated text.)
- GBP API access is **gated by Google** — new projects start at zero quota and
  must be approved before the review-reply endpoints return real data instead of
  permission errors.

## Where to apply

In the **Google Cloud Console**, under the project that owns RepWorth's Google
integration:

1. Enable the Business Profile APIs on the project (APIs & Services → Library →
   search "Business Profile").
2. Open the **Business Profile APIs access request** form (Google surfaces it
   from the API's page / the "Request access / quota" link on the Business
   Profile API; Google has moved this between the Cloud Console and a standalone
   request form over time). Follow whichever current path the Console presents
   for "request access to the Business Profile API."

> Do not hard-code a specific URL here — Google relocates this form
> periodically. Navigate from the Business Profile API page in the Cloud Console
> for the project, and use the current "request access / quota increase" entry
> point.

## Use-case description to submit (RepWorth-tailored)

Paste/adapt:

> RepWorth is a subscription SaaS for small and medium businesses that drafts
> replies to their Google reviews using an LLM and, **only after the business
> owner explicitly approves each draft**, posts the reply to the business's own
> Google Business Profile on their behalf. Businesses connect their own Google
> Business Profile and authorize RepWorth to manage review replies for their
> locations. We request access to the Business Profile API review-reply
> endpoints (create/update/delete a reply to a review) with sufficient quota to
> serve our connected business customers. We do not scrape or resell review
> data; replies are owner-approved and posted to the businesses' own profiles.

State plainly: number of locations/businesses expected, that posting is
owner-approved (not automated spam), and that data is used only to manage the
connected business's own replies.

## Expected lead time

- **Weeks.** Google's GBP API access review is asynchronous and historically
  slow. File now so the clock starts; do not block other GA work on it.

## What approval unblocks

- Flipping **`EDIT_REPLIES_ENABLED=true`** (set on **both** Vercel and the
  Railway worker — it is read by both; env-vars.md). Since #678 retired
  `PAST_REPLIES_VIEW_ENABLED`, this is the **only** flag involved — the edit
  routes check one predicate, not two, and the **Reviews list** renders
  unconditionally.
- The **edit-existing-replies path**: the 7 `/api/dashboard/past-replies/*` edit
  routes, the Edit UI in `PastRepliesClient`, and the publisher's
  DELETE-then-POST edit branch + orphan-conversion failed-hook
  (`worker/jobs/publisher/ResponsePublisherWorker.ts`, `failed-hook.ts`). When
  off, publisher behavior is byte-for-byte the POST-only path.
- Note: today RepWorth posts/edits replies via the Zernio adapter
  (`src/lib/publishing/zernio-review-publisher.ts`). Direct GBP API access is the
  path to a second, direct-Google publisher adapter (per the `ReviewPublisher`
  seam) and removes the third-party dependency for the reply-write path. Filing
  the GBP application now keeps that option open.

## After filing

- [ ] Record the **submission date** and any Google case/ticket ID here:
  `submitted: ____-__-__  ·  case id: ________`
- [ ] When granted, record the **approval date** and confirm the review-reply
  endpoints return real responses for a test location before flipping
  `EDIT_REPLIES_ENABLED`.

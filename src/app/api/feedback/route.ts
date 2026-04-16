import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { verifyFeedback } from '@/lib/shared/feedback-hmac';
import type { EngagementAlertPayload } from '@/lib/shared/worker-types';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const VALID_RATINGS = ['great', 'ok', 'not_great'] as const;
type Rating = (typeof VALID_RATINGS)[number];

const WEEK_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COMMENT_LENGTH = 1000;

function isValidRating(value: string): value is Rating {
  return (VALID_RATINGS as readonly string[]).includes(value);
}

function validateParams(
  businessId: string | null,
  rating: string | null,
  week: string | null,
  sig: string | null,
): { error: string } | { businessId: string; rating: Rating; week: string; sig: string } {
  if (!businessId || !rating || !week || !sig) {
    return { error: 'Missing required parameters: business_id, rating, week, sig' };
  }
  if (!isValidRating(rating)) {
    return { error: `Invalid rating. Must be one of: ${VALID_RATINGS.join(', ')}` };
  }
  if (!WEEK_PATTERN.test(week)) {
    return { error: 'Invalid week format. Must be YYYY-MM-DD' };
  }
  // Round-trip calendar date validation (rejects impossible dates like 2026-99-99)
  const parsed = new Date(week + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== week) {
    return { error: 'Invalid calendar date' };
  }
  // UUID format validation for business_id
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    return { error: 'Invalid business_id format' };
  }
  if (!verifyFeedback(businessId, rating, week, sig)) {
    return { error: 'Invalid signature' };
  }
  return { businessId, rating, week, sig };
}

// ── GET — render confirmation form (never writes to DB) ─────────────

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const result = validateParams(
    url.searchParams.get('business_id'),
    url.searchParams.get('rating'),
    url.searchParams.get('week'),
    url.searchParams.get('sig'),
  );

  if ('error' in result) {
    return new NextResponse(result.error, {
      status: 400,
      headers: { 'Content-Type': 'text/plain', ...NO_STORE_HEADERS },
    });
  }

  const { businessId, rating, week, sig } = result;

  const ratingLabels: Record<Rating, string> = {
    great: 'Great',
    ok: 'OK',
    not_great: 'Not Great',
  };

  const commentField =
    rating === 'not_great'
      ? `<div style="margin-bottom:16px">
           <label for="comment" style="display:block;margin-bottom:6px;font-weight:500;color:#374151">
             What could we improve? (optional)
           </label>
           <textarea id="comment" name="comment" rows="3" maxlength="${MAX_COMMENT_LENGTH}"
             style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box"
             placeholder="Tell us what's on your mind..."></textarea>
         </div>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Confirm Feedback</title>
</head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111827">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600">Confirm Your Feedback</h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:15px">
      You rated your experience: <strong style="color:#111827">${ratingLabels[rating]}</strong>
    </p>
    <form method="POST" action="/api/feedback">
      <input type="hidden" name="business_id" value="${businessId}" />
      <input type="hidden" name="rating" value="${rating}" />
      <input type="hidden" name="week" value="${week}" />
      <input type="hidden" name="sig" value="${sig}" />
      ${commentField}
      <button type="submit"
        style="width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:500;cursor:pointer;font-family:inherit">
        Submit Feedback
      </button>
    </form>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE_HEADERS },
  });
}

// ── POST — persist feedback + optionally queue alert ────────────────

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new NextResponse('Invalid form data', {
      status: 400,
      headers: { 'Content-Type': 'text/plain', ...NO_STORE_HEADERS },
    });
  }

  const result = validateParams(
    formData.get('business_id') as string | null,
    formData.get('rating') as string | null,
    formData.get('week') as string | null,
    formData.get('sig') as string | null,
  );

  if ('error' in result) {
    return new NextResponse(result.error, {
      status: 400,
      headers: { 'Content-Type': 'text/plain', ...NO_STORE_HEADERS },
    });
  }

  const { businessId, rating, week } = result;

  const rawComment = formData.get('comment') as string | null;
  const comment = rawComment ? rawComment.trim().slice(0, MAX_COMMENT_LENGTH) || null : null;

  await sql.begin(async (tx) => {
    // 1. Upsert satisfaction response
    await tx`
      INSERT INTO satisfaction_responses (id, business_id, week_start_date, rating, comment)
      VALUES (${uuidv7()}, ${businessId}, ${week}::date, ${rating}, ${comment})
      ON CONFLICT (business_id, week_start_date)
      DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment
    `;

    // 2. If not_great, queue engagement alert with cooldown dedup.
    // Catch 23505 from the broad engagement-alert unique index (migration 011)
    // which keys on (aggregate_id, alert_type) without week — a pending alert
    // from a different week would otherwise abort the entire transaction and
    // lose the satisfaction_responses upsert.
    if (rating === 'not_great') {
      const payload: EngagementAlertPayload = {
        business_id: businessId,
        alert_type: 'partner_satisfaction_alert',
        satisfaction: {
          rating: 'not_great',
          comment,
          week_start_date: week,
        },
      };

      try {
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT ${uuidv7()}, 'engagement_alert', 'business', ${businessId},
                 ${JSON.stringify(payload)}::jsonb, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox
            WHERE topic = 'engagement_alert'
              AND aggregate_id = ${businessId}
              AND status <> 'failed'
              AND payload->>'alert_type' = 'partner_satisfaction_alert'
              AND payload->'satisfaction'->>'week_start_date' = ${week}
          )
        `;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          // Duplicate from broad index — alert already queued, satisfaction upsert still committed
          console.log(`[feedback] partner_satisfaction_alert already queued for ${businessId} — skipping outbox insert`);
        } else {
          throw err;
        }
      }
    }
  });

  return NextResponse.redirect(new URL('/feedback/thanks', request.url), 303);
}

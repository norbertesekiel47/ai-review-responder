// src/app/api/dashboard/past-replies/_shared/edit-reply-errors.ts
//
// Two deliberately narrow HTTP seams for past-replies mutations:
// mapEditReplyError owns SubscriptionReadOnly/Forbidden/NotFound responses;
// mapConcurrencyError owns ReviewChanged/ResponseChanged 409 responses.
// Both return null for unhandled errors so each route can preserve its own
// remaining catch behavior and final rethrow.

import { NextResponse } from 'next/server';
import {
  SubscriptionReadOnlyError,
  ForbiddenError,
  NotFoundError,
  ReviewChangedError,
  ResponseChangedError,
} from '@/lib/responses/edit-existing';

export function mapEditReplyError(err: unknown): NextResponse | null {
  if (err instanceof SubscriptionReadOnlyError) {
    return NextResponse.json({ error: err.error }, { status: err.status });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }
  return null;
}

export function mapConcurrencyError(err: unknown): NextResponse | null {
  if (err instanceof ReviewChangedError) {
    return NextResponse.json(
      {
        error: 'review_changed',
        current_review_text: err.current.reviewText,
        current_review_hash: err.current.reviewHash,
      },
      { status: 409 },
    );
  }
  if (err instanceof ResponseChangedError) {
    return NextResponse.json({ error: 'response_changed' }, { status: 409 });
  }
  return null;
}

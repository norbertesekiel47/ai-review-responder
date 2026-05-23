// src/app/api/dashboard/past-replies/_shared/edit-reply-errors.ts
//
// Shared error mapper for the assertCanEditReply catch-ladder. All five
// past-replies mutation routes (draft, draft/[responseId], publish, retry,
// restore-original) map the same three domain errors to identical HTTP
// responses. Centralising them here keeps the per-route catch blocks thin
// and ensures the status codes / error strings stay in sync.
//
// Returns a NextResponse for PremiumRequiredError, ForbiddenError, and
// NotFoundError. Returns null for anything else so the caller can continue
// to its own error handling and final re-throw.

import { NextResponse } from 'next/server';
import {
  PremiumRequiredError,
  ForbiddenError,
  NotFoundError,
} from '@/lib/responses/edit-existing';

export function mapEditReplyError(err: unknown): NextResponse | null {
  if (err instanceof PremiumRequiredError) {
    return NextResponse.json({ error: 'premium_required' }, { status: 403 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }
  return null;
}

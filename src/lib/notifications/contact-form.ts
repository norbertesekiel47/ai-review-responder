// src/lib/notifications/contact-form.ts
//
// Shared input parsing for the public contact + demo-request endpoints. Both
// routes parse a JSON object and require a non-empty name, a valid email, and a
// non-empty businessName before doing route-specific work (rate limits, extra
// fields, notification). This owns that common core so the two routes can't
// drift on validation shape or error strings.

import { NextRequest, NextResponse } from 'next/server';

export const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactCoreFields {
  name: string;
  email: string;
  businessName: string;
}

export type ParsedContactBody =
  | { ok: true; body: Record<string, unknown>; fields: ContactCoreFields }
  | { ok: false; response: NextResponse };

function bad(error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status: 400 }) };
}

/**
 * Parses the request JSON body and validates the three fields common to both
 * the contact and demo-request forms. Returns the trimmed core fields plus the
 * raw body (so callers can read route-specific fields like googleMapsUrl), or
 * the inline 400 response on any validation failure.
 */
export async function parseContactCoreFields(req: NextRequest): Promise<ParsedContactBody> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Invalid JSON');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return bad('Invalid JSON');
  }

  const { name, email, businessName } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return bad('name is required');
  }
  if (!email || typeof email !== 'string' || !CONTACT_EMAIL_RE.test(email.trim())) {
    return bad('A valid email is required');
  }
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return bad('businessName is required');
  }

  return {
    ok: true,
    body: body as Record<string, unknown>,
    fields: { name: name.trim(), email: email.trim(), businessName: businessName.trim() },
  };
}

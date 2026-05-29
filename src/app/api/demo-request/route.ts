import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';

const MAX_NAME_LEN = 200;
const MAX_BUSINESS_NAME_LEN = 300;
const MAX_URL_LEN = 2048;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`demo-request:hour:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, businessName, googleMapsUrl } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return NextResponse.json({ error: 'businessName is required' }, { status: 400 });
  }

  if (name.trim().length > MAX_NAME_LEN) {
    return NextResponse.json({ error: 'name is too long' }, { status: 400 });
  }
  if (businessName.trim().length > MAX_BUSINESS_NAME_LEN) {
    return NextResponse.json({ error: 'businessName is too long' }, { status: 400 });
  }

  const rawUrl = typeof googleMapsUrl === 'string' ? googleMapsUrl.trim() : '';
  if (rawUrl) {
    if (rawUrl.length > MAX_URL_LEN) {
      return NextResponse.json({ error: 'googleMapsUrl is too long' }, { status: 400 });
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') throw new Error();
    } catch {
      return NextResponse.json({ error: 'googleMapsUrl must be a valid https URL' }, { status: 400 });
    }
  }

  const submission = {
    name: name.trim(),
    email: email.trim(),
    businessName: businessName.trim(),
    googleMapsUrl: rawUrl,
    timestamp: new Date().toISOString(),
  };

  console.log('[demo-request] submission received', {
    businessNameLength: submission.businessName.length,
    hasUrl: Boolean(submission.googleMapsUrl),
    ts: submission.timestamp,
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';

    const text = [
      'New demo request — RepWorth',
      '',
      `Name:           ${submission.name}`,
      `Email:          ${submission.email}`,
      `Business:       ${submission.businessName}`,
      `Google Maps:    ${submission.googleMapsUrl || '(not provided)'}`,
      `Submitted at:   ${submission.timestamp}`,
    ].join('\n');

    const { error } = await resend.emails.send({
      from,
      to: NOTIFY_TO,
      subject: 'New Demo Request — RepWorth',
      text,
    });

    if (error) {
      console.error('[demo-request] Resend error:', error.message);
      return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

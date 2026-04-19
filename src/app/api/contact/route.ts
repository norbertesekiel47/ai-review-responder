import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`contact:hour:${ip}`, 10, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Too many submissions. Try again later.' }, { status: 429 });
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

  const { name, email, businessName } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return NextResponse.json({ error: 'businessName is required' }, { status: 400 });
  }

  const submission = {
    name: name.trim(),
    email: email.trim(),
    businessName: businessName.trim(),
    timestamp: new Date().toISOString(),
  };

  console.log('[contact]', submission);

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';

    const text = [
      `New demo request — RepWorth`,
      ``,
      `Name:          ${submission.name}`,
      `Email:         ${submission.email}`,
      `Business:      ${submission.businessName}`,
      `Submitted at:  ${submission.timestamp}`,
    ].join('\n');

    const { error } = await resend.emails.send({
      from,
      to: NOTIFY_TO,
      subject: `New Demo Request — RepWorth`,
      text,
    });

    if (error) {
      console.error('[contact] Resend error:', error.message);
      return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

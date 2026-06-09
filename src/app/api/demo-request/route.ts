import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
import { parseContactCoreFields } from '@/lib/notifications/contact-form';

export const dynamic = 'force-dynamic';

const MAX_NAME_LEN = 200;
const MAX_BUSINESS_NAME_LEN = 300;
const MAX_URL_LEN = 2048;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // No BotID here: this is a dead public-lead remnant (superseded by
  // /api/lead-intake) with no in-app caller, so any surviving caller is external
  // and carries no BotID token. The WAF per-IP net is the right layer. See
  // src/lib/security/botid-routes.ts.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`demo-request:hour:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  const parsed = await parseContactCoreFields(req);
  if (!parsed.ok) return parsed.response;
  const { name, email, businessName } = parsed.fields;

  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: 'name is too long' }, { status: 400 });
  }
  if (businessName.length > MAX_BUSINESS_NAME_LEN) {
    return NextResponse.json({ error: 'businessName is too long' }, { status: 400 });
  }

  const rawUrl = typeof parsed.body.googleMapsUrl === 'string' ? parsed.body.googleMapsUrl.trim() : '';
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

  try {
    await notifyContactSubmission({
      subject: 'New Demo Request — RepWorth',
      lines: [
        'New demo request — RepWorth',
        '',
        `Name:           ${submission.name}`,
        `Email:          ${submission.email}`,
        `Business:       ${submission.businessName}`,
        `Google Maps:    ${submission.googleMapsUrl || '(not provided)'}`,
        `Submitted at:   ${submission.timestamp}`,
      ],
    });
  } catch (err) {
    console.error('[demo-request] notification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

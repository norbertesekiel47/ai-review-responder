import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
import { parseContactCoreFields } from '@/lib/notifications/contact-form';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`contact:hour:${ip}`, 10, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Too many submissions. Try again later.' }, { status: 429 });
  }

  const parsed = await parseContactCoreFields(req);
  if (!parsed.ok) return parsed.response;

  const submission = {
    ...parsed.fields,
    timestamp: new Date().toISOString(),
  };

  console.log('[contact] submission received', {
    businessNameLength: submission.businessName.length,
    ts: submission.timestamp,
  });

  try {
    await notifyContactSubmission({
      subject: 'New Demo Request — RepWorth',
      lines: [
        'New demo request — RepWorth',
        '',
        `Name:          ${submission.name}`,
        `Email:         ${submission.email}`,
        `Business:      ${submission.businessName}`,
        `Submitted at:  ${submission.timestamp}`,
      ],
    });
  } catch (err) {
    console.error('[contact] notification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

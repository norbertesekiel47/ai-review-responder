import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 200;
const MAX_BUSINESS_NAME_LEN = 300;
const MAX_URL_LEN = 2048;
const ALLOWED_INTENTS = new Set(['waitlist', 'demo']);
const ALLOWED_SOURCES = new Set(['landing', 'book-a-demo', 'pricing', 'unknown']);

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function readString(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): { value?: string; response?: NextResponse } {
  const raw = body[key];

  if (typeof raw !== 'string' || !raw.trim()) {
    return { response: jsonError(`${label} is required`, 400) };
  }

  const value = raw.trim();
  if (value.length > maxLength) {
    return { response: jsonError(`${label} is too long`, 400) };
  }

  return { value };
}

function readEnum(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
  allowed: Set<string>,
): { value?: string; response?: NextResponse } {
  const raw = body[key] ?? fallback;

  if (typeof raw !== 'string' || !allowed.has(raw)) {
    return { response: jsonError(`${key} is unsupported`, 400) };
  }

  return { value: raw };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonError('Content-Type must be application/json', 415);
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rateCheck = await checkRateLimit(`lead-intake:hour:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return jsonError('Too many submissions. Try again later.', 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError('Invalid JSON', 400);
  }

  const data = body as Record<string, unknown>;

  const name = readString(data, 'name', 'name', MAX_NAME_LEN);
  if (name.response) return name.response;

  const emailRaw = data.email;
  if (typeof emailRaw !== 'string' || !emailRaw.trim()) {
    return jsonError('A valid email is required', 400);
  }

  const emailNormalized = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(emailNormalized)) {
    return jsonError('A valid email is required', 400);
  }

  const businessName = readString(data, 'businessName', 'businessName', MAX_BUSINESS_NAME_LEN);
  if (businessName.response) return businessName.response;

  const googleMapsRaw = data.googleMapsUrl;
  if (googleMapsRaw !== undefined && typeof googleMapsRaw !== 'string') {
    return jsonError('googleMapsUrl must be a valid https URL', 400);
  }

  const rawUrl = typeof googleMapsRaw === 'string' ? googleMapsRaw.trim() : '';
  if (rawUrl) {
    if (rawUrl.length > MAX_URL_LEN) {
      return jsonError('googleMapsUrl is too long', 400);
    }

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') {
        return jsonError('googleMapsUrl must be a valid https URL', 400);
      }
    } catch {
      return jsonError('googleMapsUrl must be a valid https URL', 400);
    }
  }

  const intent = readEnum(data, 'intent', 'waitlist', ALLOWED_INTENTS);
  if (intent.response) return intent.response;

  const source = readEnum(data, 'source', 'unknown', ALLOWED_SOURCES);
  if (source.response) return source.response;

  const submittedAt = new Date().toISOString();
  const metadata = {
    ip,
    userAgent: req.headers.get('user-agent'),
    referer: req.headers.get('referer'),
    submittedAt,
  };

  try {
    await sql`
      INSERT INTO owner_leads (
        name,
        email,
        email_normalized,
        business_name,
        google_maps_url,
        intent,
        source,
        metadata
      )
      VALUES (
        ${name.value},
        ${emailNormalized},
        ${emailNormalized},
        ${businessName.value},
        ${rawUrl || null},
        ${intent.value},
        ${source.value},
        ${jsonb(metadata)}
      )
      ON CONFLICT (email_normalized, intent) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        business_name = EXCLUDED.business_name,
        google_maps_url = EXCLUDED.google_maps_url,
        source = EXCLUDED.source,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `;
  } catch (error) {
    console.error('[lead-intake] database error:', error);
    return jsonError('Failed to save lead', 500);
  }

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';
    const to = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';
    const text = [
      `Name: ${name.value}`,
      `Email: ${emailNormalized}`,
      `Business: ${businessName.value}`,
      `Intent: ${intent.value}`,
      `Source: ${source.value}`,
      `Google Maps: ${rawUrl || '(not provided)'}`,
      `Submitted at: ${submittedAt}`,
    ].join('\n');

    try {
      const { error } = await resend.emails.send({
        from,
        to,
        subject: `New owner lead - ${intent.value} - RepWorth`,
        text,
      });

      if (!error) {
        return NextResponse.json({ success: true });
      }

      console.error('[lead-intake] Resend error:', error);
      return jsonError('Failed to send notification', 500);
    } catch (error) {
      console.error('[lead-intake] Resend error:', error);
      return jsonError('Failed to send notification', 500);
    }
  }

  return NextResponse.json({ success: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { sql, jsonb } from '@/lib/db/server';
import { appendOwnerLeadToSheet } from '@/lib/google/owner-leads-sheet';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
import { botIdBlockResponse } from '@/lib/security/botid';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { LEAD_INTAKE_HONEYPOT_FIELD } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hidden honeypot field name (shared with the client form via schemas.ts). A
// non-empty value signals an automated submission. Defense-in-depth alongside
// BotID + rate limit.
const HONEYPOT_FIELD = LEAD_INTAKE_HONEYPOT_FIELD;
const MAX_NAME_LEN = 200;
const MAX_BUSINESS_NAME_LEN = 300;
const MAX_URL_LEN = 2048;
const ALLOWED_INTENTS = new Set(['waitlist', 'demo']);
// Optional tier interest from a per-plan door (pricing "Join the Copilot waitlist" /
// "Tell me when Autopilot opens"). Stored in metadata.planInterest, never a column.
const ALLOWED_PLANS = new Set(['copilot', 'autopilot']);
const ALLOWED_SOURCES = new Set([
  'landing',
  'features',
  'how-it-works',
  'book-a-demo',
  'pricing',
  'unknown',
]);

type ReadResult = { ok: true; value: string } | { ok: false; response: NextResponse };

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function readString(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): ReadResult {
  const raw = body[key];

  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, response: jsonError(`${label} is required`, 400) };
  }

  const value = raw.trim();
  if (value.length > maxLength) {
    return { ok: false, response: jsonError(`${label} is too long`, 400) };
  }

  return { ok: true, value };
}

function readEnum(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
  allowed: Set<string>,
): ReadResult {
  const raw = body[key] ?? fallback;

  if (typeof raw !== 'string' || !allowed.has(raw)) {
    return { ok: false, response: jsonError(`${key} is unsupported`, 400) };
  }

  return { ok: true, value: raw };
}

interface ValidatedLead {
  name: string;
  /** Normalized (trimmed + lowercased) email; stored in both email columns. */
  email: string;
  businessName: string;
  /** Trimmed Google Maps URL, or '' when not provided. */
  googleMapsUrl: string;
  intent: string;
  source: string;
  /** 'copilot' | 'autopilot' when the visitor used a per-plan door; otherwise null. */
  planInterest: string | null;
}

type ValidateResult =
  | { ok: true; value: ValidatedLead }
  | { ok: false; response: NextResponse };

// Validate + normalize the lead intake body. All field rules and their exact
// error responses are unchanged from the inline version.
// Cyclomatic count tracks the field count (one check per field), not tangled logic.
// fallow-ignore-next-line complexity
function validateLeadInput(data: Record<string, unknown>): ValidateResult {
  const name = readString(data, 'name', 'name', MAX_NAME_LEN);
  if (!name.ok) return { ok: false, response: name.response };

  const emailRaw = data.email;
  if (typeof emailRaw !== 'string' || !emailRaw.trim()) {
    return { ok: false, response: jsonError('A valid email is required', 400) };
  }
  const emailNormalized = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(emailNormalized)) {
    return { ok: false, response: jsonError('A valid email is required', 400) };
  }

  const businessName = readString(data, 'businessName', 'businessName', MAX_BUSINESS_NAME_LEN);
  if (!businessName.ok) return { ok: false, response: businessName.response };

  const googleMapsRaw = data.googleMapsUrl;
  if (googleMapsRaw !== undefined && typeof googleMapsRaw !== 'string') {
    return { ok: false, response: jsonError('googleMapsUrl must be a valid https URL', 400) };
  }
  const rawUrl = typeof googleMapsRaw === 'string' ? googleMapsRaw.trim() : '';
  if (rawUrl) {
    if (rawUrl.length > MAX_URL_LEN) {
      return { ok: false, response: jsonError('googleMapsUrl is too long', 400) };
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') {
        return { ok: false, response: jsonError('googleMapsUrl must be a valid https URL', 400) };
      }
    } catch {
      return { ok: false, response: jsonError('googleMapsUrl must be a valid https URL', 400) };
    }
  }

  const intent = readEnum(data, 'intent', 'waitlist', ALLOWED_INTENTS);
  if (!intent.ok) return { ok: false, response: intent.response };

  const source = readEnum(data, 'source', 'unknown', ALLOWED_SOURCES);
  if (!source.ok) return { ok: false, response: source.response };

  // Absent → null (most doors are tier-less); present → must be a known tier.
  let planInterest: string | null = null;
  if (data.plan !== undefined) {
    const plan = readEnum(data, 'plan', '', ALLOWED_PLANS);
    if (!plan.ok) return { ok: false, response: plan.response };
    planInterest = plan.value;
  }

  return {
    ok: true,
    value: {
      name: name.value,
      email: emailNormalized,
      businessName: businessName.value,
      googleMapsUrl: rawUrl,
      intent: intent.value,
      source: source.value,
      planInterest,
    },
  };
}

// Request-context metadata stored on the lead row. planInterest is present only when
// the visitor used a per-plan door, so tier-less leads keep the historical shape.
interface LeadMetadata {
  ip: string;
  userAgent: string | null;
  referer: string | null;
  submittedAt: string;
  planInterest?: string;
}

function buildLeadMetadata(
  req: NextRequest,
  ip: string,
  submittedAt: string,
  lead: ValidatedLead,
): LeadMetadata {
  const metadata: LeadMetadata = {
    ip,
    userAgent: req.headers.get('user-agent'),
    referer: req.headers.get('referer'),
    submittedAt,
  };
  if (lead.planInterest) metadata.planInterest = lead.planInterest;
  return metadata;
}

// Best-effort founder notification. notifyContactSubmission skips (no throw)
// when email is unconfigured; a real send failure is surfaced as 500.
async function sendLeadNotification(lead: ValidatedLead, submittedAt: string): Promise<NextResponse> {
  try {
    await notifyContactSubmission({
      subject: `New owner lead - ${lead.intent} - RepWorth`,
      lines: [
        `Name: ${lead.name}`,
        `Email: ${lead.email}`,
        `Business: ${lead.businessName}`,
        `Intent: ${lead.intent}`,
        `Source: ${lead.source}`,
        `Plan interest: ${lead.planInterest ?? '(not stated)'}`,
        `Google Maps: ${lead.googleMapsUrl || '(not provided)'}`,
        `Submitted at: ${submittedAt}`,
      ],
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    reportCaughtError('lead-intake', error, { reason: 'notification_failed' });
    return jsonError('Failed to send notification', 500);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonError('Content-Type must be application/json', 415);
  }

  // Vercel BotID (Basic) — reject bots before the per-IP rate limit + DB insert.
  // Fails open on a BotID infra error.
  const botBlock = await botIdBlockResponse('/api/lead-intake');
  if (botBlock) return botBlock;

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

  // Honeypot: a real user never sees or fills this field. Reject silently with a
  // 200 so bots get no signal that they were caught, before any real processing.
  const honeypot = data[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return NextResponse.json({ success: true });
  }

  const validated = validateLeadInput(data);
  if (!validated.ok) return validated.response;
  const lead = validated.value;

  const submittedAt = new Date().toISOString();
  const metadata = buildLeadMetadata(req, ip, submittedAt, lead);

  let leadId: string | null = null;

  try {
    const savedRows = await sql`
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
        ${lead.name},
        ${lead.email},
        ${lead.email},
        ${lead.businessName},
        ${lead.googleMapsUrl || null},
        ${lead.intent},
        ${lead.source},
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
    const savedLeadId = savedRows[0]?.id;
    leadId = typeof savedLeadId === 'string' ? savedLeadId : null;
  } catch (error) {
    reportCaughtError('lead-intake', error, { reason: 'database_error' });
    return jsonError('Failed to save lead', 500);
  }

  try {
    await appendOwnerLeadToSheet({
      leadId,
      name: lead.name,
      email: lead.email,
      businessName: lead.businessName,
      googleMapsUrl: lead.googleMapsUrl,
      intent: lead.intent,
      source: lead.source,
      ip,
      userAgent: metadata.userAgent,
      referer: metadata.referer,
      submittedAt,
    });
  } catch (error) {
    reportCaughtError('lead-intake', error, { reason: 'sheets_append_error', leadId });
  }

  return sendLeadNotification(lead, submittedAt);
}

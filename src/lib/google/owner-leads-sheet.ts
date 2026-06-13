import { createSign } from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_RANGE = 'Sheet1!A:K';

type GoogleSheetConfig = {
  spreadsheetId: string;
  range: string;
  clientEmail: string;
  privateKey: string;
};

export type OwnerLeadSheetRow = {
  leadId: string | null;
  name: string;
  email: string;
  businessName: string;
  googleMapsUrl: string;
  intent: string;
  source: string;
  ip: string;
  userAgent: string | null;
  referer: string | null;
  submittedAt: string;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, '\n').trim();
}

function readConfig(): GoogleSheetConfig | null {
  const spreadsheetId = process.env.OWNER_LEADS_GOOGLE_SHEET_ID?.trim();

  if (!spreadsheetId) {
    return null;
  }

  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error('Google Sheets lead sync is partially configured');
  }

  return {
    spreadsheetId,
    range: process.env.OWNER_LEADS_GOOGLE_SHEET_RANGE?.trim() || DEFAULT_RANGE,
    clientEmail,
    privateKey: normalizePrivateKey(privateKey),
  };
}

function createServiceAccountJwt(config: GoogleSheetConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const claimSet = {
    iss: config.clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();

  return `${unsigned}.${base64url(signer.sign(config.privateKey))}`;
}

async function fetchAccessToken(config: GoogleSheetConfig): Promise<string> {
  const assertion = createServiceAccountJwt(config);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    // Bound the OAuth token exchange on the user-facing /api/lead-intake path
    // (deep-scan §5.5) — a hung Google connection must not block the response.
    // The caller already try/catches this enrichment, so a TimeoutError is
    // logged-and-swallowed (lead is persisted regardless). v1: timeout is
    // sufficient; moving the append to the worker via an outbox row is the
    // longer-term ADR-0001 option.
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Sheets token request failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Google Sheets token response did not include an access token');
  }

  return data.access_token;
}

function toSheetValues(row: OwnerLeadSheetRow): string[] {
  return [
    row.submittedAt,
    row.leadId ?? '',
    row.name,
    row.email,
    row.businessName,
    row.googleMapsUrl,
    row.intent,
    row.source,
    row.ip,
    row.userAgent ?? '',
    row.referer ?? '',
  ];
}

export async function appendOwnerLeadToSheet(row: OwnerLeadSheetRow): Promise<void> {
  const config = readConfig();
  if (!config) {
    return;
  }

  const accessToken = await fetchAccessToken(config);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}:append`,
  );
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: [toSheetValues(row)],
    }),
    // Bound the Sheets append on the user-facing path (deep-scan §5.5); see the
    // token-exchange fetch above for the failure-tolerance rationale.
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Sheets append failed (${response.status}): ${text}`);
  }
}

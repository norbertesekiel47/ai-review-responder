import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

export const dynamic = 'force-dynamic';

const UpdateSettingsSchema = z
  .object({
    tone: z.string().trim().max(100).optional(),
    productsServices: z.string().max(2000).nullable().optional(),
    avoidFacts: z.array(z.string().trim().max(500)).max(20, 'Maximum 20 avoid facts').optional(),
    sampleResponses: z.array(z.string().trim().max(2000)).max(10, 'Maximum 10 sample responses').optional(),
    ownerPhone: z.string().trim().max(20).nullable().optional(),
    weeklySummaryEnabled: z.boolean().optional(),
    monthlyImpactEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

// Digest toggle fields — written to accounts (account-level setting).
const ACCOUNT_FIELD_TO_COLUMN = {
  weeklySummaryEnabled: 'weekly_summary_enabled',
  monthlyImpactEnabled: 'monthly_impact_enabled',
} as const;

// Voice/contact fields — written to businesses (per-location setting).
const BUSINESS_FIELD_TO_COLUMN = {
  tone: 'tone',
  productsServices: 'products_services',
  avoidFacts: 'avoid_facts',
  sampleResponses: 'sample_responses',
  ownerPhone: 'owner_phone',
} as const;

type AccountField = keyof typeof ACCOUNT_FIELD_TO_COLUMN;
type BusinessField = keyof typeof BUSINESS_FIELD_TO_COLUMN;

// Sentinel so we can throw out of sql.begin and catch the 404 outside.
// "Settings" prefix avoids shadowing the exported BusinessNotFoundError in
// src/lib/dashboard/service.ts.
class SettingsBusinessNotFoundError extends Error {
  constructor() {
    super('Business not found');
    this.name = 'SettingsBusinessNotFoundError';
  }
}

type ColumnValue = string | string[] | boolean | null;

// Runs one dynamic UPDATE for the fields routed to `table`, via the
// Postgres.js dynamic-identifier (tx(table)) and dynamic-column-object
// (tx(updates)) helpers. Returns the matched-row count so each caller owns
// its own not-found semantics.
async function runScopedUpdate<Field extends string>(
  tx: postgres.TransactionSql,
  options: {
    table: 'businesses' | 'accounts';
    idValue: string;
    fieldMap: Record<Field, string>;
    fields: Field[];
    data: Partial<Record<Field, unknown>>;
  },
): Promise<number> {
  const { table, idValue, fieldMap, fields, data } = options;

  const updates: Record<string, ColumnValue> = {};
  for (const field of fields) {
    updates[fieldMap[field]] = (data[field] ?? null) as ColumnValue;
  }

  const result = await tx`
    UPDATE ${tx(table)}
    SET ${tx(updates)}, updated_at = NOW()
    WHERE id = ${idValue}
  `;
  return result.count;
}

async function putSettings(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) {
    return jsonResponse(
      { error: 'No business associated with this account' },
      403,
    );
  }

  if (!user.accountId) {
    return jsonResponse({ error: 'No account associated with this user' }, 403);
  }

  // Captured as consts so the narrowing survives into the sql.begin callback.
  const locationId = user.locationId;
  const accountId = user.accountId;

  const writable = await assertWritableSubscriptionForAccount(accountId);
  if (!writable.ok) {
    return jsonResponse({ error: writable.error }, writable.status);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = UpdateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const data = parsed.data;
  const fields = Object.keys(data) as (AccountField | BusinessField)[];

  // Partition fields by destination table.
  const accountFields = fields.filter((f): f is AccountField => f in ACCOUNT_FIELD_TO_COLUMN);
  const businessFields = fields.filter((f): f is BusinessField => f in BUSINESS_FIELD_TO_COLUMN);

  try {
    await sql.begin(async (tx) => {
      // ── Businesses update (voice/contact fields) ──
      if (businessFields.length > 0) {
        const matched = await runScopedUpdate(tx, {
          table: 'businesses',
          idValue: locationId,
          fieldMap: BUSINESS_FIELD_TO_COLUMN,
          fields: businessFields,
          data,
        });
        if (matched === 0) {
          // Throw sentinel to roll back the whole tx and surface a 404.
          throw new SettingsBusinessNotFoundError();
        }
      }

      // ── Accounts update (digest toggle fields) ──
      if (accountFields.length > 0) {
        // Account is guaranteed by the 403 guard above; no 404 check needed.
        await runScopedUpdate(tx, {
          table: 'accounts',
          idValue: accountId,
          fieldMap: ACCOUNT_FIELD_TO_COLUMN,
          fields: accountFields,
          data,
        });
      }
    });

    return jsonResponse({ success: true });
  } catch (error) {
    if (error instanceof SettingsBusinessNotFoundError) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }
    console.error('[api/settings PUT] Failed:', error);
    return jsonResponse({ error: 'Failed to update settings' }, 500);
  }
}

export const PUT = withSameOrigin()(putSettings);

// POST /api/dashboard/solicitation/batch/reviewed — records that an owner
// opened the spoilage report (#544). Separate from the GET on purpose: the
// client polls the read route every 2s while a batch builds, so only an
// explicit ping from a rendered report can mean "a human looked".
//
// Route orchestrates only: the flag gate, writable-owner auth, location
// resolution, body parse and the 500 mapping all live in `withScopedBatch`
// (../_shared/scoped-batch-route.ts); the idempotent first-write-wins UPDATE
// lives in src/lib/solicitation/batch-view.ts.
//
// This route is WATCH-ONLY. It predates the send lane and shares the shared
// runner with `approve`/`halt` but NOT their gate: `requireContactsWriteAccess`
// reads `SOLICITATION_WATCH_ENABLED` alone. Binding the send-lane gate here
// would 404 the report ping for every watch-mode customer, since
// `SOLICITATION_SEND_ENABLED` is unset in every environment today.

import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { markBatchReviewed } from '@/lib/solicitation/batch-view';
import { requireContactsWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchId, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      // The logger prefix the GET's sibling line already carries; the
      // createWorkerLogger name is historical, not a worker-only scope.
      endpoint: 'api/dashboard/solicitation/batch/reviewed',
      failureMessage: 'Failed to record batch review',
      // Watch flag ONLY — see the header note.
      requireWriteAccess: requireContactsWriteAccess,
      readInput: readBatchId,
    },
    async ({ accountId, locationId, input: batchId, logger }) => {
      // 0 rows means "already reviewed" — an idempotent no-op, not a failure, so
      // the status is 204 either way. The count is LOGGED because that is the only
      // thing separating that legitimate no-op from a silent failure: a caller
      // that omits ?scope= keys the UPDATE on the owner's default location,
      // matches zero rows, and loses the engagement signal with no other
      // symptom. rowsUpdated:0 in this line is that symptom.
      const rowsUpdated = await markBatchReviewed(sql, accountId, locationId, batchId);
      logger.log('batch_reviewed_ping', {
        rowsUpdated,
        businessId: locationId,
      });
      return new NextResponse(null, { status: 204 });
    },
  ),
);

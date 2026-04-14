import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { generateDemo } from '../../src/lib/demos/generator';
import type { DemoJobPayload } from '../../src/lib/demos/types';
import { markOutboxCompleted } from '../../src/lib/shared/outbox';
import { isPlaceId, parseGoogleMapsUrl } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';

export async function handleDemoGeneration(
  job: Job<DemoJobPayload>,
): Promise<void> {
  const { demoId, businessName, category } = job.data;
  let { googlePlaceId } = job.data;
  const googleMapsUrl = (job.data as { googleMapsUrl?: string }).googleMapsUrl;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // Idempotency: only process if still in a startable state
  const [demo] = await sql<{ generation_status: string; started_at: Date | null }[]>`
    SELECT generation_status, started_at FROM prospect_demos WHERE id = ${demoId}
  `;

  if (!demo) {
    console.warn(`[DemoGenerationWorker] Demo ${demoId} not found, completing outbox`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Terminal states — nothing to do
  if (demo.generation_status === 'completed' || demo.generation_status === 'failed') {
    console.warn(
      `[DemoGenerationWorker] Demo ${demoId} already ${demo.generation_status}, completing outbox`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  // Stale "running" recovery — if a previous worker crashed mid-generation,
  // the demo is stuck in "running" with no one processing it.
  // Reset to "queued" so the CAS transition below can reclaim it.
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  if (
    demo.generation_status === 'running' &&
    demo.started_at &&
    Date.now() - new Date(demo.started_at).getTime() > STALE_THRESHOLD_MS
  ) {
    console.warn(
      `[DemoGenerationWorker] Demo ${demoId} stuck in running for >5min, resetting to queued`,
    );
    await sql`
      UPDATE prospect_demos
      SET generation_status = 'queued', started_at = NULL
      WHERE id = ${demoId} AND generation_status = 'running'
    `;
  } else if (demo.generation_status === 'running') {
    // Still running and not stale — might be another active worker, or might
    // be a recently-crashed worker. Throw so BullMQ retries with backoff.
    // On next retry either: (a) original worker finished → we see completed/failed
    // and exit cleanly, or (b) stale threshold reached → we reset and reclaim.
    throw new Error(
      `Demo ${demoId} is running (started ${demo.started_at?.toISOString()}), retrying later`,
    );
  }

  // Race-safe transition: only one worker can move queued → running
  const updated = await sql`
    UPDATE prospect_demos
    SET generation_status = 'running', started_at = NOW()
    WHERE id = ${demoId} AND generation_status = 'queued'
  `;

  if (updated.count === 0) {
    console.warn(`[DemoGenerationWorker] Demo ${demoId} already claimed, completing outbox`);
    await markOutboxCompleted(outboxId);
    return;
  }

  try {
    // Resolve Place ID if it's not canonical (e.g. URL fallback path set 'pending_resolution')
    if (!isPlaceId(googlePlaceId) && googleMapsUrl) {
      const urlData = parseGoogleMapsUrl(googleMapsUrl);
      googlePlaceId = await resolvePlaceId(urlData);
    } else if (!isPlaceId(googlePlaceId)) {
      throw new Error('Invalid Place ID and no URL available for resolution');
    }

    const result = await generateDemo({
      placeId: googlePlaceId,
      businessName,
      category: category ?? null,
    });

    // Success: update both in one transaction
    await sql.begin(async (tx) => {
      await tx`
        UPDATE prospect_demos
        SET reviews_snapshot = ${JSON.stringify(result.reviews)}::jsonb,
            generated_responses = ${JSON.stringify(result.responses)}::jsonb,
            generation_status = 'completed',
            completed_at = NOW()
        WHERE id = ${demoId}
      `;

      await tx`
        UPDATE job_outbox
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${outboxId}
      `;
    });

    console.log(
      `[DemoGenerationWorker] Demo ${demoId} completed: ${result.metadata.successfulResponses}/${result.metadata.totalReviews} responses in ${result.metadata.generationDurationMs}ms`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error(
      `[DemoGenerationWorker] Demo ${demoId} failed: ${message}`,
    );

    // Failure: update both in one transaction
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE prospect_demos
          SET generation_status = 'failed',
              generation_error = ${message},
              completed_at = NOW()
          WHERE id = ${demoId}
        `;

        await tx`
          UPDATE job_outbox
          SET status = 'failed',
              last_error = ${message},
              completed_at = NOW()
          WHERE id = ${outboxId}
        `;
      });
    } catch (txError) {
      // If the failure transaction itself fails, re-throw so BullMQ retries.
      // The idempotency check at the top will catch the retry.
      console.error(
        `[DemoGenerationWorker] Failed to record failure for demo ${demoId}:`,
        txError,
      );
      throw txError;
    }
    // Do NOT re-throw — the failure is fully handled in Postgres.
    // BullMQ job completes cleanly. The outbox entry is already marked failed.
  }
}

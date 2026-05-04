import { sql } from '@/lib/db/server';
import { SetupChecklistClient } from './SetupChecklistClient';

interface ChecklistData {
  zernio_connected: boolean;
  first_approval_done: boolean;
  voice_tuned: boolean;
  notification_prefs_set: boolean;
  no_recent_reviews: boolean;
}

async function getChecklist(businessId: string): Promise<ChecklistData> {
  const [row] = await sql<ChecklistData[]>`
    WITH checklist AS (
      SELECT
        EXISTS (SELECT 1 FROM zernio_connections WHERE business_id = ${businessId}::uuid AND status = 'active') AS zernio_connected,
        EXISTS (SELECT 1 FROM responses WHERE business_id = ${businessId}::uuid AND status IN ('approved','posted')) AS first_approval_done,
        (SELECT
           COALESCE(tone <> 'professional and friendly', false)
           OR COALESCE(products_services <> '', false)
           OR COALESCE(array_length(staff_names, 1) > 0, false)
           OR COALESCE(array_length(highlight_facts, 1) > 0, false)
           OR COALESCE(array_length(avoid_facts, 1) > 0, false)
           OR COALESCE(array_length(sample_responses, 1) > 0, false)
         FROM businesses WHERE id = ${businessId}::uuid) AS voice_tuned,
        EXISTS (SELECT 1 FROM channel_enrollments WHERE business_id = ${businessId}::uuid AND channel <> 'email' AND status = 'verified') AS notification_prefs_set,
        (NOT EXISTS (SELECT 1 FROM reviews WHERE business_id = ${businessId}::uuid AND created_at > NOW() - INTERVAL '24 hours')) AS no_recent_reviews
    )
    SELECT * FROM checklist
  `;
  return row ?? {
    zernio_connected: false,
    first_approval_done: false,
    voice_tuned: false,
    notification_prefs_set: false,
    no_recent_reviews: true,
  };
}

export async function SetupChecklist({ businessId }: { businessId: string }) {
  const checklist = await getChecklist(businessId);

  const items = [
    {
      label: 'Connect Zernio',
      done: checklist.zernio_connected,
      subText: checklist.zernio_connected && checklist.no_recent_reviews
        ? 'Watching, no reviews yet'
        : undefined,
      href: '/dashboard/connect',
    },
    {
      label: 'Approve your first response',
      done: checklist.first_approval_done,
      href: '/dashboard',
    },
    {
      label: 'Tune your voice',
      done: checklist.voice_tuned,
      href: '/settings',
    },
    {
      label: 'Set notification preferences',
      done: checklist.notification_prefs_set,
      href: '/settings/channels',
    },
  ];

  return <SetupChecklistClient items={items} dismissKey={businessId} />;
}

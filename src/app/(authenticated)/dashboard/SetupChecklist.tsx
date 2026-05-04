import { sql } from '@/lib/db/server';

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

  const allComplete = items.every((i) => i.done);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Get fully set up</h2>
      <div className="space-y-3">
        {items.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="flex items-center gap-3 p-3 rounded-md hover:bg-gray-50 transition-colors"
          >
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
              item.done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>
              {item.done ? '✓' : ''}
            </div>
            <div>
              <span className={`text-sm ${item.done ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                {item.label}
              </span>
              {item.subText && (
                <p className="text-xs text-gray-400">{item.subText}</p>
              )}
            </div>
          </a>
        ))}
      </div>
      {allComplete && (
        <p className="text-sm text-green-600 mt-4 text-center">You&apos;re all set!</p>
      )}
    </div>
  );
}

// src/components/admin/ChannelsSection.tsx
//
// SERVER component. Reads CHANNELS_SMS_ENABLED + business.subscription_status
// on the server and conditionally renders the client SmsEnrollmentWidget.
// Pending-payment lock state is rendered inline here (no client JS).

import { sql } from '@/lib/db/server';
import { SmsEnrollmentWidget } from './SmsEnrollmentWidget';

export async function ChannelsSection({ businessId }: { businessId: string }) {
  const rows = await sql<{ owner_email: string; subscription_status: string }[]>`
    SELECT owner_email, subscription_status FROM businesses WHERE id = ${businessId}
  `;
  const biz = rows[0];
  if (!biz) return null;

  const smsEnabled = process.env.CHANNELS_SMS_ENABLED === 'true';
  const subscriptionActive = biz.subscription_status === 'active';

  return (
    <section style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem', marginTop: '1rem' }}>
      <h3 style={{ marginTop: 0 }}>Channels</h3>

      <div style={{ marginBottom: '0.5rem' }}>
        📧 Email: {biz.owner_email} ✅ verified
      </div>

      {smsEnabled && !subscriptionActive && (
        <div style={{ opacity: 0.6 }}>💬 SMS: 🔒 Complete payment first</div>
      )}

      {smsEnabled && subscriptionActive && (
        <SmsEnrollmentWidget businessId={businessId} />
      )}
    </section>
  );
}

'use client';

import { AdminEnrollmentWidget, type AdminEnrollmentPresentation } from './AdminEnrollmentWidget';

function maskPhone(phone: string | null): string {
  if (!phone) return '•••';
  if (phone.length <= 4) return phone;
  const hidden = Math.max(0, phone.length - 7);
  return phone.slice(0, 3) + '•'.repeat(hidden) + phone.slice(-4);
}

const WHATSAPP_PRESENTATION: AdminEnrollmentPresentation = {
  channel: 'whatsapp',
  label: 'WhatsApp',
  containerClass: 'whatsapp-enrollment-widget',
  connectButtonClass: 'px-3 py-1.5 bg-green-600 text-white rounded',
  linkClass: 'text-green-700 underline break-all',
  awaitingScanCopy: 'Scan the QR with WhatsApp or share this link. The owner sends the prefilled message to verify.',
  qrAlt: 'WhatsApp deep link QR',
  verifiedLabel: 'WhatsApp',
  disableConfirm: 'Disable WhatsApp notifications for this business?',
  maskHandle: maskPhone,
};

export function WhatsAppEnrollmentWidget({ businessId }: { businessId: string }) {
  return <AdminEnrollmentWidget presentation={WHATSAPP_PRESENTATION} businessId={businessId} />;
}

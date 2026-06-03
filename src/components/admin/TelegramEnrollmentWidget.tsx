'use client';

import { AdminEnrollmentWidget, type AdminEnrollmentPresentation } from './AdminEnrollmentWidget';

function maskChatId(chatId: string | null): string {
  if (!chatId || chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

const TELEGRAM_PRESENTATION: AdminEnrollmentPresentation = {
  channel: 'telegram',
  label: 'Telegram',
  containerClass: 'telegram-enrollment-widget',
  connectButtonClass: 'px-3 py-1.5 bg-blue-600 text-white rounded',
  linkClass: 'text-blue-600 underline break-all',
  awaitingScanCopy: 'Scan the QR with Telegram or share this link. The owner taps Start to verify.',
  qrAlt: 'Telegram deep link QR',
  verifiedLabel: 'Telegram chat',
  disableConfirm: 'Disable Telegram notifications for this business?',
  maskHandle: maskChatId,
};

export function TelegramEnrollmentWidget({ businessId }: { businessId: string }) {
  return <AdminEnrollmentWidget presentation={TELEGRAM_PRESENTATION} businessId={businessId} />;
}
